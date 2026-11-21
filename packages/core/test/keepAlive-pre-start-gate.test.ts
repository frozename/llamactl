// Part of #517 — RED tests pinning the pre-start gate in
// `runKeepAliveWorker`. At the pinned base the worker has no `beforeStart`
// option: it resolves the target, logs "starting server for rel=", calls
// startServer, and records start-failed on the 0.0.0.0 bind refusal. Post-fix
// the gate is consulted after resolveTarget and before the "starting" log +
// startServer on every loop iteration: a string reason records state
// start-refused with log `start-refused rel=<rel> reason=<reason>` and
// restarts stays 0, a throw records `pre-start gate failed (<message>)`, and
// null falls through to the unchanged start path. Everything is hermetic:
// temp dirs, a stub llama-server that is never spawned, a rejecting fetch
// mock, and an AbortController driving the loop.
import type { Mock } from "bun:test";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { join } from "node:path";

import {
  keepAliveLogFile,
  readKeepAliveState,
  runKeepAliveWorker,
  sleepWithAbort,
} from "../src/keepAlive.js";
import { mkdirSync, readFileSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

describe("runKeepAliveWorker pre-start gate", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env["LLAMA_CPP_BIN"] = binDir;
    process.env["LLAMA_CPP_HOST"] = "0.0.0.0";
    process.env["LLAMA_CPP_PORT"] = "65534";
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  // Bun's `typeof fetch` carries a preconnect property, so a bare arrow is
  // not assignable; Object.assign keeps the call signature without a cast.
  function armSpies(): {
    fetchSpy: Mock<typeof fetch>;
    spawnSpy: Mock<typeof childProcess.spawn>;
  } {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign((): Promise<Response> => Promise.reject(new Error("connection refused")), {
        preconnect: (): void => undefined,
      }),
    );
    const spawnSpy = spyOn(childProcess, "spawn");
    return { fetchSpy, spawnSpy };
  }

  function stateName(state: ReturnType<typeof readKeepAliveState>): string | undefined {
    return state?.state;
  }

  // Kills: the gate is ignored, or it is consulted after startServer. At the
  // base the option is ignored and the state becomes start-failed.
  test("K1: a refusing gate records start-refused and never reaches startServer", async () => {
    const calls: string[] = [];
    const { fetchSpy, spawnSpy } = armSpies();
    const controller = new AbortController();
    let state = readKeepAliveState();
    let escaped: unknown = null;
    let spawnCalls = -1;
    try {
      const worker = runKeepAliveWorker({
        key: { name: "test-wl" },
        target: "Demo/demo.gguf",
        intervalSeconds: 1,
        maxBackoff: 1,
        signal: controller.signal,
        beforeStart: (rel: string) => {
          calls.push(rel);
          return "held by qwen-prod";
        },
      }).catch((error: unknown) => {
        escaped = error;
      });
      for (let i = 0; i < 300 && stateName(state) !== "start-refused"; i += 1) {
        await sleepWithAbort(0.01);
        state = readKeepAliveState();
      }
      controller.abort();
      await worker;
    } finally {
      spawnCalls = spawnSpy.mock.calls.length;
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
    const log = readFileSync(keepAliveLogFile(), "utf8");
    expect(escaped).toBeNull();
    expect(stateName(state)).toBe("start-refused");
    expect(state?.restarts).toBe(0);
    expect(calls[0]).toBe("Demo/demo.gguf");
    expect(log).toContain("start-refused rel=Demo/demo.gguf reason=held by qwen-prod");
    expect(log).not.toContain("starting server for rel=");
    expect(log).not.toContain("start-failed");
    expect(spawnCalls).toBe(0);
  }, 20_000);

  // Kills: a throwing gate escaping the loop, or a throw treated as allow.
  test("K2: a throwing gate records start-refused with the gate failure reason", async () => {
    const { fetchSpy, spawnSpy } = armSpies();
    const controller = new AbortController();
    let state = readKeepAliveState();
    let escaped: unknown = null;
    let spawnCalls = -1;
    try {
      const worker = runKeepAliveWorker({
        key: { name: "test-wl" },
        target: "Demo/demo.gguf",
        intervalSeconds: 1,
        maxBackoff: 1,
        signal: controller.signal,
        beforeStart: () => {
          throw new Error("boom");
        },
      }).catch((error: unknown) => {
        escaped = error;
      });
      for (let i = 0; i < 300 && stateName(state) !== "start-refused"; i += 1) {
        await sleepWithAbort(0.01);
        state = readKeepAliveState();
      }
      controller.abort();
      await worker;
    } finally {
      spawnCalls = spawnSpy.mock.calls.length;
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
    const log = readFileSync(keepAliveLogFile(), "utf8");
    expect(escaped).toBeNull();
    expect(stateName(state)).toBe("start-refused");
    expect(log).toContain("start-refused rel=Demo/demo.gguf reason=pre-start gate failed (boom)");
    expect(spawnCalls).toBe(0);
  }, 20_000);

  // Kills: a gate consulted only once before the loop instead of before
  // every start or restart.
  test("K3: the gate is consulted before every start attempt", async () => {
    const calls: string[] = [];
    const { fetchSpy, spawnSpy } = armSpies();
    const controller = new AbortController();
    let escaped: unknown = null;
    let spawnCalls = -1;
    try {
      const worker = runKeepAliveWorker({
        key: { name: "test-wl" },
        target: "Demo/demo.gguf",
        intervalSeconds: 1,
        maxBackoff: 1,
        signal: controller.signal,
        beforeStart: (rel: string) => {
          calls.push(rel);
          return "held by qwen-prod";
        },
      }).catch((error: unknown) => {
        escaped = error;
      });
      for (let i = 0; i < 300 && calls.length < 2; i += 1) {
        await sleepWithAbort(0.01);
      }
      controller.abort();
      await worker;
    } finally {
      spawnCalls = spawnSpy.mock.calls.length;
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
    expect(escaped).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const rel of calls) {
      expect(rel).toBe("Demo/demo.gguf");
    }
    expect(spawnCalls).toBe(0);
  }, 20_000);

  // Kills: an inverted gate result. Control: passes at the base too — a null
  // gate result falls through to startServer, whose 0.0.0.0 bind refusal is
  // recorded as start-failed. `calls` stays empty at the base (the option is
  // ignored there), so the per-entry check is vacuous until the gate exists.
  test("K4: a null gate result falls through to the unchanged start path", async () => {
    const calls: string[] = [];
    const { fetchSpy, spawnSpy } = armSpies();
    const controller = new AbortController();
    let state = readKeepAliveState();
    let escaped: unknown = null;
    let spawnCalls = -1;
    try {
      const worker = runKeepAliveWorker({
        key: { name: "test-wl" },
        target: "Demo/demo.gguf",
        intervalSeconds: 1,
        maxBackoff: 1,
        signal: controller.signal,
        beforeStart: (rel: string) => {
          calls.push(rel);
          return null;
        },
      }).catch((error: unknown) => {
        escaped = error;
      });
      for (let i = 0; i < 300 && stateName(state) !== "start-failed"; i += 1) {
        await sleepWithAbort(0.01);
        state = readKeepAliveState();
      }
      controller.abort();
      await worker;
    } finally {
      spawnCalls = spawnSpy.mock.calls.length;
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
    const log = readFileSync(keepAliveLogFile(), "utf8");
    expect(escaped).toBeNull();
    expect(stateName(state)).toBe("start-failed");
    expect(log).toContain(
      "start-failed rel=Demo/demo.gguf error=refusing to bind llama-server to 0.0.0.0",
    );
    expect(spawnCalls).toBe(0);
    for (const rel of calls) {
      expect(rel).toBe("Demo/demo.gguf");
    }
  }, 20_000);
});
