// #521 RED: matrix markdown reports must carry the provenance rows runMatrix records.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildJsonClassifierWorkload,
  type CellRow,
  type EvalProvenance,
  type ModelSpec,
  type ProvenanceReaders,
  runMatrix,
} from "../src/index.js";
import * as matrixCli from "../src/matrix/cli.js";
import { renderCsvReport, renderMarkdownReport } from "../src/matrix/report.js";
import {
  insertCellRow,
  insertMatrixProvenance,
  listCellRows,
  listMatrixProvenance,
  type MatrixProvenanceRow,
} from "../src/matrix/store.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const dirs: string[] = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const P: EvalProvenance = {
  engine: "gufo",
  engine_version: null,
  engine_commit: "abc1234",
  binary_sha256: null,
  gguf_sha256: "a".repeat(64),
  hf_revision: null,
  quant: "IQ2_XXS",
  ctx: 8192,
  flags: ["--ctx-size", "8192", "-ngl", "99"],
  host: "host-a",
  unavailable: {
    engine_version: "engine --version exited with code 3: boom",
    binary_sha256: "ModelSpec m1 declares no engine binary (engine gufo runs outside eval)",
  },
};

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

function provenanceRow(
  modelName: string,
  provenance: EvalProvenance = P,
  runId = "run-1",
): MatrixProvenanceRow {
  return { run_id: runId, model_name: modelName, provenance };
}

function storeFixture(
  cells: CellRow[],
  provenanceRows: MatrixProvenanceRow[],
): { cells: CellRow[]; provenance: MatrixProvenanceRow[] } {
  const db = new Database(":memory:");
  try {
    for (const cell of cells) insertCellRow(db, cell);
    for (const row of provenanceRows) insertMatrixProvenance(db, row);
    return { cells: listCellRows(db), provenance: listMatrixProvenance(db) };
  } finally {
    db.close();
  }
}

type ReportOptions = NonNullable<Parameters<typeof renderMarkdownReport>[1]>;

function reportOptions(opts: {
  runId?: string;
  provenance?: MatrixProvenanceRow[];
}): ReportOptions {
  return {
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
  };
}

function renderFixture(
  cells: CellRow[],
  provenanceRows: MatrixProvenanceRow[],
  runId: string,
): string {
  const fixture = storeFixture(cells, provenanceRows);
  return renderMarkdownReport(
    fixture.cells,
    reportOptions({ runId, provenance: fixture.provenance }),
  );
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-eval-report-provenance-"));
  dirs.push(dir);
  return dir;
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
    extra_args: ["--ctx-size", "8192"],
  };
}

function fakeReaders(): ProvenanceReaders {
  return {
    sha256File: (path: string): string =>
      path.endsWith(".gguf") ? "a".repeat(64) : "b".repeat(64),
    engineVersion: (): { version: string; commit: string } => ({
      version: "9.9.9",
      commit: "abcdef1",
    }),
    hostname: (): string => "fake-host",
  };
}

describe("#521 matrix report provenance", () => {
  test("P1 renders the provenance section and table header", () => {
    const md = renderFixture(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      [provenanceRow("m1")],
      "run-1",
    );

    expect(md).toContain("\n## Provenance\n");
    expect(md).toContain("| Run | Model | Field | Value |");
  });

  test("P2 renders provenance fields in PERF_PROVENANCE_DIFF_FIELDS order", () => {
    const md = renderFixture(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      [provenanceRow("m1")],
      "run-1",
    );
    const fields = [
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
    let previous = -1;
    for (const field of fields) {
      const position = md.indexOf(`| run-1 | m1 | ${field} |`);
      expect(position, field).toBeGreaterThan(previous);
      previous = position;
    }

    for (const row of [
      "| run-1 | m1 | engine | gufo |",
      "| run-1 | m1 | engine_commit | abc1234 |",
      "| run-1 | m1 | ctx | 8192 |",
      "| run-1 | m1 | flags | --ctx-size 8192 -ngl 99 |",
      "| run-1 | m1 | host | host-a |",
    ]) {
      expect(md).toContain(row);
    }
  });

  test("P3 renders an unavailable field with its recorded reason", () => {
    const md = renderFixture(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      [provenanceRow("m1")],
      "run-1",
    );

    expect(md).toContain(
      "| run-1 | m1 | engine_version | unavailable (engine --version exited with code 3: boom) |",
    );
  });

  test("P4 falls back to not recorded when a null field has no reason", () => {
    const md = renderFixture(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      [provenanceRow("m1")],
      "run-1",
    );

    expect(md).toContain("| run-1 | m1 | hf_revision | unavailable (not recorded) |");
  });

  test("P5 renders an explicitly empty flags list as none", () => {
    const emptyFlags: EvalProvenance = { ...P, flags: [] };
    const md = renderFixture(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      [provenanceRow("m1", emptyFlags)],
      "run-1",
    );

    expect(md).toContain("| run-1 | m1 | flags | (none) |");
  });

  test("P6 renders a model without a provenance row instead of omitting it", () => {
    const md = renderFixture(
      [
        makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" }),
        makeCell({ model_name: "m2", workload_name: "w1", finished_at: "t1" }),
      ],
      [provenanceRow("m1")],
      "run-1",
    );

    expect(md).toContain("| run-1 | m2 | (all) | unavailable (not recorded) |");
  });

  test("P7 filters provenance rows to the report run", () => {
    const md = renderFixture(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      [provenanceRow("m1", P, "run-1"), provenanceRow("m1", P, "run-2")],
      "run-1",
    );

    expect(md).toContain("| run-1 | m1 | engine |");
    expect(md).not.toContain("| run-2 |");
  });

  test("P8 escapes pipes inside rendered provenance values", () => {
    const pipeFlags: EvalProvenance = { ...P, flags: ["--x=a|b"] };
    const md = renderFixture(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      [provenanceRow("m1", pipeFlags)],
      "run-1",
    );

    expect(md).toContain("--x=a\\|b");
  });

  test("P9 places the provenance section after the per-workload winner", () => {
    const md = renderFixture(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      [provenanceRow("m1")],
      "run-1",
    );

    expect(md.indexOf("## Provenance")).toBeGreaterThan(md.indexOf("## Per-workload winner"));
  });

  test("G1 omits the provenance section when the option is absent", () => {
    const md = renderMarkdownReport(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      { runId: "run-1" },
    );

    expect(md).not.toContain("## Provenance");
  });

  test("G2 csv reports carry no provenance rows", () => {
    const csv = renderCsvReport(
      [makeCell({ model_name: "m1", workload_name: "w1", finished_at: "t1" })],
      reportOptions({ runId: "run-1", provenance: [provenanceRow("m1")] }),
    );

    expect(csv).not.toContain("provenance");
  });

  test("W1 cli writeReport loads matrix provenance into markdown reports", async () => {
    const writeReport = (matrixCli as Record<string, unknown>)["writeReport"];
    expect(typeof writeReport).toBe("function");

    const dir = tempDir();
    const corpusPath = join(dir, "corpus.jsonl");
    writeFileSync(corpusPath, `${chatCorpusRow()}\n`);
    const workload = buildJsonClassifierWorkload({
      name: "provenance-json-classifier",
      corpus_path: corpusPath,
      labelField: "label",
      validLabels: new Set(["yes", "no"]),
    });
    const port = await stoppedServerPort();
    const modelName = "gufo-report-provenance";
    const db = new Database(join(dir, "matrix.db"));
    dbs.push(db);
    const result = await runMatrix({
      models: [gufoSpec(modelName, port)],
      workloads: [workload],
      db,
      runId: "run-cli-provenance",
      provenanceReaders: fakeReaders(),
    });

    const provenanceModels = listMatrixProvenance(db, { run_id: result.runId }).map(
      (row) => row.model_name,
    );
    expect(provenanceModels).toContain(modelName);
    const writeReportFn = writeReport as (opts: {
      report: "md" | "csv" | "both";
      reportOut: string | undefined;
      db: Database;
      runId: string;
      reportAllRuns: boolean;
    }) => Promise<void>;
    const reportOut = join(dir, "r.md");
    await writeReportFn({
      report: "md",
      reportOut,
      db,
      runId: result.runId,
      reportAllRuns: false,
    });
    const report = readFileSync(reportOut, "utf8");

    expect(report).toContain("## Provenance");
    expect(report).toContain(`| ${result.runId} | ${modelName} | engine | gufo |`);
  });
});
