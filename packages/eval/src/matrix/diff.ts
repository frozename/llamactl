#!/usr/bin/env bun
/**
 * Render a head-to-head comparison of matrix bench runs.
 *
 * Usage:
 *   bun packages/eval/src/matrix/diff.ts \
 *     [--db packages/eval/results/matrix.db] \
 *     [--models model1,model2,...] \
 *     [--workloads workload1,workload2,...] \
 *     [--format md|csv|json] \
 *     [--all-runs]
 *
 * Without --models, lists every model present in the DB. Without
 * --workloads, lists every workload. Without --all-runs, picks the
 * latest run per (model, workload).
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";

import { existsSync } from "../safe-fs.js";

export interface DiffArgs {
  db: string;
  models?: string[];
  workloads?: string[];
  format: "md" | "csv" | "json";
  allRuns: boolean;
}

export interface Cell {
  run_id: string;
  model_name: string;
  workload_name: string;
  n_rows: number;
  primary_metric_name: string;
  primary_metric_value: number;
  throughput_tps: number;
  latency_p50_ms: number;
  errors: number;
  started_at: string;
}

export function parseArgs(argv: string[]): DiffArgs {
  const readArg = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const db = readArg("--db") ?? "packages/eval/results/matrix.db";
  const modelsRaw = readArg("--models");
  const workloadsRaw = readArg("--workloads");
  const formatRaw = readArg("--format") ?? "md";
  if (formatRaw !== "md" && formatRaw !== "csv" && formatRaw !== "json") {
    throw new Error(`--format must be md|csv|json, got: ${formatRaw}`);
  }
  const models = modelsRaw
    ? modelsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const workloads = workloadsRaw
    ? workloadsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  return {
    db,
    ...(models !== undefined ? { models } : {}),
    ...(workloads !== undefined ? { workloads } : {}),
    format: formatRaw,
    allRuns: argv.includes("--all-runs"),
  };
}

export function loadCells(
  db: Database,
  args: Pick<DiffArgs, "models" | "workloads" | "allRuns">,
): Cell[] {
  let sql = `SELECT run_id, model_name, workload_name, n_rows, primary_metric_name,
                    primary_metric_value, throughput_tps, latency_p50_ms, errors, started_at
             FROM matrix_runs`;
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (args.models && args.models.length > 0) {
    conditions.push(`model_name IN (${args.models.map(() => "?").join(",")})`);
    params.push(...args.models);
  }
  if (args.workloads && args.workloads.length > 0) {
    conditions.push(`workload_name IN (${args.workloads.map(() => "?").join(",")})`);
    params.push(...args.workloads);
  }
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY started_at DESC";
  const all = db.query(sql).all(...params) as Cell[];

  if (args.allRuns) return all;

  // Latest run per (model, workload). Since we ORDER BY started_at DESC,
  // first occurrence is the latest.
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const cell of all) {
    const key = `${cell.model_name}\t${cell.workload_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cell);
  }
  return out;
}

function fmt(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function mdField(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

function csvField(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function renderMd(cells: Cell[]): string {
  const sorted = [...cells].sort(
    (a, b) =>
      a.workload_name.localeCompare(b.workload_name) ||
      b.primary_metric_value - a.primary_metric_value ||
      a.model_name.localeCompare(b.model_name),
  );
  const lines = [
    "| Workload | Model | n | Metric | Value | tps | p50_ms | err |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const c of sorted) {
    lines.push(
      `| ${[
        mdField(c.workload_name),
        mdField(c.model_name),
        String(c.n_rows),
        mdField(c.primary_metric_name),
        fmt(c.primary_metric_value, 4),
        fmt(c.throughput_tps, 2),
        fmt(c.latency_p50_ms, 0),
        String(c.errors),
      ].join(" | ")} |`,
    );
  }
  return lines.join("\n") + "\n";
}

export function renderCsv(cells: Cell[]): string {
  const header = "workload,model,n,metric,value,tps,p50_ms,errors,run_id,started_at";
  const rows = cells.map((c) =>
    [
      c.workload_name,
      c.model_name,
      String(c.n_rows),
      c.primary_metric_name,
      fmt(c.primary_metric_value, 4),
      fmt(c.throughput_tps, 2),
      fmt(c.latency_p50_ms, 0),
      String(c.errors),
      c.run_id,
      c.started_at,
    ]
      .map(csvField)
      .join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

export function renderJson(cells: Cell[]): string {
  return JSON.stringify(cells, null, 2) + "\n";
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let args: DiffArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`diff: ${(err as Error).message}\n`);
    return 1;
  }
  if (!existsSync(args.db)) {
    process.stderr.write(`diff: db not found at ${args.db}\n`);
    return 1;
  }
  const db = new Database(args.db, { readonly: true });
  try {
    const cells = loadCells(db, args);
    if (cells.length === 0) {
      process.stderr.write("diff: no cells matched the filter\n");
      return 2;
    }
    const out =
      args.format === "csv"
        ? renderCsv(cells)
        : args.format === "json"
          ? renderJson(cells)
          : renderMd(cells);
    process.stdout.write(out);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(main());
}
