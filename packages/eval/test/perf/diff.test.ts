import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  EvalEngine,
  EvalProvenance,
  MetricValue,
  PerfRunRow,
} from "../../src/matrix/types.js";

import * as ev from "../../src/index.js";
import { insertPerfRun } from "../../src/matrix/store.js";
import { perfDiffMain } from "../../src/perf/diff.js";
import { okMetric, unavailableMetric } from "../../src/perf/normalise.js";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";

/**
 * RED pins for #521 perf-run diffing. `../../src/perf/diff.ts` does not
 * exist at the base commit, so every case drives it as a subprocess:
 * `bun <missing>` exits 1 with "Module not found" on stderr and empty
 * stdout. Each test asserts the exact stdout/stderr text BEFORE
 * exitCode — the text is what fails at base; exit 1 alone never
 * discriminates because bun's own module-not-found is also exit 1.
 */

const DIFF_SCRIPT = join(import.meta.dir, "../../src/perf/diff.ts");
const SPAWN_TIMEOUT_MS = 20_000;
const BASE_CAND_HEADER =
  "baseline: base (m, llamacpp)\n" +
  "candidate: cand (m, gufo)\n" +
  "\n" +
  "| Suite | Metric | Baseline | Candidate | Delta | Verdict |\n" +
  "|---|---|---|---|---|---|\n";

let tmp: string;
let dbPath: string;

interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface PerfDiffJsonEntry {
  delta: number | null;
  metric_name: string;
  reason?: string | null;
  verdict: string;
}

interface PerfDiffJson {
  baseline: unknown;
  candidate: unknown;
  diffs: unknown;
}

function run(args: string[], envOverride: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, DIFF_SCRIPT, ...args], {
    env: { ...process.env, DEV_STORAGE: tmp, ...envOverride },
    stderr: "pipe",
    stdout: "pipe",
  });
  const decode = new TextDecoder();
  return {
    exitCode: proc.exitCode,
    stderr: decode.decode(proc.stderr),
    stdout: decode.decode(proc.stdout),
  };
}

function provenance(engine: EvalEngine): EvalProvenance {
  return {
    engine,
    engine_version: null,
    engine_commit: null,
    binary_sha256: null,
    gguf_sha256: null,
    hf_revision: null,
    quant: "Q4_K_M",
    ctx: 65536,
    flags: [],
    host: "test-host",
  };
}

function metricRows(
  runId: string,
  model: string,
  engine: EvalEngine,
  metrics: Record<string, MetricValue>,
): PerfRunRow[] {
  return Object.entries(metrics).map(([metric_name, metric]) => ({
    run_id: runId,
    model_name: model,
    suite_name: "perf",
    metric_name,
    metric,
    provenance: provenance(engine),
    started_at: "2026-11-01T00:00:00Z",
    host_machine: "test-host",
  }));
}

function seed(path: string, rows: PerfRunRow[]): void {
  const db = new Database(path);
  try {
    for (const row of rows) {
      insertPerfRun(db, row);
    }
  } finally {
    db.close();
  }
}

function baseCandRows(): PerfRunRow[] {
  return [
    ...metricRows("base", "m", "llamacpp", {
      decode_tps: okMetric(50),
      ttft_ms: okMetric(200),
      prefill_64k_tps: okMetric(100),
      c4_tps: okMetric(30),
    }),
    ...metricRows("cand", "m", "gufo", {
      decode_tps: okMetric(40),
      ttft_ms: okMetric(150),
      prefill_64k_tps: unavailableMetric("prompt over ctx"),
    }),
  ];
}

function seedBaseCand(): void {
  seed(dbPath, baseCandRows());
}

function corruptBaseProvenance(): void {
  const db = new Database(dbPath);
  try {
    db.run("UPDATE perf_runs SET provenance_json = '{not json' WHERE run_id = 'base'");
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "perf-diff-"));
  dbPath = join(tmp, "perf.sqlite");
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Temporary directory cleanup is best effort on teardown.
  }
});

describe("perf/diff", () => {
  test(
    "regressions exit 3 and the header carries run, model and engine provenance",
    () => {
      // Kills: exit code ignoring regressions; decode_tps direction flipped;
      // engine provenance not surfaced.
      seedBaseCand();
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toStartWith(BASE_CAND_HEADER);
      expect(result.stdout).toContain("| perf | decode_tps | 50.00 | 40.00 | -10.00 | regressed |");
      expect(result.exitCode).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "ttft_ms is lower-is-better: a 200 -> 150 drop is improved, not regressed",
    () => {
      // Kills: treating every metric as higher-is-better.
      seedBaseCand();
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toContain("| perf | ttft_ms | 200.00 | 150.00 | -50.00 | improved |");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "an unavailable candidate metric renders unavailable and n/a, never 0",
    () => {
      // Kills: coercing unavailable to 0.
      seedBaseCand();
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toContain(
        "| perf | prefill_64k_tps | 100.00 | unavailable | n/a | unavailable |",
      );
      expect(result.stdout).not.toMatch(/prefill_64k_tps[^\n]*regressed/);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a metric missing on the candidate side still gets an unavailable row",
    () => {
      // Kills: silently dropping metrics missing on one side.
      seedBaseCand();
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toContain(
        "| perf | c4_tps | 30.00 | unavailable | n/a | unavailable |",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "--format json keeps per-metric verdicts and unavailable reasons",
    () => {
      // Kills: losing the unavailable reason.
      seedBaseCand();
      const result = run([
        "--db",
        dbPath,
        "--base",
        "base",
        "--candidate",
        "cand",
        "--format",
        "json",
      ]);

      expect(result.stdout).toContain('"baseline"');
      expect(result.stdout).toContain('"diffs"');
      const doc = JSON.parse(result.stdout) as PerfDiffJson;
      expect(doc.baseline).toBe("base");
      expect(doc.candidate).toBe("cand");
      expect(Array.isArray(doc.diffs)).toBe(true);
      const diffs = doc.diffs as PerfDiffJsonEntry[];
      const prefill = diffs.find((d) => d.metric_name === "prefill_64k_tps");
      expect(prefill?.verdict).toBe("unavailable");
      expect(prefill?.delta).toBeNull();
      expect(prefill?.reason ?? "").toContain("candidate: prompt over ctx");
      const c4 = diffs.find((d) => d.metric_name === "c4_tps");
      expect(c4?.verdict).toBe("unavailable");
      expect(c4?.reason ?? "").toContain("missing in candidate");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "unavailable verdicts do not count toward the regression exit code",
    () => {
      // Kills: counting unavailable verdicts as failures.
      seed(dbPath, [
        ...metricRows("u1", "m", "llamacpp", {
          decode_tps: okMetric(50),
          prefill_4k_tps: okMetric(10),
        }),
        ...metricRows("u2", "m", "llamacpp", {
          decode_tps: okMetric(50),
          prefill_4k_tps: unavailableMetric("oom"),
        }),
      ]);
      const result = run(["--db", dbPath, "--base", "u1", "--candidate", "u2"]);

      expect(result.stdout).toContain(
        "| perf | prefill_4k_tps | 10.00 | unavailable | n/a | unavailable |",
      );
      expect(result.exitCode).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "--tolerance is a relative band on |baseline|, not an absolute delta",
    () => {
      // Kills: tolerance ignored; tolerance applied as an absolute value.
      seedBaseCand();
      const loose = run([
        "--db",
        dbPath,
        "--base",
        "base",
        "--candidate",
        "cand",
        "--tolerance",
        "0.25",
      ]);
      expect(loose.stdout).toContain("| perf | decode_tps | 50.00 | 40.00 | -10.00 | unchanged |");
      expect(loose.exitCode).toBe(0);

      const tight = run([
        "--db",
        dbPath,
        "--base",
        "base",
        "--candidate",
        "cand",
        "--tolerance",
        "0.1",
      ]);
      expect(tight.stdout).toContain("| perf | decode_tps | 50.00 | 40.00 | -10.00 | regressed |");
      expect(tight.exitCode).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "unknown --base run reports no perf rows and exits 2",
    () => {
      seedBaseCand();
      const result = run(["--db", dbPath, "--base", "nope", "--candidate", "cand"]);

      expect(result.stderr).toBe("perf-diff: no perf rows for run 'nope'\n");
      expect(result.exitCode).toBe(2);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a missing --db file is an error, not an empty database to create",
    () => {
      // Kills: opening (and so creating) a missing db.
      // bun exits 1 at base too — the stderr text is what fails there.
      const missing = join(tmp, "missing.sqlite");
      const result = run(["--db", missing, "--base", "base", "--candidate", "cand"]);

      expect(result.stderr).toBe(`perf-diff: db not found at ${missing}\n`);
      expect(result.exitCode).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "--base and --candidate are required",
    () => {
      // bun exits 1 at base too — the stderr text is what fails there.
      seedBaseCand();
      const result = run(["--db", dbPath, "--base", "base"]);

      expect(result.stderr).toBe("perf-diff: --base and --candidate are required\n");
      expect(result.exitCode).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test("the package barrel re-exports diffPerfRuns", () => {
    // Kills: dropping the index.ts re-export.
    expect(typeof (ev as Record<string, unknown>)["diffPerfRuns"]).toBe("function");
  });

  test(
    "without --db the store defaults to $DEV_STORAGE/eval/perf.sqlite",
    () => {
      // Kills: defaulting --db to packages/eval/results/perf.sqlite, or
      // ignoring llamactlHome/DEV_STORAGE — the same store bench-schedule's
      // defaultOpenDb writes.
      const evalDir = join(tmp, "eval");
      mkdirSync(evalDir);
      seed(join(evalDir, "perf.sqlite"), baseCandRows());
      const result = run(["--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toContain("| perf | decode_tps | 50.00 | 40.00 | -10.00 | regressed |");
      expect(result.exitCode).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "without --db and without the eval store, the resolved default path is reported",
    () => {
      // Kills: a hardcoded default path.
      // bun exits 1 at base too — the stderr text is what fails there.
      const expected = join(tmp, "eval", "perf.sqlite");
      const result = run(["--base", "base", "--candidate", "cand"]);

      expect(result.stderr).toBe(`perf-diff: db not found at ${expected}\n`);
      expect(result.exitCode).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a run holding multiple models requires --model; --model filters rows",
    () => {
      // Kills: removing the guard (rows from two models would merge);
      // not forwarding --model to listPerfRuns.
      seed(dbPath, [
        ...metricRows("mm", "m", "llamacpp", { decode_tps: okMetric(50) }),
        ...metricRows("mm", "other", "llamacpp", { decode_tps: okMetric(60) }),
        ...metricRows("mm2", "m", "llamacpp", { decode_tps: okMetric(50) }),
      ]);
      const guarded = run(["--db", dbPath, "--base", "mm", "--candidate", "mm2"]);
      // bun exits 1 at base too — the stderr text is what fails there.
      expect(guarded.stderr).toBe(
        "perf-diff: run 'mm' holds more than one model; pass --model <name>\n",
      );
      expect(guarded.exitCode).toBe(1);

      const filtered = run(["--db", dbPath, "--base", "mm", "--candidate", "mm2", "--model", "m"]);
      expect(filtered.stdout).toContain("| perf | decode_tps | 50.00 | 50.00 | 0.00 | unchanged |");
      expect(filtered.exitCode).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a candidate run holding multiple models also requires --model",
    () => {
      // Kills: dropping the candidate-side single-model guard.
      seed(dbPath, [
        ...metricRows("one", "m", "llamacpp", { decode_tps: okMetric(50) }),
        ...metricRows("two", "m", "llamacpp", { decode_tps: okMetric(50) }),
        ...metricRows("two", "other", "llamacpp", { decode_tps: okMetric(60) }),
      ]);
      const result = run(["--db", dbPath, "--base", "one", "--candidate", "two"]);

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "perf-diff: run 'two' holds more than one model; pass --model <name>\n",
      );
      expect(result.exitCode).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a metric with no known direction is unavailable, never improved or regressed",
    () => {
      // Kills: defaulting an unknown metric to higher-is-better.
      seed(dbPath, [
        ...metricRows("d1", "m", "llamacpp", { mystery_score: okMetric(10) }),
        ...metricRows("d2", "m", "llamacpp", { mystery_score: okMetric(5) }),
      ]);
      const result = run(["--db", dbPath, "--base", "d1", "--candidate", "d2", "--format", "json"]);

      const doc = JSON.parse(result.stdout) as PerfDiffJson;
      const diffs = doc.diffs as PerfDiffJsonEntry[];
      const mystery = diffs.find((d) => d.metric_name === "mystery_score");
      expect(mystery?.verdict).toBe("unavailable");
      expect(mystery?.delta).toBeNull();
      expect(mystery?.reason ?? "").toContain("no direction");
      expect(result.exitCode).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a metric present only in the candidate run is unavailable as missing in baseline",
    () => {
      // Kills: dropping or misreporting metrics missing on the baseline side.
      seed(dbPath, [
        ...metricRows("b1", "m", "llamacpp", { decode_tps: okMetric(50) }),
        ...metricRows("c1", "m", "llamacpp", {
          decode_tps: okMetric(50),
          c4_tps: okMetric(30),
        }),
      ]);
      const md = run(["--db", dbPath, "--base", "b1", "--candidate", "c1"]);
      expect(md.stdout).toContain("| perf | c4_tps | unavailable | 30.00 | n/a | unavailable |");
      expect(md.exitCode).toBe(0);

      const json = run(["--db", dbPath, "--base", "b1", "--candidate", "c1", "--format", "json"]);
      const diffs = (JSON.parse(json.stdout) as PerfDiffJson).diffs as PerfDiffJsonEntry[];
      const c4 = diffs.find((d) => d.metric_name === "c4_tps");
      expect(c4?.verdict).toBe("unavailable");
      expect(c4?.reason).toBe("baseline: missing in baseline");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "diffing a fresh db reports no rows and creates no schema tables",
    () => {
      // Kills: calling listPerfRuns before perf_runs exists — its
      // ensureMatrixSchema creates the matrix tables on a read-write handle
      // and throws on the read-only one.
      writeFileSync(dbPath, "");
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stderr).toBe("perf-diff: no perf rows for run 'base'\n");
      expect(result.exitCode).toBe(2);
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]);
      } finally {
        db.close();
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a read-only db file is diffed without needing write access",
    () => {
      seedBaseCand();
      chmodSync(dbPath, 0o444);
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toContain("| perf | decode_tps | 50.00 | 40.00 | -10.00 | regressed |");
      expect(result.exitCode).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a db with perf_runs but no matrix tables fails cleanly and is left untouched",
    () => {
      // Kills: an uncaught SQLITE_READONLY from listPerfRuns' ensureMatrixSchema;
      // opening the db read-write, which would create the matrix tables.
      seedBaseCand();
      const seeded = new Database(dbPath);
      try {
        seeded.run("DROP TABLE matrix_runs");
        seeded.run("DROP TABLE matrix_cell_row_details");
      } finally {
        seeded.close();
      }
      const masterRows = (): unknown => {
        const db = new Database(dbPath, { readonly: true });
        try {
          return db
            .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
            .all();
        } finally {
          db.close();
        }
      };
      const masterBefore = masterRows();
      const bytesBefore = readFileSync(dbPath);

      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stderr).toBe(
        `perf-diff: db at ${dbPath} lacks the matrix tables and is opened read-only\n`,
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
      expect(masterRows()).toEqual(masterBefore);
      expect(Buffer.compare(readFileSync(dbPath), bytesBefore)).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a non-read-only store error surfaces instead of reading as no perf rows",
    () => {
      // Kills: readPerfRows swallowing a non-SQLITE_READONLY error from
      // listPerfRuns as an empty row set (misreported as an unknown run, exit 2).
      seedBaseCand();
      corruptBaseProvenance();
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stderr).not.toContain("no perf rows");
      expect(result.stderr).toContain("SyntaxError");
      expect(result.stdout).toBe("");
      expect(result.exitCode).not.toBe(2);
      expect(result.exitCode).not.toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test("perfDiffMain rethrows a non-schema error instead of returning an exit code", () => {
    // Kills: perfDiffMain's catch mapping every non-IncompleteSchemaError to
    // a silent exit 1.
    seedBaseCand();
    corruptBaseProvenance();

    expect(() =>
      perfDiffMain(["--db", dbPath, "--base", "base", "--candidate", "cand"], { DEV_STORAGE: tmp }),
    ).toThrow(SyntaxError);
  });
});

describe("perf/diff flag validation", () => {
  test(
    "rejects a negative --tolerance",
    () => {
      // bun exits 1 at base too — the stderr text is what fails there.
      seedBaseCand();
      const result = run([
        "--db",
        dbPath,
        "--base",
        "base",
        "--candidate",
        "cand",
        "--tolerance",
        "-1",
      ]);

      expect(result.stderr).toBe("perf-diff: --tolerance must be a finite number >= 0\n");
      expect(result.exitCode).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rejects a non-numeric --tolerance",
    () => {
      // bun exits 1 at base too — the stderr text is what fails there.
      seedBaseCand();
      const result = run([
        "--db",
        dbPath,
        "--base",
        "base",
        "--candidate",
        "cand",
        "--tolerance",
        "abc",
      ]);

      expect(result.stderr).toBe("perf-diff: --tolerance must be a finite number >= 0\n");
      expect(result.exitCode).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rejects an unknown --format",
    () => {
      // bun exits 1 at base too — the stderr text is what fails there.
      seedBaseCand();
      const result = run([
        "--db",
        dbPath,
        "--base",
        "base",
        "--candidate",
        "cand",
        "--format",
        "csv",
      ]);

      expect(result.stderr).toBe("perf-diff: --format must be md or json\n");
      expect(result.exitCode).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});
