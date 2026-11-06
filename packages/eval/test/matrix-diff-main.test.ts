import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Cell,
  loadCells,
  main,
  parseArgs,
  renderCsv,
  renderJson,
  renderMd,
} from "../src/matrix/diff.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

let tmp: string;
let dbPath: string;
let stdoutBuf: string;
let stderrBuf: string;
let restoreStdout: () => void;
let restoreStderr: () => void;

function makeCell(row: Partial<Cell> & Pick<Cell, "model_name" | "workload_name">): Cell {
  const { model_name, workload_name, ...rest } = row;
  return {
    run_id: "run-default",
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
    "run-alpha",
    "mlx-4bit",
    "tool-call",
    50,
    "mean_exact_match",
    0.5,
    100,
    500,
    30,
    0,
    "2026-05-19T01:00:00Z",
    "2026-05-19T01:01:00Z",
  );
  ins.run(
    "run-beta",
    "llamacpp-Q4",
    "tool-call",
    50,
    "mean_exact_match",
    0.7,
    110,
    550,
    28,
    1,
    "2026-05-19T02:00:00Z",
    "2026-05-19T02:01:00Z",
  );
  ins.run(
    "run-gamma",
    "mlx-4bit",
    "memory-recall",
    105,
    "mean_ndcg5",
    0.56,
    200,
    800,
    36,
    0,
    "2026-05-19T03:00:00Z",
    "2026-05-19T03:01:00Z",
  );
  // Second run for (mlx-4bit, tool-call) with earlier timestamp
  ins.run(
    "run-delta",
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
  db.close();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-diff-main-"));
  dbPath = join(tmp, "matrix.db");
  seedDb(dbPath);
  stdoutBuf = "";
  stderrBuf = "";
  const stdoutSp = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutBuf += String(chunk);
    return true;
  });
  const stderrSp = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrBuf += String(chunk);
    return true;
  });
  restoreStdout = (): void => {
    (stdoutSp as { mockRestore: () => void }).mockRestore();
  };
  restoreStderr = (): void => {
    (stderrSp as { mockRestore: () => void }).mockRestore();
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  restoreStdout();
  restoreStderr();
});

// ---------------------------------------------------------------------------
// main() exit codes and error paths
// ---------------------------------------------------------------------------

describe("matrix/diff main — exit codes and error paths", () => {
  test("--format xml returns 1, stderr is exact, stdout is empty", () => {
    const exit = main(["--db", dbPath, "--format", "xml"]);
    expect(exit).toBe(1);
    expect(stderrBuf).toBe("diff: --format must be md|csv|json, got: xml\n");
    expect(stdoutBuf).toBe("");
  });

  test("nonexistent --db returns 1 with db-not-found stderr", () => {
    const missing = join(tmp, "missing.db");
    const exit = main(["--db", missing]);
    expect(exit).toBe(1);
    expect(stderrBuf).toBe(`diff: db not found at ${missing}\n`);
  });

  test("--models no-such-model returns 2, stderr is exact", () => {
    const exit = main(["--db", dbPath, "--models", "no-such-model"]);
    expect(exit).toBe(2);
    expect(stderrBuf).toBe("diff: no cells matched the filter\n");
  });
});

// ---------------------------------------------------------------------------
// main() successful paths
// ---------------------------------------------------------------------------

describe("matrix/diff main — successful paths", () => {
  test("--format json returns 0, stdout is JSON.parse(loadCells) deep-equals", () => {
    const exit = main(["--db", dbPath, "--format", "json"]);
    expect(exit).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    try {
      const cells = loadCells(db, { allRuns: false });
      expect(JSON.parse(stdoutBuf)).toEqual(cells);
    } finally {
      db.close();
    }
    expect(stdoutBuf.endsWith("\n")).toBe(true);
  });

  test("no --format returns 0, stdout equals renderMd(loadCells(...))", () => {
    const exit = main(["--db", dbPath]);
    expect(exit).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    try {
      const cells = loadCells(db, { allRuns: false });
      expect(stdoutBuf).toBe(renderMd(cells));
    } finally {
      db.close();
    }
    expect(stdoutBuf).toMatch(/^\| Workload \| Model \|/);
  });

  test("--format csv --all-runs returns 0, stdout has 1 header + rows", () => {
    const exit = main(["--db", dbPath, "--format", "csv", "--all-runs"]);
    expect(exit).toBe(0);
    const lines = stdoutBuf.trim().split("\n");
    expect(lines.length).toBe(1 + 4); // 1 header + 4 seeded rows
  });
});

// ---------------------------------------------------------------------------
// renderJson
// ---------------------------------------------------------------------------

describe("matrix/diff renderJson", () => {
  test("renderJson(cells) === JSON.stringify(cells, null, 2) + newline", () => {
    const cells = [
      makeCell({ model_name: "m1", workload_name: "w1" }),
      makeCell({ model_name: "m2", workload_name: "w2" }),
    ];
    expect(renderJson(cells)).toBe(JSON.stringify(cells, null, 2) + "\n");
  });

  test("renderJson([]) === '[]' + newline", () => {
    expect(renderJson([])).toBe("[]\n");
  });
});

// ---------------------------------------------------------------------------
// renderMd ordering and formatting
// ---------------------------------------------------------------------------

describe("matrix/diff renderMd ordering and formatting", () => {
  test("Rows sort by workload_name asc, primary_metric_value desc, model_name asc", () => {
    // m-model precedes a-model in the input so the model_name tiebreak on the
    // tied 0.9 pair is what produces the expected order; a stable sort without
    // it would keep m-model first.
    const cells = [
      makeCell({ model_name: "z-model", workload_name: "alpha", primary_metric_value: 0.5 }),
      makeCell({ model_name: "m-model", workload_name: "alpha", primary_metric_value: 0.9 }),
      makeCell({ model_name: "a-model", workload_name: "alpha", primary_metric_value: 0.9 }),
      makeCell({ model_name: "b-model", workload_name: "beta", primary_metric_value: 0.8 }),
    ];
    const md = renderMd(cells);
    const lines = md.split("\n");
    // Skip header (index 0), separator (index 1), and trailing empty line
    const dataRows = lines.slice(2).filter((l) => l.startsWith("|"));
    // Extract model_name (second column) from each data row
    const modelNames = dataRows.map((row) => {
      const parts = row.split("|");
      // | Workload | Model | ...
      // parts[0]="" parts[1]=" Workload " parts[2]=" Model " ...
      return (parts[2] ?? "").trim();
    });
    expect(modelNames).toEqual(["a-model", "m-model", "z-model", "b-model"]);
  });

  test("NaN and Infinity render as literal strings", () => {
    const cells: Cell[] = [
      {
        ...makeCell({ model_name: "nan-model", workload_name: "special" }),
        primary_metric_value: NaN,
        throughput_tps: Infinity,
        latency_p50_ms: -Infinity,
      },
    ];
    const md = renderMd(cells);
    expect(md).toContain("NaN");
    expect(md).toContain("Infinity");
    expect(md).toContain("-Infinity");
    expect(md).toContain(
      "| special | nan-model | 10 | mean_accuracy | NaN | Infinity | -Infinity | 0 |",
    );

    const csv = renderCsv(cells);
    expect(csv).toContain("NaN");
    expect(csv).toContain("Infinity");
  });

  test("renderMd escapes a backslash inside a model name", () => {
    const cells = [makeCell({ model_name: "a\\b", workload_name: "escape-test" })];
    const md = renderMd(cells);
    expect(md).toContain("a\\\\b");
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("matrix/diff parseArgs", () => {
  test("--models with spaces and blanks trims and filters", () => {
    const args = parseArgs(["--db", "/tmp/x.db", "--models", " a , ,b "]);
    expect(args.models).toEqual(["a", "b"]);
  });

  test("--models ',,' gives models: [] and matches loadCells with no filter", () => {
    const args = parseArgs(["--db", "/tmp/x.db", "--models", ",,"]);
    expect(args.models).toEqual([]);
    const db = new Database(dbPath, { readonly: true });
    const filtered = loadCells(db, { allRuns: false, models: [] });
    db.close();
    const db2 = new Database(dbPath, { readonly: true });
    const unfiltered = loadCells(db2, { allRuns: false });
    db2.close();
    expect(filtered).toEqual(unfiltered);
  });

  test("--models as last argument leaves models key absent", () => {
    const args = parseArgs(["--db", "/tmp/x.db", "--models"]);
    expect("models" in args).toBe(false);
  });

  test("--format csv and --format json are accepted", () => {
    const csvArgs = parseArgs(["--db", "/tmp/x.db", "--format", "csv"]);
    expect(csvArgs.format).toBe("csv");
    const jsonArgs = parseArgs(["--db", "/tmp/x.db", "--format", "json"]);
    expect(jsonArgs.format).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// loadCells
// ---------------------------------------------------------------------------

describe("matrix/diff loadCells", () => {
  test("models + workloads together returns only matching rows (AND)", () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = loadCells(db, { allRuns: false, models: ["mlx-4bit"], workloads: ["tool-call"] });
    db.close();
    expect(cells.length).toBe(1);
    const c0 = cells[0]!;
    expect(c0.model_name).toBe("mlx-4bit");
    expect(c0.workload_name).toBe("tool-call");
  });

  test("allRuns: true returns rows ordered by started_at descending", () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = loadCells(db, { allRuns: true });
    db.close();
    expect(cells.length).toBe(4);
    const c0 = cells[0]!;
    const c1 = cells[1]!;
    const c2 = cells[2]!;
    const c3 = cells[3]!;
    expect(c0.started_at).toBe("2026-05-19T03:00:00Z");
    expect(c1.started_at).toBe("2026-05-19T02:00:00Z");
    expect(c2.started_at).toBe("2026-05-19T01:00:00Z");
    expect(c3.started_at).toBe("2026-05-18T00:00:00Z");
  });
});
