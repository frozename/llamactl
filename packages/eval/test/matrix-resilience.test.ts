import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureModelServing,
  listCellRows,
  type ModelSpec,
  runMatrix,
  type WorkloadEval,
} from "../src/index.js";
import { memoryEfficacyBinaryWorkload } from "../src/index.js";

function makeModel(name: string, port = 8080): ModelSpec {
  return {
    name,
    gguf_path: `/models/${name}.gguf`,
    quant: "Q4",
    family: "test",
    size_params: "1b",
    host: "127.0.0.1",
    port,
    extra_args: [],
  };
}

const CORPUS_ROW = JSON.stringify({
  messages: [
    { role: "user", content: "Is this memory related?" },
    { role: "assistant", content: JSON.stringify({ memory_related: true, reason: "x" }) },
  ],
});

describe("runMatrix resilience", () => {
  test("judge boot failure records error cell and run continues to next workload", async () => {
    const db = new Database(":memory:");
    const tmpPath = `/tmp/matrix-judge-boot-${randomUUID().slice(0, 8)}.jsonl`;
    await Bun.write(tmpPath, CORPUS_ROW);

    const origFetch = globalThis.fetch;
    globalThis.fetch = ((url: Request | string | URL) => {
      const urlStr = url instanceof Request ? url.url : url.toString();
      if (urlStr.includes(":8080/health"))
        return Promise.resolve(new Response("ok", { status: 200 }));
      if (urlStr.includes(":8080/v1/"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"memory_related":true}' } }],
              usage: { completion_tokens: 5 },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as unknown as typeof fetch;

    const judgeModel: ModelSpec = {
      name: "judge-nonexistent",
      gguf_path: "/no/judge.gguf",
      quant: "Q4",
      family: "test",
      size_params: "1b",
      host: "127.0.0.1",
      port: 9199,
      managed: true,
      binary: "/nonexistent-judge-binary-abc123",
      extra_args: [],
    };

    const workloadWithJudge: WorkloadEval = {
      ...memoryEfficacyBinaryWorkload,
      name: "wl-with-judge",
      corpus_path: tmpPath,
      judge_model: judgeModel,
    };
    const workloadNoJudge: WorkloadEval = {
      ...memoryEfficacyBinaryWorkload,
      name: "wl-no-judge",
      corpus_path: tmpPath,
    };

    try {
      // Must not throw even though the judge for the first workload fails to boot.
      const run = await runMatrix({
        models: [makeModel("model-a")],
        workloads: [workloadWithJudge, workloadNoJudge],
        db,
      });

      // Both workloads must have a cell written — the run must not abort on judge failure.
      expect(run.cellsWritten).toBe(2);

      const rows = listCellRows(db, { run_id: run.runId });
      expect(rows).toHaveLength(2);

      const judgeRow = rows.find((r) => r.workload_name === "wl-with-judge");
      const normalRow = rows.find((r) => r.workload_name === "wl-no-judge");
      expect(judgeRow).toBeDefined();
      expect(normalRow).toBeDefined();

      // The judge-boot failure cell must be flagged as an error.
      expect(judgeRow!.errors).toBeGreaterThan(0);

      // The subsequent workload (no judge) must have run normally.
      expect(normalRow!.n_rows).toBeGreaterThan(0);
      expect(normalRow!.errors).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
      try {
        rmSync(tmpPath);
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  test("total corpus load failure records distinguishable error cell, not a real 0 score", async () => {
    const db = new Database(":memory:");

    const origFetch = globalThis.fetch;
    // Health check passes so ensureModelServing returns without spawning.
    globalThis.fetch = (() =>
      Promise.resolve(new Response("ok", { status: 200 }))) as unknown as typeof fetch;

    const workload: WorkloadEval = {
      ...memoryEfficacyBinaryWorkload,
      corpus_path: "/nonexistent-corpus-path-that-will-never-exist.jsonl",
    };

    try {
      const run = await runMatrix({
        models: [makeModel("model-a")],
        workloads: [workload],
        db,
      });

      expect(run.cellsWritten).toBe(1);
      const rows = listCellRows(db, { run_id: run.runId });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // A corpus-load failure must not be mistaken for a model that scored 0.
      expect(row.n_rows).toBe(0);
      expect(row.errors).toBeGreaterThan(0);
      // primary_metric_value must not be 0 (indistinguishable from a real zero score).
      expect(row.primary_metric_value).not.toBe(0);
      // per_class_metrics_json must carry a machine-readable error indicator.
      const perClass = JSON.parse(row.per_class_metrics_json) as Record<string, unknown>;
      expect(perClass.error).toBe("corpus_load_failed");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("ensureModelServing spawn error", () => {
  test("spawn 'error' event rejects promise fast without hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-spawn-err-"));
    const notExecPath = join(dir, "not-executable");
    // Write a file without the execute bit — existsSync returns true but spawn
    // fails with EACCES, which emits an 'error' event on the ChildProcess.
    writeFileSync(notExecPath, "#!/bin/sh\necho hi\n");

    const origFetch = globalThis.fetch;
    // Health check always fails so ensureModelServing tries to spawn.
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

    const start = Date.now();
    try {
      await ensureModelServing({
        name: "spawn-error-test",
        gguf_path: "/tmp/none.gguf",
        quant: "Q4",
        family: "test",
        size_params: "1b",
        host: "127.0.0.1",
        port: 65503,
        managed: true,
        binary: notExecPath,
        start_args: [],
        extra_args: [],
      });
      throw new Error("expected ensureModelServing to reject");
    } catch (err) {
      const elapsed = Date.now() - start;
      expect(err).toBeInstanceOf(Error);
      // Pre-fix: the 'error' event had no listener — it escaped as an uncaught
      // exception or the 120 s health timeout fired. Post-fix: fast rejection.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
