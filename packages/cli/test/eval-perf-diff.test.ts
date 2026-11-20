import {
  defaultPerfDbPath,
  type EvalProvenance,
  insertPerfRun,
  type MetricValue,
  type PerfRunRow,
} from "@llamactl/eval";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runEval } from "../src/commands/eval.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

const savedDevStorage = process.env["DEV_STORAGE"];

let tmpDir = "";

function provenance(): EvalProvenance {
  return {
    engine: "llamacpp",
    engine_version: null,
    engine_commit: null,
    binary_sha256: null,
    gguf_sha256: null,
    hf_revision: null,
    quant: "Q4_K_M",
    ctx: 65536,
    flags: [],
    host: "h",
  };
}

function perfRow(runId: string, metric: MetricValue): PerfRunRow {
  return {
    run_id: runId,
    model_name: "m",
    suite_name: "perf-quick",
    metric_name: "decode_tps",
    metric,
    provenance: provenance(),
    started_at: "2026-11-01T00:00:00Z",
    host_machine: "h",
  };
}

function seedPerfDb(dbPath: string, rows: PerfRunRow[]): void {
  const db = new Database(dbPath);
  try {
    for (const row of rows) {
      insertPerfRun(db, row);
    }
  } finally {
    db.close();
  }
}

function seedDecodePair(dbPath: string, base: MetricValue, cand: MetricValue): void {
  seedPerfDb(dbPath, [perfRow("base", base), perfRow("cand", cand)]);
}

describe("#521 llamactl eval perf-diff", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "llamactl-eval-perf-diff-"));
    process.env["DEV_STORAGE"] = tmpDir;
  });

  afterEach(() => {
    if (savedDevStorage === undefined) delete process.env["DEV_STORAGE"];
    else process.env["DEV_STORAGE"] = savedDevStorage;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Kills: removing the `case "perf-diff"` dispatch, or a wrapper that
  // collapses perfDiffMain's non-zero exit codes to 1.
  test("regression exits 3 with the header and the regressed row", async () => {
    const dbPath = join(tmpDir, "perf.sqlite");
    seedDecodePair(dbPath, { value: 10, status: "ok" }, { value: 5, status: "ok" });

    const { result, stdout, stderr } = await captureProcessStreams(() =>
      runEval(["perf-diff", "--base", "base", "--candidate", "cand", "--db", dbPath]),
    );

    expect(result).toBe(3);
    expect(stdout).toStartWith("baseline: base (m, llamacpp)\ncandidate: cand (m, llamacpp)\n");
    expect(stdout).toContain("| perf-quick | decode_tps | 10.00 | 5.00 | -5.00 | regressed |");
    expect(stderr).toBe("");
  });

  // Kills: coercing an unavailable metric to 0, or giving it a regressed
  // verdict.
  test("unavailable candidate metric renders unavailable, never 0, and exits 0", async () => {
    const dbPath = join(tmpDir, "perf.sqlite");
    seedDecodePair(
      dbPath,
      { value: 10, status: "ok" },
      { value: null, status: "unavailable", reason: "engine HTTP 503" },
    );

    const { result, stdout } = await captureProcessStreams(() =>
      runEval(["perf-diff", "--base", "base", "--candidate", "cand", "--db", dbPath]),
    );

    expect(result).toBe(0);
    expect(stdout).toContain(
      "| perf-quick | decode_tps | 10.00 | unavailable | n/a | unavailable |",
    );
    expect(stdout).not.toMatch(/\| 0\.00 \|/);
  });

  // Kills: a wrapper that drops the forwarded --format flag, or that calls
  // perfDiffMain([]) and loses the subcommand arguments.
  test("--format json prints baseline, candidate and the regressed verdict", async () => {
    const dbPath = join(tmpDir, "perf.sqlite");
    seedDecodePair(dbPath, { value: 10, status: "ok" }, { value: 5, status: "ok" });

    const { result, stdout } = await captureProcessStreams(() =>
      runEval([
        "perf-diff",
        "--base",
        "base",
        "--candidate",
        "cand",
        "--db",
        dbPath,
        "--format",
        "json",
      ]),
    );

    expect(result).toBe(3);
    const doc = JSON.parse(stdout) as {
      baseline: unknown;
      candidate: unknown;
      diffs: { verdict: string }[];
    };
    expect(doc.baseline).toBe("base");
    expect(doc.candidate).toBe("cand");
    expect(doc.diffs[0]?.verdict).toBe("regressed");
  });

  // Kills: a wrapper that opens or creates the db itself — e.g. a
  // read-write `new Database(path)` or a default-path helper that mkdirs.
  test("missing --db exits 1 with the perf-diff message and creates nothing", async () => {
    const missing = join(tmpDir, "absent", "perf.sqlite");

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(["perf-diff", "--base", "base", "--candidate", "cand", "--db", missing]),
    );

    expect(result).toBe(1);
    expect(stderr).toBe(`perf-diff: db not found at ${missing}\n`);
    expect(existsSync(missing)).toBe(false);
  });

  // Kills: a wrapper that passes {} instead of process.env to perfDiffMain,
  // which would resolve the default db against the real home.
  test("without --db the default perf.sqlite under DEV_STORAGE/eval is used", async () => {
    const dbPath = defaultPerfDbPath(process.env);
    mkdirSync(dirname(dbPath), { recursive: true });
    seedDecodePair(dbPath, { value: 10, status: "ok" }, { value: 5, status: "ok" });

    const { result, stdout } = await captureProcessStreams(() =>
      runEval(["perf-diff", "--base", "base", "--candidate", "cand"]),
    );

    expect(result).toBe(3);
    expect(stdout).toContain("| perf-quick | decode_tps | 10.00 | 5.00 | -5.00 | regressed |");
  });

  // Kills: removing the help intercept, which lets --help fall through to
  // perfDiffMain's usage error.
  // Kills: dropping either help flag (`--help` or `-h`) from the perf-diff
  // help check, which falls through to the --base/--candidate refusal.
  for (const flag of ["--help", "-h"]) {
    test(`perf-diff ${flag} prints the subcommand usage`, async () => {
      const { result, stdout, stderr } = await captureProcessStreams(() =>
        runEval(["perf-diff", flag]),
      );

      expect(result).toBe(0);
      expect(stdout).toContain(
        "Usage: llamactl eval perf-diff --base <run_id> --candidate <run_id> [--db <path>] [--model <name>] [--format md|json] [--tolerance <fraction>]",
      );
      expect(stderr).not.toContain("--base and --candidate are required");
    });
  }

  // Kills: matching the bare word `help` anywhere in argv as a help request
  // (`argv.includes("help")`), which prints usage and exits 0 instead.
  test("a flag value equal to help is not a help request", async () => {
    const missing = join(tmpDir, "absent", "perf.sqlite");

    const { result, stdout, stderr } = await captureProcessStreams(() =>
      runEval(["perf-diff", "--base", "help", "--candidate", "cand", "--db", missing]),
    );

    expect(result).toBe(1);
    expect(stderr).toBe(`perf-diff: db not found at ${missing}\n`);
    expect(stdout).not.toContain("Usage: llamactl eval perf-diff");
  });

  // Kills: the USAGE line for the new subcommand being missing.
  test("eval --help lists the perf-diff subcommand", async () => {
    const { result, stdout } = await captureProcessStreams(() => runEval(["--help"]));

    expect(result).toBe(0);
    expect(stdout).toContain("  perf-diff --base <run_id> --candidate <run_id> [--db <path>]");
  });
});
