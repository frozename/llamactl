// RED tests for frozename/llamactl#518: promotion evidence derived from
// eval matrix cells. The adapter module does not exist on the base, so the
// dynamic loader returns undefined and every case fails on its export
// assertion rather than on module resolution.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type {
  PromotionEvidence,
  PromotionMetric,
  PromotionThresholds,
} from "../../core/src/qualification/promotion.js";
import type { CellRow } from "../src/matrix/types.js";

import {
  parsePromotionEvidence,
  proposePromotion,
} from "../../core/src/qualification/promotion.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

type AbsoluteMetric = Exclude<PromotionMetric, "regression" | "improvement">;

interface QualificationEvidenceMapping {
  metrics: Partial<Record<AbsoluteMetric, string[]>>;
}

type MissingCell =
  | { side: "candidate"; metric: AbsoluteMetric; workload: string }
  | { side: "baseline"; workload: string };

type QualificationEvidenceResult =
  | { ok: true; evidence: PromotionEvidence }
  | { ok: false; reason: "missing-cells"; missing: MissingCell[] }
  | { ok: false; reason: "baseline-is-candidate"; workloads: string[] };

interface EvidenceOptions {
  model: string;
  mapping: QualificationEvidenceMapping;
  runId?: string;
  baseline?: { model: string; runId: string };
}

interface QualificationEvidenceModule {
  qualificationEvidenceFromCells: (
    cells: readonly CellRow[],
    opts: EvidenceOptions,
  ) => QualificationEvidenceResult;
  parseQualificationEvidenceMapping: (input: unknown) => QualificationEvidenceMapping;
  readMatrixCellRows: (db: Database) => CellRow[];
}

async function load(): Promise<Partial<QualificationEvidenceModule> | undefined> {
  const spec = "../src/qualification/evidence.js";
  try {
    return (await import(spec)) as Partial<QualificationEvidenceModule>;
  } catch {
    return undefined;
  }
}

async function loadFromCells(): Promise<
  QualificationEvidenceModule["qualificationEvidenceFromCells"]
> {
  const mod = await load();
  expect(typeof mod?.qualificationEvidenceFromCells).toBe("function");
  return mod!.qualificationEvidenceFromCells!;
}

async function loadParseMapping(): Promise<
  QualificationEvidenceModule["parseQualificationEvidenceMapping"]
> {
  const mod = await load();
  expect(typeof mod?.parseQualificationEvidenceMapping).toBe("function");
  return mod!.parseQualificationEvidenceMapping!;
}

async function loadReadRows(): Promise<QualificationEvidenceModule["readMatrixCellRows"]> {
  const mod = await load();
  expect(typeof mod?.readMatrixCellRows).toBe("function");
  return mod!.readMatrixCellRows!;
}

function cell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    run_id: "r1",
    runner_version: 1,
    model_name: "m-a",
    workload_name: "w-a",
    model_spec_json: JSON.stringify({ name: "m-a" }),
    n_rows: 10,
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

function expectEvidence(result: QualificationEvidenceResult): PromotionEvidence {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected evidence, got ${result.reason}`);
  return result.evidence;
}

function fullCandidateThresholds(): PromotionThresholds {
  return {
    minEvaluatedTasks: 1,
    minFirstAttemptSuccess: 0,
    minRepairSuccess: 0,
    minToolCallCorrectness: 0,
    minStructuredOutputValidity: 0,
    maxRegression: 1,
    minImprovement: -1,
    minMemoryStability: 0,
    minRuntimeReliability: 0,
  };
}

describe("#518 qualification evidence from matrix cells", () => {
  // Kills: an unweighted mean (0.65).
  test("E1: metric values are the n_rows-weighted mean", async () => {
    const fromCells = await loadFromCells();
    const result = fromCells(
      [
        cell({ workload_name: "w-a", primary_metric_value: 0.8, n_rows: 10 }),
        cell({ workload_name: "w-b", primary_metric_value: 0.5, n_rows: 30 }),
      ],
      {
        model: "m-a",
        mapping: { metrics: { firstAttemptSuccess: ["w-a", "w-b"] } },
      },
    );

    const evidence = expectEvidence(result);
    expect(evidence.firstAttemptSuccess).toBeCloseTo(0.575, 12);
  });

  // Kills: summing n_rows per mapping (50).
  test("E2: evaluatedTasks counts each selected cell once", async () => {
    const fromCells = await loadFromCells();
    const result = fromCells(
      [cell({ workload_name: "w-a", n_rows: 10 }), cell({ workload_name: "w-b", n_rows: 30 })],
      {
        model: "m-a",
        mapping: {
          metrics: {
            firstAttemptSuccess: ["w-a"],
            toolCallCorrectness: ["w-a", "w-b"],
          },
        },
      },
    );

    const evidence = expectEvidence(result);
    expect(evidence.evaluatedTasks).toBe(40);
  });

  // Kills: taking the first-listed cell, or not filtering by model.
  test("E3: the latest cell wins per workload, with run_id breaking ties", async () => {
    const fromCells = await loadFromCells();
    const result = fromCells(
      [
        cell({
          run_id: "r9",
          workload_name: "w-a",
          primary_metric_value: 0.1,
          finished_at: "2025-01-02T01:00:00Z",
        }),
        cell({
          run_id: "r1",
          workload_name: "w-a",
          primary_metric_value: 0.8,
          finished_at: "2025-01-03T01:00:00Z",
        }),
        cell({
          run_id: "r2",
          workload_name: "w-a",
          primary_metric_value: 0.6,
          finished_at: "2025-01-03T01:00:00Z",
        }),
        cell({
          run_id: "r9",
          model_name: "m-other",
          workload_name: "w-a",
          primary_metric_value: 0.01,
          finished_at: "2025-01-04T01:00:00Z",
        }),
      ],
      {
        model: "m-a",
        mapping: { metrics: { firstAttemptSuccess: ["w-a"] } },
      },
    );

    const evidence = expectEvidence(result);
    expect(evidence.firstAttemptSuccess).toBeCloseTo(0.6, 12);
  });

  // Kills: ignoring runId.
  test("E4: the runId option restricts candidate cell selection", async () => {
    const fromCells = await loadFromCells();
    const result = fromCells(
      [
        cell({
          run_id: "r1",
          workload_name: "w-a",
          primary_metric_value: 0.4,
          finished_at: "2025-01-01T01:00:00Z",
        }),
        cell({
          run_id: "r2",
          workload_name: "w-a",
          primary_metric_value: 0.9,
          finished_at: "2025-01-02T01:00:00Z",
        }),
      ],
      {
        model: "m-a",
        runId: "r1",
        mapping: { metrics: { firstAttemptSuccess: ["w-a"] } },
      },
    );

    const evidence = expectEvidence(result);
    expect(evidence.firstAttemptSuccess).toBeCloseTo(0.4, 12);
    expect(evidence.evidenceRef).toBe("matrix:m-a@r1");
  });

  // Kills: dropping the pair and emitting partial evidence.
  test("E5: missing and empty candidate cells refuse the whole evidence aggregate", async () => {
    const fromCells = await loadFromCells();
    const result = fromCells([cell({ workload_name: "w-a", n_rows: 0 })], {
      model: "m-a",
      mapping: {
        metrics: {
          runtimeReliability: ["w-z"],
          firstAttemptSuccess: ["w-x", "w-a"],
          toolCallCorrectness: ["w-y"],
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      reason: "missing-cells",
      missing: [
        { side: "candidate", metric: "firstAttemptSuccess", workload: "w-x" },
        { side: "candidate", metric: "firstAttemptSuccess", workload: "w-a" },
        { side: "candidate", metric: "toolCallCorrectness", workload: "w-y" },
        { side: "candidate", metric: "runtimeReliability", workload: "w-z" },
      ],
    });
    expect("evidence" in result).toBe(false);
  });

  // Kills: a non-strict schema, a map that can set the baseline-relative
  // metrics, requiring every metric key, an unreachable at-least-one refine,
  // or dropping workload dedupe.
  test("E6: the mapping parser is strict and accepts exactly the absolute metrics", async () => {
    const parseMapping = await loadParseMapping();
    // Each invalid input is the valid single-key map below plus exactly one
    // defect, so it must fail with that one issue and nothing else.
    const single = { firstAttemptSuccess: ["w-a"] };
    const invalid: { name: string; input: unknown; issue: Record<string, unknown> }[] = [
      {
        name: "regression refused",
        input: { metrics: { ...single, regression: ["w-a"] } },
        issue: { code: "unrecognized_keys", keys: ["regression"], path: ["metrics"] },
      },
      {
        name: "improvement refused",
        input: { metrics: { ...single, improvement: ["w-a"] } },
        issue: { code: "unrecognized_keys", keys: ["improvement"], path: ["metrics"] },
      },
      {
        name: "unknown top-level key",
        input: { metrics: single, autoapply: true },
        issue: { code: "unrecognized_keys", keys: ["autoapply"], path: [] },
      },
      {
        name: "unknown metric key",
        input: { metrics: { ...single, autoapply: ["w-a"] } },
        issue: { code: "unrecognized_keys", keys: ["autoapply"], path: ["metrics"] },
      },
      {
        name: "empty metrics",
        input: { metrics: {} },
        issue: {
          code: "custom",
          path: ["metrics"],
          message: "metrics must contain at least one key",
        },
      },
      {
        name: "empty workload array",
        input: { metrics: { firstAttemptSuccess: [] } },
        issue: { code: "too_small", origin: "array", path: ["metrics", "firstAttemptSuccess"] },
      },
      {
        name: "empty workload name",
        input: { metrics: { firstAttemptSuccess: [""] } },
        issue: {
          code: "too_small",
          origin: "string",
          path: ["metrics", "firstAttemptSuccess", 0],
        },
      },
    ];
    for (const { name, input, issue } of invalid) {
      let thrown: unknown;
      try {
        parseMapping(input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, name).toBeInstanceOf(z.ZodError);
      const issues = thrown instanceof z.ZodError ? thrown.issues : [];
      expect(issues, name).toHaveLength(1);
      expect(issues[0], name).toMatchObject(issue);
    }

    const singleMap = { metrics: { firstAttemptSuccess: ["w-a"] } };
    const parsedSingle = parseMapping(singleMap);
    expect(parsedSingle).toEqual(singleMap);
    expect(Object.keys(parsedSingle.metrics)).toEqual(["firstAttemptSuccess"]);

    // Workload lists are deduplicated in first-seen order, as documented.
    expect(
      parseMapping({ metrics: { firstAttemptSuccess: ["w-a", "w-a", "w-b", "w-a"] } }),
    ).toEqual({ metrics: { firstAttemptSuccess: ["w-a", "w-b"] } });

    const valid = {
      metrics: {
        firstAttemptSuccess: ["w-a"],
        repairSuccess: ["w-b"],
        toolCallCorrectness: ["w-c"],
        structuredOutputValidity: ["w-d"],
        memoryStability: ["w-e"],
        runtimeReliability: ["w-f"],
      },
    };
    expect(parseMapping(valid)).toEqual(valid);
  });

  // Kills: skipping parsePromotionEvidence.
  test("E7: a percent-scaled primary_metric_value is refused as evidence", async () => {
    const fromCells = await loadFromCells();
    expect(() =>
      fromCells([cell({ primary_metric_value: 42 })], {
        model: "m-a",
        mapping: { metrics: { firstAttemptSuccess: ["w-a"] } },
      }),
    ).toThrow(z.ZodError);
  });

  // Kills: inventing a baseline, or extra keys.
  test("E8: evidence without a baseline has no relative metrics and stays insufficient", async () => {
    const fromCells = await loadFromCells();
    const result = fromCells(
      [
        cell({
          run_id: "r9",
          workload_name: "w-a",
          primary_metric_value: 0.1,
          finished_at: "2025-01-01T01:00:00Z",
        }),
        cell({
          run_id: "r2",
          workload_name: "w-a",
          primary_metric_value: 0.9,
          finished_at: "2025-01-03T01:00:00Z",
        }),
        cell({
          run_id: "r1",
          workload_name: "w-b",
          primary_metric_value: 0.8,
          finished_at: "2025-01-02T01:00:00Z",
        }),
      ],
      {
        model: "m-a",
        mapping: {
          metrics: {
            firstAttemptSuccess: ["w-a"],
            repairSuccess: ["w-b"],
            toolCallCorrectness: ["w-a"],
            structuredOutputValidity: ["w-b"],
            memoryStability: ["w-a"],
            runtimeReliability: ["w-b"],
          },
        },
      },
    );

    const evidence = expectEvidence(result);
    expect("regression" in evidence).toBe(false);
    expect("improvement" in evidence).toBe(false);
    expect(evidence.evidenceRef).toBe("matrix:m-a@r1,r2");
    expect(parsePromotionEvidence(evidence)).toEqual(evidence);
    expect(
      proposePromotion({
        rel: "org/model",
        declared: "experimental",
        evidence,
        policy: { thresholds: { candidate: fullCandidateThresholds() }, autoApply: false },
      }),
    ).toEqual({ kind: "none", reason: "insufficient-evidence" });
  });

  // Kills: counting unchanged as regressed (2/3); n_rows-weighting regression
  // (0.25); an unweighted improvement (0.0667); a workload counted twice when
  // it is mapped to two metrics.
  test("E9: baseline regression is per workload and improvement is n_rows-weighted", async () => {
    const fromCells = await loadFromCells();
    const rows = [
      cell({ run_id: "r1", workload_name: "w-a", primary_metric_value: 0.7, n_rows: 10 }),
      cell({ run_id: "r1", workload_name: "w-b", primary_metric_value: 0.8, n_rows: 10 }),
      cell({ run_id: "r1", workload_name: "w-c", primary_metric_value: 0.9, n_rows: 20 }),
      cell({
        run_id: "r0",
        model_name: "m-base",
        workload_name: "w-a",
        primary_metric_value: 0.8,
        n_rows: 10,
      }),
      cell({
        run_id: "r0",
        model_name: "m-base",
        workload_name: "w-b",
        primary_metric_value: 0.8,
        n_rows: 10,
      }),
      cell({
        run_id: "r0",
        model_name: "m-base",
        workload_name: "w-c",
        primary_metric_value: 0.6,
        n_rows: 20,
      }),
    ];
    const distinctMapping = {
      metrics: {
        firstAttemptSuccess: ["w-a"],
        repairSuccess: ["w-b"],
        toolCallCorrectness: ["w-c"],
      },
    };
    const result = fromCells(rows, {
      model: "m-a",
      runId: "r1",
      baseline: { model: "m-base", runId: "r0" },
      mapping: distinctMapping,
    });

    const evidence = expectEvidence(result);
    expect(evidence.regression).toBeCloseTo(1 / 3, 12);
    expect(evidence.improvement).toBeCloseTo(0.125, 12);
    expect(evidence.evidenceRef).toBe("matrix:m-a@r1;baseline=m-base@r0");

    const duplicated = fromCells(rows, {
      model: "m-a",
      runId: "r1",
      baseline: { model: "m-base", runId: "r0" },
      mapping: {
        metrics: {
          ...distinctMapping.metrics,
          structuredOutputValidity: ["w-c"],
        },
      },
    });
    const deduped = expectEvidence(duplicated);
    expect(deduped.regression).toBeCloseTo(1 / 3, 12);
    expect(deduped.improvement).toBeCloseTo(0.125, 12);
  });

  // Kills: falling back to the latest m-base cell regardless of run id.
  test("E10: the baseline run id is honoured and reported after candidate misses", async () => {
    const fromCells = await loadFromCells();
    const result = fromCells(
      [
        cell({ run_id: "r1", workload_name: "w-a" }),
        cell({ run_id: "r1", workload_name: "w-b" }),
        cell({ run_id: "r0", model_name: "m-base", workload_name: "w-a" }),
        cell({ run_id: "r9", model_name: "m-base", workload_name: "w-b" }),
      ],
      {
        model: "m-a",
        runId: "r1",
        baseline: { model: "m-base", runId: "r0" },
        mapping: {
          metrics: {
            firstAttemptSuccess: ["w-x", "w-a"],
            toolCallCorrectness: ["w-b"],
          },
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "missing-cells",
      missing: [
        { side: "candidate", metric: "firstAttemptSuccess", workload: "w-x" },
        { side: "baseline", workload: "w-b" },
      ],
    });
  });

  // Kills: comparing a run with itself, which yields regression 0 and
  // improvement 0 and a false promotion.
  test("E11: a baseline cell identical to the candidate cell is refused", async () => {
    const fromCells = await loadFromCells();
    const result = fromCells([cell({ run_id: "r1", workload_name: "w-a" })], {
      model: "m-a",
      runId: "r1",
      baseline: { model: "m-a", runId: "r1" },
      mapping: { metrics: { firstAttemptSuccess: ["w-a"] } },
    });

    expect(result).toEqual({
      ok: false,
      reason: "baseline-is-candidate",
      workloads: ["w-a"],
    });
  });

  // Kills: calling listCellRows or ensureMatrixSchema, which throws
  // 'attempt to write a readonly database'.
  test("E12: readMatrixCellRows reads a readonly legacy matrix db without writing", async () => {
    const readRows = await loadReadRows();
    const dir = mkdtempSync(join(tmpdir(), "llamactl-evidence-ro-"));
    try {
      const path = join(dir, "matrix.db");
      const setup = new Database(path);
      setup.run(`
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
      `);
      const row = cell({ run_id: "r-legacy", workload_name: "w-legacy" });
      setup
        .prepare(`INSERT INTO matrix_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
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
      setup.close();

      const db = new Database(path, { readonly: true });
      try {
        expect(readRows(db)).toEqual([row]);
        const tables = db
          .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];
        expect(tables.map((table) => table.name)).toEqual(["matrix_runs"]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
