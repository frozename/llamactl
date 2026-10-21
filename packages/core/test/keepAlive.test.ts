import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { join } from "node:path";

import {
  keepAliveLogFile,
  keepAlivePidFile,
  keepAliveStateFile,
  keepAliveStatus,
  keepAliveStopFile,
  readKeepAlivePid,
  readKeepAliveState,
  runKeepAliveWorker,
  sleepWithAbort,
  stopKeepAlive,
} from "../src/keepAlive.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

describe("keepAlive path helpers", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("paths land under runtime dir", () => {
    expect(keepAlivePidFile()).toBe(join(temp.runtimeDir, "llama-keep-alive.pid"));
    expect(keepAliveStopFile()).toBe(join(temp.runtimeDir, "llama-keep-alive.stop"));
    expect(keepAliveStateFile()).toBe(join(temp.runtimeDir, "llama-keep-alive.state"));
  });

  test("log file lives under $LLAMA_CPP_LOGS", () => {
    expect(keepAliveLogFile()).toContain("keep-alive.log");
  });
});

describe("keepAlive state parsing", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("readKeepAliveState returns null when the file is absent", () => {
    expect(readKeepAliveState()).toBeNull();
  });

  test("parses the shell-compat state-file key=value format", () => {
    writeFileSync(
      keepAliveStateFile(),
      [
        "updated_at=2026-04-17T12:00:00-0300",
        "target=current",
        "model=Demo/demo.gguf",
        "state=ready",
        "restarts=2",
        "backoff_seconds=4",
        "log=/var/log/keep-alive.log",
      ].join("\n"),
    );
    const state = readKeepAliveState();
    expect(state?.state).toBe("ready");
    expect(state?.restarts).toBe(2);
    expect(state?.model).toBe("Demo/demo.gguf");
  });
});

describe("keepAliveStatus", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("reports not running when no pid file exists", () => {
    const status = keepAliveStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  test("clears a stale pid file referencing a dead process", () => {
    writeFileSync(keepAlivePidFile(), "999999\n");
    const status = keepAliveStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(existsSync(keepAlivePidFile())).toBe(false);
  });
});

describe("sleepWithAbort", () => {
  test("detaches the abort listener on the timer path (balanced add/remove)", async () => {
    const controller = new AbortController();
    const addSpy = spyOn(controller.signal, "addEventListener");
    const removeSpy = spyOn(controller.signal, "removeEventListener");

    // tiny duration so the real timer fires fast; controller never aborts.
    await sleepWithAbort(0.001, controller.signal);

    // Listener registered exactly once and removed exactly once: no leak.
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  test("resolves and clears the timer on the abort path", async () => {
    const controller = new AbortController();
    const clearSpy = spyOn(globalThis, "clearTimeout");
    try {
      // long timer so abort is what resolves the promise.
      const p = sleepWithAbort(60, controller.signal);
      controller.abort();
      let settled = false;
      await p.then(() => {
        settled = true;
      });
      expect(settled).toBe(true);
      // onAbort must cancel the pending 60s timer, not just resolve.
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });

  test("resolves on timer with no signal", async () => {
    let settled = false;
    await sleepWithAbort(0.001).then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
  });
});

describe("stopKeepAlive", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("no-op when there is nothing running", async () => {
    const result = await stopKeepAlive({ key: { name: "test-wl" } });
    expect(result.stopped).toBe(true);
    expect(result.killed).toBe(false);
    expect(existsSync(keepAliveStopFile())).toBe(false);
  });

  test("cleans stale pid files without a running process", async () => {
    writeFileSync(keepAlivePidFile(), "999999\n");
    const result = await stopKeepAlive({ key: { name: "test-wl" } });
    expect(result.stopped).toBe(true);
    expect(readKeepAlivePid()).toBeNull();
  });
});

describe("runKeepAliveWorker", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("records a host-bind refusal as start-failed and backs off", async () => {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env["LLAMA_CPP_BIN"] = binDir;
    process.env["LLAMA_CPP_HOST"] = "0.0.0.0";
    process.env["LLAMA_CPP_PORT"] = "65534";

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.reject(new Error("connection refused"))) as unknown as typeof fetch);
    const spawnSpy = spyOn(childProcess, "spawn");

    const controller = new AbortController();
    let spawnCalls = -1;
    let state = readKeepAliveState();
    let escaped: unknown = null;
    try {
      const worker = runKeepAliveWorker({
        key: { name: "test-wl" },
        target: "Demo/demo.gguf",
        signal: controller.signal,
      }).catch((error: unknown) => {
        escaped = error;
      });
      // The first backoff is a full second, so polling sees start-failed before the loop retries.
      for (let i = 0; i < 300 && state?.state !== "start-failed"; i += 1) {
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
    expect(escaped).toBeNull();
    expect(state?.state).toBe("start-failed");
    expect(state?.restarts).toBe(1);
    expect(readFileSync(keepAliveLogFile(), "utf8")).toContain(
      "start-failed rel=Demo/demo.gguf error=refusing to bind llama-server to 0.0.0.0",
    );
    expect(spawnCalls).toBe(0);
  });
});
