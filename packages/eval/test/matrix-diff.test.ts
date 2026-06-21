import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Cell, loadCells, parseArgs, renderCsv, renderMd } from "../src/matrix/diff.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

let tmp: string;
let dbPath: string;

function makeCell(row: Partial<Cell> & Pick<Cell, "model_name" | "workload_name">): Cell {
  const { model_name, workload_name, ...rest } = row;
  return {
    run_id: "run-escape",
    model_name,
    workload_name,
    n_rows: 10,
    primary_metric_name: "mean_accuracy",
    primary_metric_value: 0.75,
    throughput_tps: 25,
    latency_p50_ms: 100,
    errors: 0,
    started_at: "2026-05-19T00:00:00Z",
    ...rest,
  };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (char === '"') {
      if (quoted && line.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function markdownCellCount(row: string): number {
  let separators = 0;
  for (let i = 0; i < row.length; i++) {
    if (row.charAt(i) === "|" && row.charAt(i - 1) !== "\\") separators++;
  }
  return separators - 1;
}

function seedDb(path: string): void {
  const db = new Database(path);
  db.run(`
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
    );
  `);
  const ins = db.prepare(
    `INSERT INTO matrix_runs VALUES (?, 0, ?, ?, '{}', ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 'test')`,
  );
  ins.run(
    "run-1",
    "mlx-4bit",
    "tool-call",
    50,
    "mean_exact_match",
    0.5,
    100,
    500,
    30,
    0,
    "2026-05-19T00:00:00Z",
    "2026-05-19T00:01:00Z",
  );
  ins.run(
    "run-2",
    "llamacpp-Q4",
    "tool-call",
    50,
    "mean_exact_match",
    0.7,
    110,
    550,
    28,
    1,
    "2026-05-19T01:00:00Z",
    "2026-05-19T01:01:00Z",
  );
  ins.run(
    "run-0",
    "mlx-4bit",
    "tool-call",
    50,
    "mean_exact_match",
    0.3,
    120,
    600,
    25,
    0,
    "2026-05-18T00:00:00Z",
    "2026-05-18T00:01:00Z",
  );
  ins.run(
    "run-3",
    "mlx-4bit",
    "memory-recall",
    105,
    "mean_ndcg5",
    0.56,
    200,
    800,
    36,
    0,
    "2026-05-19T02:00:00Z",
    "2026-05-19T02:01:00Z",
  );
  db.close();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-diff-"));
  dbPath = join(tmp, "matrix.db");
  seedDb(dbPath);
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Temporary directory cleanup is best effort on teardown.
  }
});

describe("matrix/diff parseArgs", () => {
  test("parses --models and --workloads as comma-lists", () => {
    const args = parseArgs(["--db", "/tmp/x.db", "--models", "a,b", "--workloads", "w1,w2"]);
    expect(args.models).toEqual(["a", "b"]);
    expect(args.workloads).toEqual(["w1", "w2"]);
  });

  test("defaults format to md and db path", () => {
    const args = parseArgs([]);
    expect(args.format).toBe("md");
    expect(args.db).toBe("packages/eval/results/matrix.db");
    expect(args.allRuns).toBe(false);
  });

  test("--all-runs sets the flag", () => {
    expect(parseArgs(["--all-runs"]).allRuns).toBe(true);
  });

  test("rejects unknown --format", () => {
    expect(() => parseArgs(["--format", "xml"])).toThrow(/format/);
  });
});

describe("matrix/diff loadCells", () => {
  test("default returns latest run per (model, workload)", () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = loadCells(db, { allRuns: false });
    db.close();
    expect(cells.length).toBe(3);
    const mlxToolCall = cells.find(
      (c) => c.model_name === "mlx-4bit" && c.workload_name === "tool-call",
    );
    expect(mlxToolCall?.run_id).toBe("run-1");
    expect(mlxToolCall?.primary_metric_value).toBe(0.5);
  });

  test("--all-runs returns every row", () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = loadCells(db, { allRuns: true });
    db.close();
    expect(cells.length).toBe(4);
  });

  test("--models filter excludes other models", () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = loadCells(db, { allRuns: false, models: ["llamacpp-Q4"] });
    db.close();
    expect(cells.length).toBe(1);
    expect(cells[0]?.model_name).toBe("llamacpp-Q4");
  });

  test("--workloads filter excludes other workloads", () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = loadCells(db, { allRuns: false, workloads: ["memory-recall"] });
    db.close();
    expect(cells.length).toBe(1);
    expect(cells[0]?.workload_name).toBe("memory-recall");
  });
});

describe("matrix/diff renderers", () => {
  test("renderMd produces a header + one row per cell", () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = loadCells(db, { allRuns: false });
    db.close();
    const md = renderMd(cells);
    expect(md).toContain("| Workload | Model |");
    expect(md.split("\n").filter((l) => l.startsWith("|")).length).toBe(2 + cells.length);
  });

  test("renderCsv emits header row + cells", () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = loadCells(db, { allRuns: false });
    db.close();
    const csv = renderCsv(cells);
    expect(csv.split("\n")[0]).toBe(
      "workload,model,n,metric,value,tps,p50_ms,errors,run_id,started_at",
    );
    expect(csv.trim().split("\n").length).toBe(1 + cells.length);
  });

  test("renderCsv escapes fields so commas do not shift columns", () => {
    const csv = renderCsv([
      makeCell({
        model_name: "gemma,4",
        workload_name: "memory-recall",
        primary_metric_name: 'ndcg"5',
      }),
    ]);
    const [header, row] = csv.trim().split("\n");

    expect(parseCsvLine(row ?? "")).toEqual([
      "memory-recall",
      "gemma,4",
      "10",
      'ndcg"5',
      "0.7500",
      "25.00",
      "100",
      "0",
      "run-escape",
      "2026-05-19T00:00:00Z",
    ]);
    expect(parseCsvLine(row ?? "")).toHaveLength(parseCsvLine(header ?? "").length);
  });

  test("renderMd escapes pipe characters inside cells", () => {
    const md = renderMd([
      makeCell({
        model_name: "gemma|mtp",
        workload_name: "memory|recall",
        primary_metric_name: "mean|ndcg5",
      }),
    ]);
    const row = md.split("\n").find((line) => line.includes("gemma"));

    expect(row).toContain("memory\\|recall");
    expect(row).toContain("gemma\\|mtp");
    expect(row).toContain("mean\\|ndcg5");
    expect(markdownCellCount(row ?? "")).toBe(8);
  });
});
