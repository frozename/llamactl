import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureModelServing,
  listCellRows,
  type ModelSpec,
  runMatrix,
  waitForHealthyBoot,
  type WorkloadEval,
} from "../src/index.js";
import { memoryEfficacyBinaryWorkload } from "../src/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

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
      expect(perClass["error"]).toBe("corpus_load_failed");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("ensureModelServing spawn error", () => {
  test("spawn error rejects fast without health calls after failure settles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-spawn-err-"));
    const notExecPath = join(dir, "not-executable");
    writeFileSync(notExecPath, "#!/bin/sh\necho hi\n", { mode: 0o600 });
    const origFetch = globalThis.fetch;
    const callsAfterFailure: string[] = [];
    let failureSettled = false;
    globalThis.fetch = Object.assign((input: Request | string | URL): Promise<Response> => {
      if (failureSettled) {
        callsAfterFailure.push(input instanceof Request ? input.url : input.toString());
      }
      return Promise.reject(new Error("ECONNREFUSED"));
    }, origFetch);

    const start = Date.now();
    try {
      let failure: unknown;
      try {
        await ensureModelServing({
          ...makeModel("spawn-error-test", 65503),
          managed: true,
          binary: notExecPath,
          start_args: [],
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("failed to spawn spawn-error-test");
      expect(Date.now() - start).toBeLessThan(5000);
      failureSettled = true;
      // Cross the existing one-second poll interval after the caller has its failure.
      await Bun.sleep(1250);
      expect(callsAfterFailure).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawn error aborts and settles an in-flight health check before rejecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-spawn-pending-"));
    const notExecPath = join(dir, "not-executable");
    writeFileSync(notExecPath, "#!/bin/sh\necho hi\n", { mode: 0o600 });
    const origFetch = globalThis.fetch;
    let calls = 0;
    let aborted = false;
    let settled = false;
    globalThis.fetch = Object.assign(
      (_input: Request | string | URL, init?: RequestInit): Promise<Response> => {
        if (++calls === 1) return Promise.reject(new Error("ECONNREFUSED"));
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => {
            aborted = true;
            reject(new Error("health request aborted"));
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }).finally(() => {
          settled = true;
        });
      },
      origFetch,
    );
    try {
      let failure: unknown;
      try {
        await ensureModelServing({
          ...makeModel("spawn-error-pending", 65503),
          managed: true,
          binary: notExecPath,
          start_args: [],
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("failed to spawn spawn-error-pending");
      expect(calls).toBe(2);
      expect(aborted).toBe(true);
      expect(settled).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("waitForHealthyBoot caller abort", () => {
  // The boot-probe abort point sits between spawn and ownedProcs.add, so a
  // caller abort that only rethrows leaves the detached server running without
  // ever becoming teardown-able.
  test("aborted caller signal SIGTERMs the spawned process group and rejects with the abort reason", async () => {
    const proc = spawn("/bin/sleep", ["600"], { stdio: "pipe", detached: true });
    const pid = proc.pid;
    expect(pid).toBeDefined();
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/health")) return Promise.resolve(new Response("ok", { status: 200 }));
      if (url.endsWith("/v1/chat/completions")) {
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => {
            reject(new Error("boot-probe aborted"));
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }) as unknown as typeof fetch;
    try {
      const controller = new AbortController();
      const boot = waitForHealthyBoot(
        { name: "abort-test", host: "127.0.0.1", port: 65503 } as unknown as ModelSpec,
        proc,
        [],
        controller.signal,
      );
      // Let /health pass so the boot is parked inside the never-ready /v1 probe.
      await Bun.sleep(100);
      const abortReason = new Error("operator aborted boot");
      controller.abort(abortReason);
      let failure: unknown;
      try {
        await boot;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(abortReason);
      expect(await waitUntil(() => !isAlive(pid!), 4000)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Safety-net cleanup is best effort after assertions fail.
        }
      }
    }
  }, 15_000);
});
