// RED tests for frozename/llamactl#518: `llamactl qualification evidence`.
// Every case spawns the real CLI against a temp runtime and a temp matrix db;
// the subcommand does not exist on the base, so failures are assertion failures
// on exit code/stdout/stderr, never import or type errors.
import { catalog } from "@llamactl/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { CellRow } from "../../eval/src/matrix/types.js";

import { PromotionThresholdsSchema } from "../../core/src/qualification/promotion.js";
import { ensureMatrixSchema, insertCellRow } from "../../eval/src/matrix/store.js";
import { existsSync, readFileSync, writeFileSync } from "../src/safe-fs.js";
import {
  makeTempRuntime,
  parseJsonRecord,
  requireRecordField,
  runCli,
  type RunResult,
} from "./helpers.js";

const OVERRIDES_FILE_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";

const ABSOLUTE_METRICS = [
  "firstAttemptSuccess",
  "repairSuccess",
  "toolCallCorrectness",
  "structuredOutputValidity",
  "memoryStability",
  "runtimeReliability",
] as const;

interface QualRuntime {
  env: NodeJS.ProcessEnv;
  devStorage: string;
  runtimeDir: string;
  overridesFile: string;
  cleanup: () => void;
}

function makeQualRuntime(): QualRuntime {
  const temp = makeTempRuntime();
  const overridesFile = join(temp.devStorage, "q.tsv");
  const childEnv: NodeJS.ProcessEnv = {
    ...temp.env,
    HOME: temp.devStorage,
    LLAMACTL_CONFIG: join(temp.devStorage, "absent-config"),
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(temp.devStorage, "absent-custom-catalog.tsv"),
    [OVERRIDES_FILE_ENV]: overridesFile,
  };
  return {
    env: childEnv,
    devStorage: temp.devStorage,
    runtimeDir: temp.runtimeDir,
    overridesFile,
    cleanup: temp.cleanup,
  };
}

function qualFixtures(): { exp: string; plain: string } {
  const rows = catalog.listCatalog("builtin");
  const exp = rows.find((row) => row.qualification?.stage === "experimental")?.rel;
  const plain = rows.find((row) => row.qualification === undefined)?.rel;
  expect(exp, "builtin catalog has an experimental rel").toBeDefined();
  expect(plain, "builtin catalog has an unqualified rel").toBeDefined();
  return { exp: exp!, plain: plain! };
}

function thresholds(): Record<string, number> {
  const floors: Record<string, number> = {};
  for (const key of Object.keys(PromotionThresholdsSchema.shape)) {
    if (key === "minEvaluatedTasks") floors[key] = 20;
    else if (key === "maxRegression") floors[key] = 0.05;
    else if (key === "minImprovement") floors[key] = 0;
    else floors[key] = 0.8;
  }
  return floors;
}

function cell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    run_id: "r2",
    runner_version: 1,
    model_name: "m-a",
    workload_name: "w-a",
    model_spec_json: JSON.stringify({ name: "m-a" }),
    n_rows: 20,
    primary_metric_name: "accuracy",
    primary_metric_value: 0.9,
    per_class_metrics_json: JSON.stringify({ a: 0.9 }),
    latency_p50_ms: 50,
    latency_p95_ms: 95,
    throughput_tps: 100,
    errors: 0,
    started_at: "2025-01-01T00:00:00Z",
    finished_at: "2025-01-01T01:00:00Z",
    host_machine: "m4",
    ...overrides,
  };
}

function fixtureRows(): CellRow[] {
  return [
    cell({ run_id: "r2", workload_name: "w-a", primary_metric_value: 0.9, n_rows: 20 }),
    cell({ run_id: "r2", workload_name: "w-b", primary_metric_value: 0.95, n_rows: 20 }),
    cell({ run_id: "r1", workload_name: "w-a", primary_metric_value: 0.85, n_rows: 20 }),
    cell({ run_id: "r1", workload_name: "w-b", primary_metric_value: 0.95, n_rows: 20 }),
  ];
}

type MetricMap = { metrics: Record<string, string[]> };

function fullMap(): MetricMap {
  const metrics: Record<string, string[]> = {};
  for (const metric of ABSOLUTE_METRICS) metrics[metric] = ["w-a", "w-b"];
  return { metrics };
}

function writeJsonFile(dir: string, name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

function createMatrixDb(path: string, rows: readonly CellRow[]): void {
  const db = new Database(path);
  ensureMatrixSchema(db);
  for (const row of rows) insertCellRow(db, row);
  db.close();
}

const LEGACY_MATRIX_DDL = `
  CREATE TABLE matrix_runs (
    run_id TEXT NOT NULL,
    runner_version INTEGER NOT NULL DEFAULT 0,
    model_name TEXT NOT NULL,
    workload_name TEXT NOT NULL,
    model_spec_json TEXT NOT NULL,
    n_rows INTEGER NOT NULL,
    primary_metric_name TEXT NOT NULL,
    primary_metric_value REAL NOT NULL,
    per_class_metrics_json TEXT NOT NULL,
    latency_p50_ms REAL NOT NULL,
    latency_p95_ms REAL NOT NULL,
    throughput_tps REAL NOT NULL,
    errors INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    host_machine TEXT NOT NULL,
    PRIMARY KEY (run_id, model_name, workload_name)
  )
`;

function insertLegacyRow(db: Database, row: CellRow): void {
  db.prepare(`INSERT INTO matrix_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.run_id,
    row.runner_version,
    row.model_name,
    row.workload_name,
    row.model_spec_json,
    row.n_rows,
    row.primary_metric_name,
    row.primary_metric_value,
    row.per_class_metrics_json,
    row.latency_p50_ms,
    row.latency_p95_ms,
    row.throughput_tps,
    row.errors,
    row.started_at,
    row.finished_at,
    row.host_machine,
  );
}

function createLegacyMatrixDb(path: string, rows: readonly CellRow[]): void {
  const db = new Database(path);
  db.run(LEGACY_MATRIX_DDL);
  for (const row of rows) insertLegacyRow(db, row);
  db.close();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectNotUnknown(result: RunResult): void {
  expect(result.stderr).not.toContain("Unknown qualification subcommand");
}

describe("#518 qualification evidence CLI", () => {
  let qual: QualRuntime;
  let dbPath: string;
  let mapPath: string;

  beforeEach(() => {
    qual = makeQualRuntime();
    dbPath = join(qual.devStorage, "matrix.db");
    createMatrixDb(dbPath, fixtureRows());
    mapPath = writeJsonFile(qual.devStorage, "evidence-map.json", fullMap());
  });

  afterEach(() => {
    qual.cleanup();
  });

  function runEvidence(args: string[]): RunResult {
    const result = runCli(["qualification", "evidence", ...args], qual.env);
    expectNotUnknown(result);
    return result;
  }

  function standardArgs(extra: string[] = []): string[] {
    return ["--db", dbPath, "--model", "m-a", "--map", mapPath, "--run-id", "r2", ...extra];
  }

  function writePolicy(): string {
    return writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
      autoApply: false,
    });
  }

  function proposeWithEvidence(evidenceText: string, name: string): RunResult {
    const evidenceFile = join(qual.devStorage, name);
    writeFileSync(evidenceFile, evidenceText);
    const result = runCli(
      [
        "qualification",
        "propose",
        qualFixtures().exp,
        "--evidence",
        evidenceFile,
        "--policy",
        writePolicy(),
        "--json",
      ],
      qual.env,
    );
    expectNotUnknown(result);
    return result;
  }

  // Kills: no subcommand wiring, or not passing the baseline through.
  test("C1: evidence emits the full matrix aggregate as JSON", () => {
    const result = runEvidence(standardArgs(["--baseline-run-id", "r1"]));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = parseJsonRecord(result.stdout);
    expect(Object.keys(parsed).sort()).toEqual(
      ["evaluatedTasks", "evidenceRef", ...ABSOLUTE_METRICS, "regression", "improvement"].sort(),
    );
    expect(parsed["evaluatedTasks"]).toBe(40);
    for (const metric of ABSOLUTE_METRICS) {
      expect(parsed[metric]).toBeCloseTo(0.925, 12);
    }
    expect(parsed["regression"]).toBe(0);
    expect(parsed["improvement"]).toBeCloseTo(0.025, 12);
    expect(parsed["evidenceRef"]).toBe("matrix:m-a@r2;baseline=m-a@r1");
  });

  // Kills: incomplete evidence, or a shape propose refuses.
  test("C2: the evidence JSON round-trips into a candidate proposal", () => {
    const evidence = runEvidence(standardArgs(["--baseline-run-id", "r1"]));
    expect(evidence.code).toBe(0);

    const proposal = proposeWithEvidence(evidence.stdout, "evidence.json");
    expect(proposal.code).toBe(0);
    const parsed = parseJsonRecord(proposal.stdout);
    const decision = requireRecordField(parsed, "decision");
    expect(decision["kind"]).toBe("proposal");
    const proposalBody = requireRecordField(decision, "proposal");
    expect(proposalBody["to"]).toBe("candidate");
    expect(proposalBody["evidenceRef"]).toBe("matrix:m-a@r2;baseline=m-a@r1");
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  // Kills: fabricating regression or improvement.
  test("C2b: evidence without a baseline round-trips to insufficient-evidence", () => {
    const evidence = runEvidence(standardArgs());
    expect(evidence.code).toBe(0);

    const proposal = proposeWithEvidence(evidence.stdout, "evidence-no-baseline.json");
    expect(proposal.code).toBe(0);
    const parsed = parseJsonRecord(proposal.stdout);
    const decision = requireRecordField(parsed, "decision");
    expect(decision).toEqual({ kind: "none", reason: "insufficient-evidence" });
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  // Kills: partial evidence, or extra output.
  test("C3: a missing candidate cell is one exact error line", () => {
    const map = fullMap();
    map.metrics["toolCallCorrectness"] = ["w-a", "w-b", "w-x"];
    writeJsonFile(qual.devStorage, "evidence-map.json", map);

    const result = runEvidence(standardArgs(["--baseline-run-id", "r1"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "qualification evidence: no matrix cell for model m-a workload w-x (metric toolCallCorrectness)\n",
    );
  });

  // Kills: falling back to another baseline run, duplicating a workload per
  // metric, or emitting partial evidence.
  test("C3b: missing baseline cells are exact workload-ordered error lines", () => {
    const result = runEvidence(standardArgs(["--baseline-run-id", "r0"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "qualification evidence: no baseline matrix cell for model m-a run r0 workload w-a\n" +
        "qualification evidence: no baseline matrix cell for model m-a run r0 workload w-b\n",
    );
  });

  // Kills: comparing a run with itself and manufacturing a false promotion.
  test("C3c: baseline cells identical to candidate cells are exact error lines", () => {
    const result = runEvidence(standardArgs(["--baseline-run-id", "r2"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "qualification evidence: baseline run r2 is the candidate cell for model m-a workload w-a\n" +
        "qualification evidence: baseline run r2 is the candidate cell for model m-a workload w-b\n",
    );
  });

  // Kills: accepting incomplete flags or silently defaulting the baseline run.
  test("C4: required flags and the baseline-model/run-id pair are validated", () => {
    const cases = [
      {
        args: ["--model", "m-a", "--map", mapPath],
        want: "qualification evidence: --db is required",
      },
      {
        args: ["--db", dbPath, "--map", mapPath],
        want: "qualification evidence: --model is required",
      },
      {
        args: ["--db", dbPath, "--model", "m-a"],
        want: "qualification evidence: --map is required",
      },
      {
        args: [...standardArgs(), "--baseline-model", "m-base"],
        want: "qualification evidence: --baseline-model needs --baseline-run-id",
      },
    ];

    for (const { args, want } of cases) {
      const result = runEvidence(args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(want);
    }
  });

  // Kills: leaking a stack trace for an unreadable db, or accepting a map that
  // sets the baseline-relative metrics directly.
  test("C5: bad db and map inputs are clean input errors", () => {
    const missingDb = join(qual.devStorage, "missing-matrix.db");
    const missing = runEvidence(["--db", missingDb, "--model", "m-a", "--map", mapPath]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      `qualification evidence: cannot read matrix db '${missingDb}'`,
    );
    expect(missing.stderr).not.toContain("\n    at ");

    const badMap = writeJsonFile(qual.devStorage, "bad-map.json", {
      metrics: { regression: ["w-a"] },
    });
    const invalid = runEvidence(["--db", dbPath, "--model", "m-a", "--map", badMap]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain(`qualification evidence: invalid map file '${badMap}':`);
  });

  // Kills: a writable open, or an overrides write.
  test("C6: evidence is read-only and help documents the subcommand", () => {
    const before = sha256File(dbPath);
    const result = runEvidence(standardArgs(["--baseline-run-id", "r1"]));
    expect(result.code).toBe(0);
    expect(sha256File(dbPath)).toBe(before);
    expect(existsSync(qual.overridesFile)).toBe(false);

    const help = runCli(["qualification", "help"], qual.env);
    expectNotUnknown(help);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("evidence --db <matrix.db> --model <name> --map <file.json>");
    expect(help.stdout).toContain("--baseline-run-id <id>");
  });

  // Kills: listCellRows/ensureMatrixSchema on the readonly handle.
  test("C7: a legacy matrix_runs-only db stays byte-identical and schema-only", () => {
    const legacyPath = join(qual.devStorage, "legacy-matrix.db");
    createLegacyMatrixDb(legacyPath, fixtureRows());
    const before = sha256File(legacyPath);

    const result = runEvidence([
      "--db",
      legacyPath,
      "--model",
      "m-a",
      "--map",
      mapPath,
      "--run-id",
      "r2",
      "--baseline-run-id",
      "r1",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = parseJsonRecord(result.stdout);
    expect(parsed["evaluatedTasks"]).toBe(40);
    expect(parsed["evidenceRef"]).toBe("matrix:m-a@r2;baseline=m-a@r1");
    expect(parsed["improvement"]).toBeCloseTo(0.025, 12);

    const check = new Database(legacyPath, { readonly: true });
    try {
      const tables = check
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map((table) => table.name)).toEqual(["matrix_runs"]);
    } finally {
      check.close();
    }
    expect(sha256File(legacyPath)).toBe(before);
  });

  // Kills: a map schema that requires every metric key.
  test("C8: a partial map with one metric emits only that metric", () => {
    writeJsonFile(qual.devStorage, "evidence-map.json", {
      metrics: { firstAttemptSuccess: ["w-a", "w-b"] },
    });

    const result = runEvidence(standardArgs(["--baseline-run-id", "r1"]));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = parseJsonRecord(result.stdout);
    expect(Object.keys(parsed).sort()).toEqual(
      ["evaluatedTasks", "evidenceRef", "firstAttemptSuccess", "regression", "improvement"].sort(),
    );
    expect(parsed["evaluatedTasks"]).toBe(40);
    expect(parsed["firstAttemptSuccess"]).toBeCloseTo(0.925, 12);
    expect(parsed["regression"]).toBe(0);
    expect(parsed["improvement"]).toBeCloseTo(0.025, 12);
    expect(parsed["evidenceRef"]).toBe("matrix:m-a@r2;baseline=m-a@r1");
  });

  // Kills: reporting out-of-range evidence as an unreadable db.
  test("C9: out-of-range evidence is its own refusal, not a db error", () => {
    const pctPath = join(qual.devStorage, "pct-matrix.db");
    createMatrixDb(pctPath, [
      cell({ run_id: "r2", workload_name: "w-a", primary_metric_value: 90, n_rows: 20 }),
      cell({ run_id: "r2", workload_name: "w-b", primary_metric_value: 95, n_rows: 20 }),
    ]);

    const result = runEvidence(["--db", pctPath, "--model", "m-a", "--map", mapPath]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith(
      "qualification evidence: invalid evidence from matrix cells: firstAttemptSuccess:",
    );
    expect(result.stderr).not.toContain("cannot read matrix db");
    expect(result.stderr).not.toContain("\n    at ");
  });
});
