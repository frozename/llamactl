import { describe, expect, test } from "bun:test";
import { renderCsvReport, renderMarkdownReport, type CellRow } from "../src/index.js";

function makeCell(
  row: Partial<CellRow> &
    Pick<
      CellRow,
      | "run_id"
      | "model_name"
      | "workload_name"
      | "primary_metric_name"
      | "primary_metric_value"
      | "finished_at"
    >,
): CellRow {
  return {
    runner_version: 1,
    model_spec_json: "{}",
    n_rows: 1,
    per_class_metrics_json: "{}",
    latency_p50_ms: 100,
    latency_p95_ms: 200,
    throughput_tps: 10,
    errors: 0,
    started_at: "2026-05-17T00:00:00.000Z",
    host_machine: "host-a",
    ...row,
  };
}

describe("matrix report", () => {
  test("markdown pivot with 2 models × 1 workload", () => {
    const cells = [
      makeCell({
        run_id: "run-1",
        model_name: "model-a",
        workload_name: "workload-a",
        primary_metric_name: "accuracy",
        primary_metric_value: 0.75,
        latency_p50_ms: 943,
        latency_p95_ms: 1177,
        throughput_tps: 12.34,
        finished_at: "2026-05-17T00:01:00.000Z",
      }),
      makeCell({
        run_id: "run-1",
        model_name: "model-b",
        workload_name: "workload-a",
        primary_metric_name: "accuracy",
        primary_metric_value: 0.833,
        latency_p50_ms: 901,
        latency_p95_ms: 1111,
        throughput_tps: 13.21,
        finished_at: "2026-05-17T00:02:00.000Z",
      }),
    ];

    const md = renderMarkdownReport(cells);
    expect(md).toContain("| model-a | 0.7500 |");
    expect(md).toContain("- workload-a: **model-b** (0.8330)");
  });

  test("csv with 2 models × 2 workloads", () => {
    const cells = [
      makeCell({
        run_id: "run-1",
        model_name: "model-a",
        workload_name: "workload-a",
        primary_metric_name: "accuracy",
        primary_metric_value: 0.75,
        finished_at: "2026-05-17T00:01:00.000Z",
      }),
      makeCell({
        run_id: "run-1",
        model_name: "model-a",
        workload_name: "workload-b",
        primary_metric_name: "accuracy",
        primary_metric_value: 0.55,
        finished_at: "2026-05-17T00:01:30.000Z",
      }),
      makeCell({
        run_id: "run-1",
        model_name: "model-b",
        workload_name: "workload-a",
        primary_metric_name: "accuracy",
        primary_metric_value: 0.833,
        finished_at: "2026-05-17T00:02:00.000Z",
      }),
      makeCell({
        run_id: "run-1",
        model_name: "model-b",
        workload_name: "workload-b",
        primary_metric_name: "accuracy",
        primary_metric_value: 0.6543,
        finished_at: "2026-05-17T00:03:00.000Z",
      }),
    ];

    const csv = renderCsvReport(cells);
    const rows = csv.trim().split("\n");
    const primary = rows.filter((line) => line.startsWith("primary_metric,"));
    expect(primary).toHaveLength(4);
    expect(primary).toContain("primary_metric,model-a,workload-a,0.7500");
    expect(primary).toContain("primary_metric,model-b,workload-b,0.6543");
  });

  test("csv escapes fields with commas and quotes", () => {
    const cells = [
      makeCell({
        run_id: "run-1",
        model_name: "foo, bar",
        workload_name: 'work"load',
        primary_metric_name: "accuracy",
        primary_metric_value: 0.5,
        finished_at: "2026-05-17T00:01:00.000Z",
      }),
    ];

    const csv = renderCsvReport(cells);
    expect(csv).toContain('primary_metric,"foo, bar","work""load",0.5000');
  });

  test("missing cell shows dash in markdown", () => {
    const cells = [
      makeCell({
        run_id: "run-1",
        model_name: "model-a",
        workload_name: "workload-a",
        primary_metric_name: "accuracy",
        primary_metric_value: 0.75,
        finished_at: "2026-05-17T00:01:00.000Z",
      }),
      makeCell({
        run_id: "run-1",
        model_name: "model-b",
        workload_name: "workload-b",
        primary_metric_name: "accuracy",
        primary_metric_value: 0.9,
        finished_at: "2026-05-17T00:02:00.000Z",
      }),
    ];

    const md = renderMarkdownReport(cells);
    expect(md).toContain("| model-b | - | 0.9000 |");
  });
});
