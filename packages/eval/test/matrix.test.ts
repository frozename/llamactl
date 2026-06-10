import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import {
  aggregateMetrics,
  buildJsonClassifierWorkload,
  type CellRow,
  type CellRowDetail,
  ensureMatrixSchema,
  insertCellRow,
  insertCellRowDetail,
  listCellRowDetails,
  listCellRows,
  type ModelSpec,
  runMatrix,
  type WorkloadEval,
} from "../src/index.js";
import { memoryEfficacy4wayWorkload, memoryEfficacyBinaryWorkload } from "../src/index.js";
import { parseArgs, parseCorpusOverrides } from "../src/matrix/cli.js";

function makeModel(name: string): ModelSpec {
  return {
    name,
    gguf_path: `/models/${name}.gguf`,
    quant: "Q4",
    family: "test",
    size_params: "1b",
    host: "127.0.0.1",
    port: 8080,
    extra_args: [],
  };
}

describe("matrix store", () => {
  test("round-trips cell rows", () => {
    const db = new Database(":memory:");
    ensureMatrixSchema(db);

    const row: CellRow = {
      run_id: "run-1",
      runner_version: 0,
      model_name: "model-a",
      workload_name: "workload-a",
      model_spec_json: JSON.stringify({ name: "model-a" }),
      n_rows: 3,
      primary_metric_name: "accuracy",
      primary_metric_value: 0.75,
      per_class_metrics_json: JSON.stringify({ ok: 1 }),
      latency_p50_ms: 12.5,
      latency_p95_ms: 20.5,
      throughput_tps: 4.2,
      errors: 0,
      started_at: "2026-05-17T00:00:00.000Z",
      finished_at: "2026-05-17T00:01:00.000Z",
      host_machine: "host-a",
    };

    insertCellRow(db, row);

    expect(listCellRows(db)).toEqual([row]);
  });

  test("round-trips per-row cell details", () => {
    const db = new Database(":memory:");
    ensureMatrixSchema(db);

    const detailA: CellRowDetail = {
      run_id: "run-1",
      model_name: "model-a",
      workload_name: "workload-a",
      row_index: 0,
      prediction: "true",
      gold: "true",
      metrics_json: JSON.stringify({ exact_match: 1 }),
      latency_ms: 12.5,
    };
    const detailB: CellRowDetail = {
      ...detailA,
      row_index: 1,
      prediction: "false",
      gold: "true",
      metrics_json: JSON.stringify({ exact_match: 0 }),
      latency_ms: 13.0,
    };

    insertCellRowDetail(db, detailA);
    insertCellRowDetail(db, detailB);
    insertCellRowDetail(db, { ...detailA, latency_ms: 99.9 });

    const all = listCellRowDetails(db);
    expect(all).toHaveLength(2);
    const [first, second] = all;
    expect(first!.row_index).toBe(0);
    expect(first!.latency_ms).toBe(99.9);
    expect(second!.row_index).toBe(1);

    const filteredByRun = listCellRowDetails(db, { run_id: "run-1", workload_name: "workload-a" });
    expect(filteredByRun).toHaveLength(2);
    const filteredEmpty = listCellRowDetails(db, { run_id: "run-missing" });
    expect(filteredEmpty).toHaveLength(0);
  });
});

describe("runMatrix", () => {
  test("4way workload builds constrained response_format from valid labels", () => {
    const responseFormat = memoryEfficacy4wayWorkload.response_format as
      | {
          type?: string;
          json_schema?: {
            name?: string;
            schema?: {
              properties?: Record<string, unknown>;
            };
          };
        }
      | undefined;

    expect(responseFormat?.type).toBe("json_schema");
    expect(responseFormat?.json_schema?.name).toBe("memory_efficacy_4way");
    const schema = responseFormat?.json_schema?.schema as
      | {
          properties?: Record<string, unknown>;
          required?: string[];
          additionalProperties?: boolean;
        }
      | undefined;
    const classification = responseFormat?.json_schema?.schema?.properties?.classification as
      | { enum?: string[] }
      | undefined;
    expect(new Set(classification?.enum ?? [])).toEqual(
      new Set(["missed_registration", "recall_miss", "memory_ignored", "not_memory_related"]),
    );
    expect(schema?.required).toEqual(["classification", "reason"]);
    expect(schema?.additionalProperties).toBe(false);
  });

  test("buildJsonClassifierWorkload omits response_format when validLabels is absent", () => {
    const workload = buildJsonClassifierWorkload({
      name: "ad-hoc-json-classifier",
      corpus_path: "/tmp/unused.jsonl",
      labelField: "classification",
    });
    expect(workload.response_format).toBeUndefined();
  });

  test("buildJsonClassifierWorkload rejects empty validLabels", () => {
    expect(() =>
      buildJsonClassifierWorkload({
        name: "ad-hoc-json-classifier",
        corpus_path: "/tmp/unused.jsonl",
        labelField: "classification",
        validLabels: new Set(),
      }),
    ).toThrow("buildJsonClassifierWorkload: validLabels must contain at least one label");
  });

  test("strips markdown code fences before parsing binary memory-efficacy predictions", async () => {
    const row = {
      messages: [
        { role: "user", content: "Is this memory related?" },
        { role: "assistant", content: JSON.stringify({ memory_related: true, reason: "x" }) },
      ],
    };

    const result = await memoryEfficacyBinaryWorkload.scorer(
      row,
      '```json\n{"memory_related":true}\n```',
    );

    expect(result.prediction).toBe("true");
  });

  test("runs the binary memory-efficacy workload end to end", async () => {
    const db = new Database(":memory:");
    const tmpPath = `/tmp/memory-efficacy-binary-${randomUUID()}.jsonl`;
    const jsonl = [
      JSON.stringify({
        messages: [
          { role: "user", content: "Is this memory related?" },
          { role: "assistant", content: JSON.stringify({ memory_related: true, reason: "x" }) },
        ],
      }),
      JSON.stringify({
        messages: [
          { role: "user", content: "Is this memory related?" },
          { role: "assistant", content: JSON.stringify({ memory_related: false, reason: "y" }) },
        ],
      }),
    ].join("\n");
    await Bun.write(tmpPath, jsonl);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"memory_related":true}' } }],
          usage: { completion_tokens: 5 },
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const workload: WorkloadEval = {
        ...memoryEfficacyBinaryWorkload,
        corpus_path: tmpPath,
      };
      const run = await runMatrix({
        models: [makeModel("model-a")],
        workloads: [workload],
        db,
      });
      expect(run.cellsWritten).toBe(1);
      const rows = listCellRows(db, { run_id: run.runId });
      expect(rows).toHaveLength(1);
      const cell = rows[0];
      if (!cell) throw new Error("expected cell");
      expect(cell.runner_version).toBe(1);
      expect(cell.n_rows).toBe(2);
      expect(cell.run_id).toMatch(/^\d{4}-\d{2}-\d{2}T.+-[0-9a-f]{8}$/);
      const expected = aggregateMetrics([
        { pred: "true", gold: "true" },
        { pred: "true", gold: "false" },
      ]);
      expect(cell.primary_metric_value).toBeCloseTo(expected.macro_f1, 5);
      const details = listCellRowDetails(db, { run_id: run.runId });
      expect(details).toHaveLength(2);
      expect(details.map((d) => d.row_index)).toEqual([0, 1]);
      expect(details.every((d) => d.prediction === "true")).toBe(true);
      expect(details[0]!.gold).toBe("true");
      expect(details[1]!.gold).toBe("false");
      expect(details.every((d) => typeof d.latency_ms === "number")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      try {
        rmSync(tmpPath);
      } catch {}
    }
  });

  test("runMatrix uses an explicit runId when provided", async () => {
    const db = new Database(":memory:");
    const tmpPath = `/tmp/memory-efficacy-binary-${randomUUID()}.jsonl`;
    const jsonl = [
      JSON.stringify({
        messages: [
          { role: "user", content: "Is this memory related?" },
          { role: "assistant", content: JSON.stringify({ memory_related: true, reason: "x" }) },
        ],
      }),
    ].join("\n");
    await Bun.write(tmpPath, jsonl);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"memory_related":true}' } }],
          usage: { completion_tokens: 5 },
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const workload: WorkloadEval = {
        ...memoryEfficacyBinaryWorkload,
        corpus_path: tmpPath,
      };
      const run = await runMatrix({
        models: [makeModel("model-a")],
        workloads: [workload],
        db,
        runId: "fixed-run-id-123",
      });
      expect(run.runId).toBe("fixed-run-id-123");
      const rows = listCellRows(db, { run_id: "fixed-run-id-123" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.run_id).toBe("fixed-run-id-123");
    } finally {
      globalThis.fetch = origFetch;
      try {
        rmSync(tmpPath);
      } catch {}
    }
  });

  test("runs the 4way memory-efficacy workload end to end", async () => {
    const db = new Database(":memory:");
    const tmpPath = `/tmp/memory-efficacy-4way-${randomUUID()}.jsonl`;
    const jsonl = [
      JSON.stringify({
        messages: [
          { role: "user", content: "Is this memory related?" },
          {
            role: "assistant",
            content: JSON.stringify({ classification: "missed_registration", reason: "x" }),
          },
        ],
      }),
      JSON.stringify({
        messages: [
          { role: "user", content: "Is this memory related?" },
          {
            role: "assistant",
            content: JSON.stringify({ classification: "not_memory_related", reason: "y" }),
          },
        ],
      }),
    ].join("\n");
    await Bun.write(tmpPath, jsonl);
    const origFetch = globalThis.fetch;
    let lastRequestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: Request | string | URL, init: RequestInit | undefined) => {
      if (init && typeof init.body === "string") {
        lastRequestBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"classification":"missed_registration","reason":"x"}' } },
          ],
          usage: { completion_tokens: 5 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const workload: WorkloadEval = {
        ...memoryEfficacy4wayWorkload,
        corpus_path: tmpPath,
      };
      const run = await runMatrix({
        models: [makeModel("model-a")],
        workloads: [workload],
        db,
      });
      expect(run.cellsWritten).toBe(1);
      const rows = listCellRows(db, { run_id: run.runId });
      expect(rows).toHaveLength(1);
      const cell = rows[0];
      if (!cell) throw new Error("expected cell");
      expect(cell.runner_version).toBe(1);
      expect(cell.n_rows).toBe(2);
      expect(cell.run_id).toMatch(/^\d{4}-\d{2}-\d{2}T.+-[0-9a-f]{8}$/);
      expect(lastRequestBody?.response_format).toEqual(workload.response_format);
      const expected = aggregateMetrics([
        { pred: "missed_registration", gold: "missed_registration" },
        { pred: "missed_registration", gold: "not_memory_related" },
      ]);
      expect(cell.primary_metric_value).toBeCloseTo(expected.macro_f1, 5);
    } finally {
      globalThis.fetch = origFetch;
      try {
        rmSync(tmpPath);
      } catch {}
    }
  });

  test("runMatrix does not forward response_format when model opts out of structured outputs", async () => {
    const db = new Database(":memory:");
    const tmpPath = `/tmp/memory-efficacy-4way-${randomUUID()}.jsonl`;
    const jsonl = [
      JSON.stringify({
        messages: [
          { role: "user", content: "Is this memory related?" },
          {
            role: "assistant",
            content: JSON.stringify({ classification: "missed_registration", reason: "x" }),
          },
        ],
      }),
    ].join("\n");
    await Bun.write(tmpPath, jsonl);
    const origFetch = globalThis.fetch;
    let lastRequestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: Request | string | URL, init: RequestInit | undefined) => {
      if (init && typeof init.body === "string") {
        lastRequestBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"classification":"missed_registration","reason":"x"}' } },
          ],
          usage: { completion_tokens: 5 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const workload: WorkloadEval = {
        ...memoryEfficacy4wayWorkload,
        corpus_path: tmpPath,
      };
      const run = await runMatrix({
        models: [{ ...makeModel("model-a"), structured_outputs_supported: false }],
        workloads: [workload],
        db,
      });
      expect(run.cellsWritten).toBe(1);
      expect(lastRequestBody?.response_format).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
      try {
        rmSync(tmpPath);
      } catch {}
    }
  });
});

describe("matrix CLI", () => {
  test("parseArgs defaults concurrency to 1", () => {
    const args = parseArgs([
      "--models",
      "/tmp/m.json",
      "--workloads",
      "memory-efficacy-binary",
      "--out-db",
      "/tmp/x.db",
    ]);
    expect(args.concurrency).toBe(1);
  });

  test("parseArgs accepts --concurrency within [1,8]", () => {
    const args = parseArgs([
      "--models",
      "/tmp/m.json",
      "--workloads",
      "memory-efficacy-binary",
      "--out-db",
      "/tmp/x.db",
      "--concurrency",
      "4",
    ]);
    expect(args.concurrency).toBe(4);
  });

  test("parseArgs rejects --concurrency outside [1,8]", () => {
    expect(() =>
      parseArgs([
        "--models",
        "/tmp/m.json",
        "--workloads",
        "memory-efficacy-binary",
        "--out-db",
        "/tmp/x.db",
        "--concurrency",
        "0",
      ]),
    ).toThrow("--concurrency must be an integer between 1 and 8");
    expect(() =>
      parseArgs([
        "--models",
        "/tmp/m.json",
        "--workloads",
        "memory-efficacy-binary",
        "--out-db",
        "/tmp/x.db",
        "--concurrency",
        "9",
      ]),
    ).toThrow("--concurrency must be an integer between 1 and 8");
  });

  test("rejects --run-id together with --report-all-runs", () => {
    expect(() =>
      parseArgs([
        "--run-id",
        "foo",
        "--report-all-runs",
        "--models",
        "/tmp/empty.json",
        "--workloads",
        "memory-efficacy-binary",
        "--out-db",
        "/tmp/nope.db",
      ]),
    ).toThrow("--run-id and --report-all-runs are mutually exclusive");
  });

  test("parseCorpusOverrides parses one entry", () => {
    const m = parseCorpusOverrides("tool-call-grammar=/tmp/foo.jsonl");
    expect(m.size).toBe(1);
    expect(m.get("tool-call-grammar")).toBe("/tmp/foo.jsonl");
  });

  test("parseCorpusOverrides parses comma-separated entries", () => {
    const m = parseCorpusOverrides("tool-call-grammar=/tmp/a.jsonl,memory-recall=/tmp/b.jsonl");
    expect(m.size).toBe(2);
    expect(m.get("tool-call-grammar")).toBe("/tmp/a.jsonl");
    expect(m.get("memory-recall")).toBe("/tmp/b.jsonl");
  });

  test("parseCorpusOverrides rejects malformed entries", () => {
    expect(() => parseCorpusOverrides("no-equals-sign")).toThrow(
      "--corpus-override entry must be workload=path",
    );
    expect(() => parseCorpusOverrides("=/tmp/x.jsonl")).toThrow(
      "--corpus-override entry must be workload=path",
    );
    expect(() => parseCorpusOverrides("foo=")).toThrow(
      "--corpus-override entry must be workload=path",
    );
  });

  test("parseCorpusOverrides rejects duplicate workload keys", () => {
    expect(() => parseCorpusOverrides("foo=/a,foo=/b")).toThrow(
      "duplicate entry for workload: foo",
    );
  });

  test("parseArgs threads --corpus-override into MatrixCliArgs", () => {
    const args = parseArgs([
      "--models",
      "/tmp/m.json",
      "--workloads",
      "memory-efficacy-binary",
      "--out-db",
      "/tmp/x.db",
      "--corpus-override",
      "memory-efficacy-binary=/tmp/alt.jsonl",
    ]);
    expect(args.corpusOverrides?.get("memory-efficacy-binary")).toBe("/tmp/alt.jsonl");
  });

  test("runMatrix throws on empty models list", async () => {
    const db = new Database(":memory:");
    await expect(
      runMatrix({ models: [], workloads: [memoryEfficacyBinaryWorkload], db }),
    ).rejects.toThrow("models list is empty");
  });

  test("runMatrix throws on empty workloads list", async () => {
    const db = new Database(":memory:");
    await expect(runMatrix({ models: [makeModel("m")], workloads: [], db })).rejects.toThrow(
      "workloads list is empty",
    );
  });

  test("runMatrix concurrency preserves row attribution and metrics", async () => {
    const dbSeq = new Database(":memory:");
    const dbPar = new Database(":memory:");
    const tmpPath = `/tmp/matrix-concurrency-${randomUUID()}.jsonl`;
    const rows = [
      { prompt: "p0", answer: "A" },
      { prompt: "p1", answer: "B" },
      { prompt: "p2", answer: "C" },
      { prompt: "p3", answer: "D" },
    ];
    await Bun.write(tmpPath, rows.map((row) => JSON.stringify(row)).join("\n"));

    const origFetch = globalThis.fetch;
    const delays = [80, 10, 60, 20];
    let inflight = 0;
    let peakInflight = 0;
    globalThis.fetch = (async (_url: Request | string | URL, init: RequestInit | undefined) => {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userMessage = (messages[0] as { content?: string } | undefined)?.content ?? "";
      const match = /p(\d+)/.exec(userMessage);
      const idx = Number(match?.[1] ?? "0");
      inflight += 1;
      peakInflight = Math.max(peakInflight, inflight);
      await Bun.sleep(delays[idx] ?? 5);
      inflight -= 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: rows[idx]?.answer ?? "" } }],
          usage: { completion_tokens: 10 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const workload: WorkloadEval = {
      name: "concurrency-test",
      corpus_path: tmpPath,
      prompt_builder: (row) => {
        const typed = row as { prompt: string };
        return {
          messages: [{ role: "user", content: typed.prompt }],
        };
      },
      scorer: (row, completion) => {
        const typed = row as { answer: string };
        const exact = completion.trim() === typed.answer ? 1 : 0;
        return {
          metrics: { exact_match: exact },
          prediction: completion.trim(),
          gold: typed.answer,
        };
      },
      primary_metric_name: "mean_exact_match",
    };

    try {
      const seq = await runMatrix({
        models: [makeModel("model-a")],
        workloads: [workload],
        db: dbSeq,
        concurrency: 1,
      });
      const par = await runMatrix({
        models: [makeModel("model-a")],
        workloads: [workload],
        db: dbPar,
        concurrency: 2,
      });

      const seqCell = listCellRows(dbSeq, { run_id: seq.runId })[0];
      const parCell = listCellRows(dbPar, { run_id: par.runId })[0];
      expect(seqCell?.primary_metric_value).toBe(1);
      expect(parCell?.primary_metric_value).toBe(seqCell?.primary_metric_value);

      const details = listCellRowDetails(dbPar, { run_id: par.runId });
      expect(details).toHaveLength(4);
      expect(details.map((d) => d.row_index)).toEqual([0, 1, 2, 3]);
      expect(details.map((d) => d.prediction)).toEqual(["A", "B", "C", "D"]);
      expect(peakInflight).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = origFetch;
      try {
        rmSync(tmpPath);
      } catch {}
    }
  });
});
