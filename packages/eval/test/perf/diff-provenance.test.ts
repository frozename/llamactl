import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvalProvenance } from "../../src/matrix/types.js";

import * as ev from "../../src/index.js";
import { insertPerfRun } from "../../src/matrix/store.js";
import { okMetric } from "../../src/perf/normalise.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

/**
 * RED pins for the #521 perf-diff provenance slice: `diffPerfProvenance`,
 * `PERF_PROVENANCE_DIFF_FIELDS` and the provenance block in the md/json
 * renderers do not exist at the base commit. Every case drives the script
 * as a subprocess and asserts the exact stdout text BEFORE exitCode — the
 * text is what fails at base.
 */

const DIFF_SCRIPT = join(import.meta.dir, "../../src/perf/diff.ts");
const SPAWN_TIMEOUT_MS = 20_000;

const A64 = "a".repeat(64);
const B64 = "b".repeat(64);
const C64 = "c".repeat(64);
const HFR = "gguf path is not under an HF snapshots/<rev>/ directory";

const FIELDS = [
  "engine",
  "engine_version",
  "engine_commit",
  "binary_sha256",
  "gguf_sha256",
  "hf_revision",
  "quant",
  "ctx",
  "flags",
  "host",
];

const PROVENANCE_HEADER = "| Provenance | Baseline | Candidate | Verdict |";
const PROVENANCE_SEPARATOR = "|---|---|---|---|";

let tmp: string;
let dbPath: string;

interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface ProvDiffJsonEntry {
  baseline: unknown;
  candidate: unknown;
  field: string;
  reason: string | null;
  verdict: string;
}

interface PerfDiffJsonDoc {
  baseline: unknown;
  candidate: unknown;
  diffs: unknown;
  provenance?: ProvDiffJsonEntry[];
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

function pBase(): EvalProvenance {
  return {
    engine: "llamacpp",
    engine_version: "b6000",
    engine_commit: null,
    binary_sha256: A64,
    gguf_sha256: C64,
    hf_revision: null,
    quant: "Q4_K_M",
    ctx: 65536,
    flags: [],
    host: "h1",
    unavailable: { hf_revision: HFR },
  };
}

function pCand(): EvalProvenance {
  return {
    engine: "gufo",
    engine_version: "b6000",
    engine_commit: null,
    binary_sha256: B64,
    gguf_sha256: null,
    hf_revision: null,
    quant: "Q4_K_M",
    ctx: 32768,
    flags: ["-ngl", "99"],
    host: "h1",
    unavailable: { gguf_sha256: "no --gguf given", hf_revision: HFR },
  };
}

function pFull(overrides: Partial<EvalProvenance> = {}): EvalProvenance {
  return {
    engine: "llamacpp",
    engine_version: "b6000",
    engine_commit: "abc1234",
    binary_sha256: A64,
    gguf_sha256: C64,
    hf_revision: "rev1",
    quant: "Q4_K_M",
    ctx: 65536,
    flags: ["-ngl", "99"],
    host: "h1",
    ...overrides,
  };
}

function seedPair(
  db: string,
  baseProv: EvalProvenance,
  candProv: EvalProvenance,
  baseValue = 50,
  candValue = 50,
): void {
  const database = new Database(db);
  try {
    const sides: [string, EvalProvenance, number][] = [
      ["base", baseProv, baseValue],
      ["cand", candProv, candValue],
    ];
    for (const [runId, prov, value] of sides) {
      insertPerfRun(database, {
        run_id: runId,
        model_name: "m",
        suite_name: "perf",
        metric_name: "decode_tps",
        metric: okMetric(value),
        provenance: prov,
        started_at: "2026-11-01T00:00:00Z",
        host_machine: "h1",
      });
    }
  } finally {
    database.close();
  }
}

function provenanceRows(stdout: string): string[] {
  const lines = stdout.split("\n");
  const header = lines.indexOf(PROVENANCE_HEADER);
  if (header === -1) return [];
  const sep = lines.indexOf(PROVENANCE_SEPARATOR, header + 1);
  if (sep === -1) return [];
  const rows: string[] = [];
  for (let i = sep + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.startsWith("|")) break;
    rows.push(line);
  }
  return rows;
}

function provenanceFieldOrder(stdout: string): string[] {
  return provenanceRows(stdout).map((row) => row.split("|")[1]?.trim() ?? "");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "perf-diff-provenance-"));
  dbPath = join(tmp, "perf.sqlite");
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Temporary directory cleanup is best effort on teardown.
  }
});

describe("perf/diff provenance", () => {
  test(
    "md output appends the provenance table after the metric rows",
    () => {
      // Kills: no table; table before the metrics; a dropped field.
      seedPair(dbPath, pBase(), pCand());
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toStartWith(
        "baseline: base (m, llamacpp)\ncandidate: cand (m, gufo)\n",
      );
      const metricIdx = result.stdout.indexOf(
        "| perf | decode_tps | 50.00 | 50.00 | 0.00 | unchanged |",
      );
      const provIdx = result.stdout.indexOf(
        "\n\n| Provenance | Baseline | Candidate | Verdict |\n|---|---|---|---|\n",
      );
      expect(metricIdx).toBeGreaterThanOrEqual(0);
      expect(provIdx).toBeGreaterThan(metricIdx);
      const rows = [
        "| engine | llamacpp | gufo | differs |",
        "| engine_version | b6000 | b6000 | same |",
        "| engine_commit | unavailable | unavailable | unavailable |",
        `| binary_sha256 | ${A64} | ${B64} | differs |`,
        `| gguf_sha256 | ${C64} | unavailable | unavailable |`,
        "| hf_revision | unavailable | unavailable | unavailable |",
        "| quant | Q4_K_M | Q4_K_M | same |",
        "| ctx | 65536 | 32768 | differs |",
        "| flags | (none) | -ngl 99 | differs |",
        "| host | h1 | h1 | same |",
      ];
      for (const row of rows) {
        expect(result.stdout).toContain(row);
      }
      expect(result.stdout.endsWith("| host | h1 | h1 | same |\n")).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "provenance rows appear in PERF_PROVENANCE_DIFF_FIELDS order",
    () => {
      // Kills: reordering, or dropping host or flags.
      seedPair(dbPath, pBase(), pCand());
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(provenanceFieldOrder(result.stdout)).toEqual(FIELDS);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "provenance verdicts never change the exit code",
    () => {
      // Kills: `differs` counted as a regression; provenance masking a regression.
      seedPair(dbPath, pBase(), pCand());
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);
      expect(result.stdout).toContain(`| binary_sha256 | ${A64} | ${B64} | differs |`);
      expect(result.exitCode).toBe(0);

      const db2 = join(tmp, "perf-2.sqlite");
      seedPair(db2, pFull(), pFull(), 50, 40);
      const regressed = run(["--db", db2, "--base", "base", "--candidate", "cand"]);
      expect(regressed.stdout).toContain(
        "| perf | decode_tps | 50.00 | 40.00 | -10.00 | regressed |",
      );
      const rows = provenanceRows(regressed.stdout);
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.endsWith("| same |")).toBe(true);
      }
      expect(regressed.exitCode).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "an unavailable provenance side is never a differs verdict",
    () => {
      // Kills: null compared against a value as differs.
      seedPair(dbPath, pBase(), pCand());
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toContain(`| gguf_sha256 | ${C64} | unavailable | unavailable |`);
      expect(result.stdout).not.toMatch(/\| gguf_sha256 \|[^\n]*differs/);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "flags compare by value, not by array identity",
    () => {
      // Kills: reference equality on arrays.
      const shared = ["-ngl", "99"];
      seedPair(dbPath, pFull({ flags: shared }), pFull({ flags: shared }));
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toContain("| flags | -ngl 99 | -ngl 99 | same |");
      for (const row of provenanceRows(result.stdout)) {
        expect(row.endsWith("| differs |")).toBe(false);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "provenance cells escape markdown pipes",
    () => {
      // Kills: provenance cells skipping mdField.
      seedPair(dbPath, pFull({ flags: ["--grammar=a|b"] }), pFull({ flags: ["--grammar=a|b"] }));
      const result = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);

      expect(result.stdout).toContain("| flags | --grammar=a\\|b | --grammar=a\\|b | same |");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "--format json emits provenance entries mirroring compareMetric reasons",
    () => {
      // Kills: a lost reason; null coerced to a string or 0; a reason format
      // that does not mirror compareMetric.
      seedPair(dbPath, pBase(), pCand());
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

      const doc = JSON.parse(result.stdout) as PerfDiffJsonDoc;
      expect(doc.baseline).toBe("base");
      expect(Array.isArray(doc.diffs)).toBe(true);
      const prov = doc.provenance;
      expect(prov).toHaveLength(10);
      expect(prov?.map((p) => p.field)).toEqual(FIELDS);
      const byField = new Map((prov ?? []).map((p) => [p.field, p]));
      expect(byField.get("engine")).toEqual({
        field: "engine",
        baseline: "llamacpp",
        candidate: "gufo",
        verdict: "differs",
        reason: null,
      });
      expect(byField.get("gguf_sha256")).toEqual({
        field: "gguf_sha256",
        baseline: C64,
        candidate: null,
        verdict: "unavailable",
        reason: "candidate: no --gguf given",
      });
      expect(byField.get("engine_commit")?.reason).toBe(
        "baseline: not recorded; candidate: not recorded",
      );
      expect(byField.get("hf_revision")?.reason).toBe(`baseline: ${HFR}; candidate: ${HFR}`);
      expect(byField.get("flags")?.baseline).toEqual([]);
      expect(byField.get("flags")?.candidate).toEqual(["-ngl", "99"]);
      expect(byField.get("ctx")?.baseline).toBe(65536);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a provenance row missing the flags key reads as not recorded",
    () => {
      // Kills: an `=== null` check that misses a missing key.
      seedPair(dbPath, pFull({ flags: [] }), pFull({ flags: [] }));
      const db = new Database(dbPath);
      try {
        db.run(
          "UPDATE perf_runs SET provenance_json = json_remove(provenance_json,'$.flags') WHERE run_id='base'",
        );
      } finally {
        db.close();
      }

      const md = run(["--db", dbPath, "--base", "base", "--candidate", "cand"]);
      expect(md.stdout).toContain("| flags | unavailable | (none) | unavailable |");
      expect(md.stdout).not.toContain("undefined");

      const json = run([
        "--db",
        dbPath,
        "--base",
        "base",
        "--candidate",
        "cand",
        "--format",
        "json",
      ]);
      const doc = JSON.parse(json.stdout) as PerfDiffJsonDoc;
      const flags = (doc.provenance ?? []).find((p) => p.field === "flags");
      expect(flags?.reason).toBe("baseline: not recorded");
    },
    SPAWN_TIMEOUT_MS,
  );

  test("the package barrel exports the provenance diff", () => {
    // Kills: a missing export; a provenance field dropped from the diff.
    const ns = ev as Record<string, unknown>;
    expect(typeof ns["diffPerfProvenance"]).toBe("function");
    expect(ns["PERF_PROVENANCE_DIFF_FIELDS"]).toEqual(FIELDS);
    const list = ns["PERF_PROVENANCE_DIFF_FIELDS"] as readonly unknown[];
    expect(Array.isArray(list)).toBe(true);
    for (const name of ev.PROVENANCE_UNAVAILABLE_FIELDS) {
      expect(list).toContain(name);
    }
  });
});
