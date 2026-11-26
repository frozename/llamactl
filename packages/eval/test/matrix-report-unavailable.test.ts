import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildJsonClassifierWorkload,
  type CellRow,
  listCellRows,
  type ModelSpec,
  runMatrix,
} from "../src/index.js";
import { type Cell, renderCsv, renderJson, renderMd } from "../src/matrix/diff.js";
import { renderCsvReport, renderMarkdownReport } from "../src/matrix/report.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];
const dbs: Database[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
  servers.length = 0;
  for (const db of dbs) db.close();
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function makeCell(
  row: Partial<CellRow> & Pick<CellRow, "model_name" | "workload_name" | "finished_at">,
): CellRow {
  return {
    run_id: "run-1",
    runner_version: 1,
    model_spec_json: "{}",
    n_rows: 5,
    primary_metric_name: "accuracy",
    primary_metric_value: 0.5,
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

function scoredCell(
  modelName: string,
  workloadName: string,
  value: number,
  finishedAt: string,
): CellRow {
  return makeCell({
    model_name: modelName,
    workload_name: workloadName,
    primary_metric_value: value,
    finished_at: finishedAt,
  });
}

function bootErrorCell(modelName: string, workloadName: string, finishedAt: string): CellRow {
  return makeCell({
    model_name: modelName,
    workload_name: workloadName,
    n_rows: 0,
    primary_metric_value: 0,
    per_class_metrics_json: "{}",
    latency_p50_ms: 0,
    latency_p95_ms: 0,
    throughput_tps: 0,
    errors: 1,
    finished_at: finishedAt,
  });
}

function corpusFailedCell(modelName: string, workloadName: string, finishedAt: string): CellRow {
  return makeCell({
    model_name: modelName,
    workload_name: workloadName,
    n_rows: 0,
    primary_metric_value: -1,
    per_class_metrics_json: JSON.stringify({ error: "corpus_load_failed" }),
    latency_p50_ms: 0,
    latency_p95_ms: 0,
    throughput_tps: 0,
    errors: 0,
    finished_at: finishedAt,
  });
}

function primaryPivotFixture(): CellRow[] {
  return [
    scoredCell("model-a", "workload-a", 0.75, "2026-05-17T00:01:00.000Z"),
    bootErrorCell("model-b", "workload-a", "2026-05-17T00:02:00.000Z"),
  ];
}

function noScoredCellsFixture(): CellRow[] {
  return [
    bootErrorCell("model-b", "workload-a", "2026-05-17T00:01:00.000Z"),
    corpusFailedCell("model-c", "workload-a", "2026-05-17T00:02:00.000Z"),
  ];
}

function sectionSlice(md: string, start: string, end: string): string {
  const startIndex = md.indexOf(start);
  const endIndex = md.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return md.slice(startIndex, endIndex);
}

function makeDiffCell(row: Partial<Cell> & Pick<Cell, "model_name" | "workload_name">): Cell {
  return {
    run_id: "run-1",
    n_rows: 50,
    primary_metric_name: "mean_exact_match",
    primary_metric_value: 0.5,
    throughput_tps: 30,
    latency_p50_ms: 100,
    errors: 0,
    started_at: "2026-05-19T02:00:00Z",
    ...row,
  };
}

function diffFixture(): Cell[] {
  return [
    makeDiffCell({ model_name: "mlx-4bit", workload_name: "tool-call" }),
    makeDiffCell({
      model_name: "gufo-arm",
      workload_name: "tool-call",
      n_rows: 0,
      primary_metric_value: 0,
      throughput_tps: 0,
      latency_p50_ms: 0,
      errors: 1,
      run_id: "run-9",
      started_at: "2026-05-19T03:00:00Z",
    }),
  ];
}

const FAKE_COMPLETION = '{"label":"yes","memory_related":true,"reason":"x"}';

function startStubServer(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") {
        return new Response("ok");
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        return Response.json({
          choices: [{ message: { content: FAKE_COMPLETION } }],
          usage: { completion_tokens: 3 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return server.port!;
}

async function stoppedServerPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(): Response {
      return new Response("ok");
    },
  });
  const port = server.port!;
  await server.stop(true);
  return port;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-eval-unavailable-"));
  dirs.push(dir);
  return dir;
}

function chatCorpusRow(): string {
  return JSON.stringify({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: JSON.stringify({ label: "yes" }) },
    ],
  });
}

function gufoSpec(name: string, port: number): ModelSpec {
  return {
    name,
    engine: "gufo",
    managed: false,
    gguf_path: "/models/fake.gguf",
    quant: "Q4_K_M",
    family: "fake",
    size_params: "1b",
    host: "127.0.0.1",
    port,
    extra_args: [],
  };
}

describe("#521 matrix report unscored cells", () => {
  test("R1 markdown primary pivot renders a boot-error cell as unavailable", () => {
    const md = renderMarkdownReport(primaryPivotFixture());

    expect(md).toContain("| model-b | unavailable |");
    expect(md).not.toContain("| model-b | 0.0000 |");
  });

  test("R2 markdown latency and throughput render boot-error cells as unavailable", () => {
    const md = renderMarkdownReport(primaryPivotFixture());
    const latency = sectionSlice(md, "## Latency", "## Throughput");
    const throughput = sectionSlice(md, "## Throughput", "## Errors");

    expect(latency).toContain("| model-b | unavailable |");
    expect(latency).not.toContain("| model-b | 0 / 0 |");
    expect(throughput).toContain("| model-b | unavailable |");
    expect(throughput).not.toContain("| model-b | 0.00 |");
    expect(md).toContain("| model-b | 1 |");
  });

  test("R3 winner reports unavailable when no cell scored any rows", () => {
    const md = renderMarkdownReport(noScoredCellsFixture());

    expect(md).toContain("- workload-a: unavailable (no cell scored any rows)");
    expect(md).not.toContain("**model-b**");
    expect(md).not.toContain("**model-c**");
  });

  test("R3 winner ignores a later unscored zero cell", () => {
    const md = renderMarkdownReport([
      scoredCell("model-a", "workload-a", 0, "2026-05-17T00:01:00.000Z"),
      bootErrorCell("model-b", "workload-a", "2026-05-17T00:02:00.000Z"),
    ]);

    expect(md).toContain("- workload-a: **model-a** (0.0000)");
  });

  test("R4 unavailable cells section carries boot and corpus reasons in order", () => {
    const md = renderMarkdownReport(noScoredCellsFixture());

    expect(md).toContain("## Unavailable cells");
    expect(md).toContain("- model-b / workload-a: no rows scored");
    expect(md).toContain("- model-c / workload-a: no rows scored (corpus_load_failed)");
    const errorsIndex = md.indexOf("## Errors");
    const unavailableIndex = md.indexOf("## Unavailable cells");
    const winnerIndex = md.indexOf("## Per-workload winner");
    expect(errorsIndex).toBeGreaterThanOrEqual(0);
    expect(unavailableIndex).toBeGreaterThan(errorsIndex);
    expect(winnerIndex).toBeGreaterThan(unavailableIndex);
  });

  test("R5 csv report renders measured fields as unavailable without changing errors", () => {
    const csv = renderCsvReport(primaryPivotFixture());
    const lines = csv.trim().split("\n");

    expect(lines).toContain("primary_metric,model-b,workload-a,unavailable");
    expect(lines).toContain("latency_p50_ms,model-b,workload-a,unavailable");
    expect(lines).toContain("latency_p95_ms,model-b,workload-a,unavailable");
    expect(lines).toContain("throughput_tps,model-b,workload-a,unavailable");
    expect(lines).toContain("errors,model-b,workload-a,1");
    expect(csv).not.toContain("primary_metric,model-b,workload-a,0.0000");
  });

  test("R6 matrix diff markdown renders an unscored cell as unavailable after the scored row", () => {
    const md = renderMd(diffFixture());

    expect(md).toContain(
      "| tool-call | gufo-arm | 0 | mean_exact_match | unavailable | unavailable | unavailable | 1 |",
    );
    const rows = md.trim().split("\n");
    const scoredIndex = rows.findIndex((line) => line.includes("| tool-call | mlx-4bit |"));
    const unscoredIndex = rows.findIndex((line) => line.includes("| tool-call | gufo-arm |"));
    expect(scoredIndex).toBeGreaterThanOrEqual(0);
    expect(unscoredIndex).toBeGreaterThan(scoredIndex);
  });

  test("R6 matrix diff csv renders an unscored cell as unavailable", () => {
    const csv = renderCsv(diffFixture());

    expect(csv).toContain(
      "tool-call,gufo-arm,0,mean_exact_match,unavailable,unavailable,unavailable,1,run-9,2026-05-19T03:00:00Z",
    );
  });

  test("R7 runMatrix report renders an unreachable external gufo engine as unavailable", async () => {
    const upPort = startStubServer();
    const downPort = await stoppedServerPort();
    const dir = tempDir();
    const corpusPath = join(dir, "corpus.jsonl");
    writeFileSync(corpusPath, `${chatCorpusRow()}\n`);
    const workloadName = "unavailable-json-classifier";
    const workload = buildJsonClassifierWorkload({
      name: workloadName,
      corpus_path: corpusPath,
      labelField: "label",
      validLabels: new Set(["yes", "no"]),
    });
    const db = new Database(join(dir, "matrix.db"));
    dbs.push(db);

    const run = await runMatrix({
      models: [gufoSpec("gufo-up", upPort), gufoSpec("gufo-down", downPort)],
      workloads: [workload],
      db,
      runId: "run-unavailable-e2e",
    });
    const cells = listCellRows(db, { run_id: run.runId });
    const md = renderMarkdownReport(cells, { runId: run.runId });

    expect(cells).toHaveLength(2);
    expect(cells.find((cell) => cell.model_name === "gufo-down")?.n_rows).toBe(0);
    expect(md).toContain("| gufo-down | unavailable |");
    expect(md).toContain(`- gufo-down / ${workloadName}: no rows scored`);
    expect(md).not.toContain("| gufo-down | 0.0000 |");
    expect(md).toContain(`- ${workloadName}: **gufo-up**`);
  });

  test("G2 all-scored reports contain no unavailable token", () => {
    const cells = [
      scoredCell("model-a", "workload-a", 0.75, "2026-05-17T00:01:00.000Z"),
      scoredCell("model-b", "workload-a", 0.5, "2026-05-17T00:02:00.000Z"),
    ];

    const md = renderMarkdownReport(cells);
    const csv = renderCsvReport(cells);
    expect(md).not.toContain("## Unavailable cells");
    expect(md).not.toContain("unavailable");
    expect(csv).not.toContain("unavailable");
  });

  test("G3 diff json keeps boot-error numeric fields verbatim", () => {
    const cell = makeDiffCell({
      model_name: "gufo-arm",
      workload_name: "tool-call",
      n_rows: 0,
      primary_metric_value: 0,
      throughput_tps: 0,
      latency_p50_ms: 0,
      errors: 1,
      run_id: "run-9",
    });

    const parsed = JSON.parse(renderJson([cell])) as Cell[];
    expect(parsed[0]?.n_rows).toBe(0);
    expect(parsed[0]?.primary_metric_value).toBe(0);
  });
});
