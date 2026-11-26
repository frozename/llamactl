// Part of #517 — RED test pinning the cleanup stop seam in
// `runKeepAliveWorker`. At the pinned base `cleanupWorker` calls stopServer
// directly, so the injected stop is never observed. Post-fix the worker
// accepts a `stop` option symmetric with `start` and invokes exactly
// `(stop ?? stopServer)({ key, resolved })`, letting the CLI wrap the cleanup
// stop in the residency lifecycle without moving adapter code into core.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { StartServerResult, StopServerOptions, StopServerResult } from "../src/server.js";
import type { WorkloadKey } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { readKeepAliveState, runKeepAliveWorker, sleepWithAbort } from "../src/keepAlive.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

describe("runKeepAliveWorker cleanup stop seam", () => {
  let temp: ReturnType<typeof makeTempRuntime>;

  beforeEach(() => {
    temp = makeTempRuntime();
    mkdirSync(temp.runtimeDir, { recursive: true });
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
  });

  afterEach(() => {
    temp.cleanup();
  });

  // Kills: cleanupWorker calling stopServer directly instead of the injected
  // stop seam. At the base the fake is never called; post-fix it is called
  // exactly once with the same key and resolved env the worker received.
  test("C1: cleanupWorker uses the injected stop seam once with the worker key and resolved env", async () => {
    const env = envForTemp(temp);
    const resolved = resolveEnv(env);
    const key: WorkloadKey = { name: "test-wl" };
    const stopCalls: StopServerOptions[] = [];
    const controller = new AbortController();
    const start = (): Promise<StartServerResult> =>
      Promise.resolve({
        ok: false,
        pid: null,
        endpoint: "http://127.0.0.1:65534",
        advertisedEndpoint: "http://127.0.0.1:65534",
        tunedProfile: null,
        retried: false,
        error: "injected start failure",
      });
    const stop = (input: StopServerOptions): Promise<StopServerResult> => {
      stopCalls.push(input);
      return Promise.resolve({ stopped: true, pid: null, killed: false });
    };
    const opts = {
      key,
      target: "Demo/demo.gguf",
      resolved,
      env,
      intervalSeconds: 1,
      maxBackoff: 1,
      signal: controller.signal,
      start,
      stop,
    } as Parameters<typeof runKeepAliveWorker>[0];

    const worker = runKeepAliveWorker(opts);
    let state = readKeepAliveState(resolved);
    for (let i = 0; i < 300 && state?.state !== "start-failed"; i += 1) {
      await sleepWithAbort(0.01);
      state = readKeepAliveState(resolved);
    }
    controller.abort();
    await worker;

    expect(state?.state).toBe("start-failed");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.key).toEqual(key);
    expect(stopCalls[0]?.resolved).toBe(resolved);
  }, 20_000);
});
