#!/usr/bin/env bun
/**
 * Diff two perf bench runs metric-by-metric and surface regressions.
 *
 * Usage:
 *   bun packages/eval/src/perf/diff.ts --base <run_id> --candidate <run_id> \
 *     [--db <path>] [--model <name>] [--format md|json] [--tolerance <fraction>]
 *
 * --db defaults to $DEV_STORAGE/eval/perf.sqlite, or ~/.llamactl/eval/perf.sqlite,
 * which is the store `llamactl bench schedule` kind:"suite" writes.
 *
 * Exit codes:
 *   0 ok
 *   1 usage / IO error
 *   2 unknown run
 *   3 regression
 */

import { llamactlHome } from "@llamactl/core/config/env";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { EvalProvenance, MetricValue, PerfRunRow, ProvenanceField } from "../matrix/types.js";
import type { PERF_METRIC_NAMES } from "./metrics.js";

import { compareMetric, formatMetric } from "../matrix/diff.js";
import { listPerfRuns } from "../matrix/store.js";
import { PROVENANCE_UNAVAILABLE_FIELDS } from "../matrix/types.js";
import { existsSync } from "../safe-fs.js";

export const PERF_METRIC_HIGHER_IS_BETTER: Record<(typeof PERF_METRIC_NAMES)[number], boolean> = {
  load_cold_ms: false,
  load_warm_ms: false,
  prefill_4k_tps: true,
  prefill_16k_tps: true,
  prefill_32k_tps: true,
  prefill_64k_tps: true,
  decode_tps: true,
  ttft_ms: false,
  spec_acceptance: true,
  c1_tps: true,
  c2_tps: true,
  c4_tps: true,
  ssd_read_bytes: false,
  ssd_write_bytes: false,
  peak_rss_bytes: false,
  peak_gtt_bytes: false,
};

export function defaultPerfDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(llamactlHome(env), "eval", "perf.sqlite");
}

export interface PerfMetricDiff {
  suite_name: string;
  metric_name: string;
  baseline: MetricValue;
  candidate: MetricValue;
  verdict: "improved" | "regressed" | "unchanged" | "unavailable";
  delta: number | null;
  reason: string | null;
}

// Provenance rides every perf row, so a metric delta can be read against the
// launch that produced it. The order is the render order of the md table.
export const PERF_PROVENANCE_DIFF_FIELDS = [
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
] as const satisfies readonly Exclude<keyof EvalProvenance, "unavailable">[];

export type PerfProvenanceDiffField = (typeof PERF_PROVENANCE_DIFF_FIELDS)[number];

type UncoveredField = Exclude<ProvenanceField, PerfProvenanceDiffField>;
export const ALL_PROVENANCE_FIELDS_DIFFED: [UncoveredField] extends [never] ? true : false = true;

export interface PerfProvenanceDiff {
  field: PerfProvenanceDiffField;
  baseline: string | number | string[] | null;
  candidate: string | number | string[] | null;
  verdict: "same" | "differs" | "unavailable";
  reason: string | null;
}

export interface PerfDiffMeta {
  base: string;
  cand: string;
  baseModel: string;
  baseEngine: string;
  candModel: string;
  candEngine: string;
  provenance: PerfProvenanceDiff[];
}

function missingMetricValue(reason: string): MetricValue {
  return { value: null, status: "unavailable", reason };
}

function sideMetric(row: PerfRunRow | undefined, reason: string): MetricValue {
  return row ? row.metric : missingMetricValue(reason);
}

function metricKey(row: PerfRunRow): string {
  return `${row.suite_name}\t${row.metric_name}`;
}

export function diffPerfRuns(
  baseRows: PerfRunRow[],
  candRows: PerfRunRow[],
  opts: { tolerance?: number } = {},
): PerfMetricDiff[] {
  const baseMap = new Map<string, PerfRunRow>();
  for (const row of baseRows) baseMap.set(metricKey(row), row);
  const candMap = new Map<string, PerfRunRow>();
  for (const row of candRows) candMap.set(metricKey(row), row);

  const keys = new Set<string>([...baseMap.keys(), ...candMap.keys()]);
  const tolerance = opts.tolerance ?? 0;
  const lookup = PERF_METRIC_HIGHER_IS_BETTER as Record<string, boolean | undefined>;
  const out: PerfMetricDiff[] = [];
  for (const key of keys) {
    const baseRow = baseMap.get(key);
    const candRow = candMap.get(key);
    const suiteName = baseRow?.suite_name ?? candRow?.suite_name ?? "";
    const metricName = baseRow?.metric_name ?? candRow?.metric_name ?? "";
    const baseline = sideMetric(baseRow, "missing in baseline");
    const candidate = sideMetric(candRow, "missing in candidate");
    const higherIsBetter = lookup[metricName];
    if (higherIsBetter === undefined) {
      out.push({
        suite_name: suiteName,
        metric_name: metricName,
        baseline,
        candidate,
        verdict: "unavailable",
        delta: null,
        reason: `no direction for metric ${metricName}`,
      });
      continue;
    }
    const band = baseline.status === "ok" ? Math.abs(baseline.value) * tolerance : 0;
    const comparison = compareMetric(baseline, candidate, { higherIsBetter, tolerance: band });
    out.push({
      suite_name: suiteName,
      metric_name: metricName,
      baseline,
      candidate,
      verdict: comparison.verdict,
      delta: comparison.delta,
      reason: comparison.reason,
    });
  }
  out.sort(
    (a, b) =>
      a.suite_name.localeCompare(b.suite_name) || a.metric_name.localeCompare(b.metric_name),
  );
  return out;
}

type ProvenanceLeaf = string | number | string[];
type ProvenanceValue = ProvenanceLeaf | null;

function isProvenanceField(field: string): field is ProvenanceField {
  return (PROVENANCE_UNAVAILABLE_FIELDS as readonly string[]).includes(field);
}

function sideReason(provenance: EvalProvenance, field: string, fallback: string): string {
  const recorded = isProvenanceField(field) ? provenance.unavailable?.[field] : undefined;
  return recorded !== undefined && recorded.trim() !== "" ? recorded : fallback;
}

// A row written before a field shipped misses the key entirely, so a missing
// key reads as unavailable exactly like a recorded null.
function sideValue(provenance: EvalProvenance, field: string): ProvenanceValue {
  const value = (provenance as unknown as Record<string, unknown>)[field];
  if (value === null || value === undefined) return null;
  return value as string | number | string[];
}

function sameValue(a: ProvenanceLeaf, b: ProvenanceLeaf): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return !a.some((token, index) => token !== b[index]);
  }
  return a === b;
}

export function diffPerfProvenance(
  base: EvalProvenance,
  cand: EvalProvenance,
): PerfProvenanceDiff[] {
  const fallback = "not recorded";
  const out: PerfProvenanceDiff[] = [];
  for (const field of PERF_PROVENANCE_DIFF_FIELDS) {
    const baseline = sideValue(base, field);
    const candidate = sideValue(cand, field);
    if (baseline === null || candidate === null) {
      const reasons: string[] = [];
      if (baseline === null) reasons.push(`baseline: ${sideReason(base, field, fallback)}`);
      if (candidate === null) reasons.push(`candidate: ${sideReason(cand, field, fallback)}`);
      out.push({
        field,
        baseline,
        candidate,
        verdict: "unavailable",
        reason: reasons.join("; "),
      });
      continue;
    }
    out.push({
      field,
      baseline,
      candidate,
      verdict: sameValue(baseline, candidate) ? "same" : "differs",
      reason: null,
    });
  }
  return out;
}

function mdField(value: string): string {
  return value.replaceAll("|", "\\|");
}

function provenanceCell(value: ProvenanceValue): string {
  if (value === null) return mdField("unavailable");
  if (typeof value === "number") return mdField(String(value));
  if (Array.isArray(value)) return mdField(value.length === 0 ? "(none)" : value.join(" "));
  return mdField(value);
}

export function renderPerfDiffMd(diffs: PerfMetricDiff[], meta: PerfDiffMeta): string {
  const lines = [
    `baseline: ${meta.base} (${meta.baseModel}, ${meta.baseEngine})`,
    `candidate: ${meta.cand} (${meta.candModel}, ${meta.candEngine})`,
    "",
    "| Suite | Metric | Baseline | Candidate | Delta | Verdict |",
    "|---|---|---|---|---|---|",
  ];
  for (const d of diffs) {
    lines.push(
      `| ${[
        mdField(d.suite_name),
        mdField(d.metric_name),
        formatMetric(d.baseline, 2),
        formatMetric(d.candidate, 2),
        d.delta === null ? "n/a" : d.delta.toFixed(2),
        d.verdict,
      ].join(" | ")} |`,
    );
  }
  if (meta.provenance.length > 0) {
    lines.push("", "| Provenance | Baseline | Candidate | Verdict |", "|---|---|---|---|");
    for (const p of meta.provenance) {
      const cells = [p.field, provenanceCell(p.baseline), provenanceCell(p.candidate), p.verdict];
      lines.push(`| ${cells.join(" | ")} |`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderPerfDiffJson(diffs: PerfMetricDiff[], meta: PerfDiffMeta): string {
  const doc = { baseline: meta.base, candidate: meta.cand, diffs, provenance: meta.provenance };
  return JSON.stringify(doc, null, 2) + "\n";
}

interface PerfDiffArgs {
  db: string;
  base: string;
  candidate: string;
  model?: string;
  format: "md" | "json";
  tolerance: number;
}

function parseTolerance(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--tolerance must be a finite number >= 0");
  }
  return value;
}

function parsePerfDiffArgs(argv: string[], env: NodeJS.ProcessEnv): PerfDiffArgs {
  const readArg = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const base = readArg("--base");
  const candidate = readArg("--candidate");
  if (base === undefined || candidate === undefined) {
    throw new Error("--base and --candidate are required");
  }
  const formatRaw = readArg("--format") ?? "md";
  if (formatRaw !== "md" && formatRaw !== "json") {
    throw new Error("--format must be md or json");
  }
  const model = readArg("--model");
  return {
    db: readArg("--db") ?? defaultPerfDbPath(env),
    base,
    candidate,
    ...(model !== undefined ? { model } : {}),
    format: formatRaw,
    tolerance: parseTolerance(readArg("--tolerance")),
  };
}

function filterFor(
  runId: string,
  model: string | undefined,
): { run_id: string; model_name?: string } {
  return { run_id: runId, ...(model !== undefined ? { model_name: model } : {}) };
}

function allSameModel(rows: PerfRunRow[]): boolean {
  const first = rows[0];
  if (first === undefined) return true;
  for (const row of rows) {
    if (row.model_name !== first.model_name) return false;
  }
  return true;
}

class IncompleteSchemaError extends Error {}

// listPerfRuns runs ensureMatrixSchema, a no-op on a read-only handle once
// the tables exist but a write on a fresh store; skip it when perf_runs is
// absent so an empty or pre-perf db reads as "no rows" instead of throwing.
// A db holding perf_runs without the other matrix tables still makes it
// write, which the read-only handle refuses with SQLITE_READONLY.
function readPerfRows(db: Database, filter: { run_id: string; model_name?: string }): PerfRunRow[] {
  const table = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'perf_runs'")
    .get();
  if (table === null) return [];
  try {
    return listPerfRuns(db, filter);
  } catch (error) {
    if ((error as { code?: unknown }).code === "SQLITE_READONLY") {
      throw new IncompleteSchemaError("lacks the matrix tables and is opened read-only");
    }
    throw error;
  }
}

function err(msg: string): void {
  process.stderr.write(`perf-diff: ${msg}\n`);
}

export function perfDiffMain(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  let args: PerfDiffArgs;
  try {
    args = parsePerfDiffArgs(argv, env);
  } catch (err2) {
    err((err2 as Error).message);
    return 1;
  }
  if (!existsSync(args.db)) {
    err(`db not found at ${args.db}`);
    return 1;
  }
  const db = new Database(args.db, { readonly: true });
  try {
    const baseRows = readPerfRows(db, filterFor(args.base, args.model));
    const baseFirst = baseRows[0];
    if (baseFirst === undefined) {
      err(`no perf rows for run '${args.base}'`);
      return 2;
    }
    if (!allSameModel(baseRows)) {
      err(`run '${args.base}' holds more than one model; pass --model <name>`);
      return 1;
    }
    const candRows = readPerfRows(db, filterFor(args.candidate, args.model));
    const candFirst = candRows[0];
    if (candFirst === undefined) {
      err(`no perf rows for run '${args.candidate}'`);
      return 2;
    }
    if (!allSameModel(candRows)) {
      err(`run '${args.candidate}' holds more than one model; pass --model <name>`);
      return 1;
    }
    const diffs = diffPerfRuns(baseRows, candRows, { tolerance: args.tolerance });
    const meta: PerfDiffMeta = {
      base: args.base,
      cand: args.candidate,
      baseModel: baseFirst.model_name,
      baseEngine: baseFirst.provenance.engine,
      candModel: candFirst.model_name,
      candEngine: candFirst.provenance.engine,
      provenance: diffPerfProvenance(baseFirst.provenance, candFirst.provenance),
    };
    const out =
      args.format === "json" ? renderPerfDiffJson(diffs, meta) : renderPerfDiffMd(diffs, meta);
    process.stdout.write(out);
    return diffs.some((d) => d.verdict === "regressed") ? 3 : 0;
  } catch (error) {
    if (error instanceof IncompleteSchemaError) {
      err(`db at ${args.db} ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(perfDiffMain());
}
