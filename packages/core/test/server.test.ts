import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import {
  advertisedEndpoint,
  endpoint,
  filterProfileArgs,
  hasFlag,
  readServerPid,
  readServerState,
  serverStatus,
  startServer,
  stopServer,
} from "../src/server.js";
import { ensureWorkloadRuntimeDir, workloadRuntimeDir } from "../src/workloadRuntime.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const TEST_KEY = { name: "test-wl" };

function mockSpawnedProcess(pid: number): childProcess.ChildProcessWithoutNullStreams {
  return {
    pid,
    unref: () => undefined,
  } as unknown as childProcess.ChildProcessWithoutNullStreams;
}

function mockSpawnImplementation(pid: number): typeof childProcess.spawn {
  return (() => mockSpawnedProcess(pid)) as unknown as typeof childProcess.spawn;
}

function mockReadinessFetch(): ReturnType<typeof spyOn<typeof globalThis, "fetch">> {
  let fetchCalls = 0;
  return spyOn(globalThis, "fetch").mockImplementation((() => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return Promise.reject(new Error("connection refused"));
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as unknown as typeof fetch);
}

describe("server.endpoint", () => {
  test("builds an http URL from host + port", () => {
    expect(endpoint({ LLAMA_CPP_HOST: "127.0.0.1", LLAMA_CPP_PORT: "9876" } as ResolvedEnv)).toBe(
      "http://127.0.0.1:9876",
    );
  });
});

describe("server.readServerPid", () => {
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

  test("returns null when the file is missing", () => {
    expect(readServerPid(TEST_KEY)).toBeNull();
  });

  test("parses a valid PID file", () => {
    const dir = ensureWorkloadRuntimeDir(resolveEnv(), TEST_KEY);
    writeFileSync(join(dir, "llama-server.pid"), "42\n");
    expect(readServerPid(TEST_KEY)).toBe(42);
  });

  test("returns null for a malformed PID file", () => {
    const dir = ensureWorkloadRuntimeDir(resolveEnv(), TEST_KEY);
    writeFileSync(join(dir, "llama-server.pid"), "not-a-number");
    expect(readServerPid(TEST_KEY)).toBeNull();
  });
});

describe("server.serverStatus", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    // Point host/port at an address that will refuse connections so the
    // health probe deterministically reports unreachable.
    process.env.LLAMA_CPP_HOST = "127.0.0.1";
    process.env.LLAMA_CPP_PORT = "1";
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("reports down when no PID and endpoint is unreachable", async () => {
    const status = await serverStatus(TEST_KEY);
    expect(status.state).toBe("down");
    expect(status.pid).toBeNull();
    expect(status.health.reachable).toBe(false);
  });

  test("clears a stale PID file when the process is not alive", async () => {
    const dir = ensureWorkloadRuntimeDir(resolveEnv(), TEST_KEY);
    writeFileSync(join(dir, "llama-server.pid"), "999999\n");
    const status = await serverStatus(TEST_KEY);
    expect(status.pid).toBeNull();
    // Stale file should have been removed.
    expect(readServerPid(TEST_KEY)).toBeNull();
  });
});

describe("server.startServer (error paths)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    process.env.LLAMA_CPP_BIN = join(temp.devStorage, "nonexistent-bin");
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("errors when the target does not resolve", async () => {
    const result = await startServer({ key: TEST_KEY, target: "not-a-real-alias" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown target/);
  });

  test("errors when the model file is missing on disk", async () => {
    // resolveTarget accepts rel-style strings verbatim.
    const result = await startServer({ key: TEST_KEY, target: "Demo/demo.gguf" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Model file not found/);
  });

  test("errors when llama-server binary is missing", async () => {
    // Stand up the model so we get past the model check.
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const result = await startServer({ key: TEST_KEY, target: "Demo/demo.gguf" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/llama-server binary not found/);
  });

  test("detects port collision before spawn + names the foreign HTTP code", async () => {
    // Stand up everything past the binary check, then bind a fake
    // HTTP answer on the configured port so the pre-flight detector
    // sees a response and bails before launching llama-server.
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env.LLAMA_CPP_BIN = binDir;
    const port = 29143;
    process.env.LLAMA_CPP_PORT = String(port);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );
    try {
      const result = await startServer({ key: TEST_KEY, target: "Demo/demo.gguf" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/already bound/);
      expect(result.error).toMatch(/HTTP 401/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("uses a manifest endpoint override for launch args and readiness", async () => {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env.LLAMA_CPP_BIN = binDir;
    process.env.LLAMA_CPP_HOST = "127.0.0.1";
    process.env.LLAMA_CPP_PORT = "8080";

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
      mockSpawnImplementation(12345),
    );
    const fetchSpy = mockReadinessFetch();

    try {
      const result = await startServer({
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        endpoint: { host: "127.0.0.1", port: 8181 },
      });
      expect(result.ok).toBe(true);
      expect(result.endpoint).toBe("http://127.0.0.1:8181");
      expect(spawnSpy).toHaveBeenCalled();
      const fullArgs = spawnSpy.mock.calls[0]?.[1] ?? [];
      expect(fullArgs).toContain("--host");
      expect(fullArgs).toContain("127.0.0.1");
      expect(fullArgs).toContain("--port");
      expect(fullArgs).toContain("8181");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:8181/health",
        expect.objectContaining({ method: "GET" }),
      );
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("writes raw extraArgs and resolved slotSavePath to the sidecar", async () => {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env.LLAMA_CPP_BIN = binDir;
    process.env.LLAMA_CPP_HOST = "127.0.0.1";
    process.env.LLAMA_CPP_PORT = "8081";

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
      mockSpawnImplementation(process.pid),
    );
    const fetchSpy = mockReadinessFetch();

    try {
      const result = await startServer({
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        extraArgs: ["--slot-save-path", "auto"],
      });
      expect(result.ok).toBe(true);
      const state = readServerState(TEST_KEY, resolveEnv());
      expect(state?.extraArgs).toEqual(["--slot-save-path", "auto"]);
      expect(state?.slotSavePath).toBe(
        join(temp.devStorage, "ai-models", "local-ai", "kvstore", "slots", "test-wl"),
      );
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("refuses a non-loopback host bind without allowExternalBind", async () => {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env.LLAMA_CPP_BIN = binDir;

    let thrown: unknown;
    try {
      await Promise.resolve().then(() =>
        startServer({
          key: TEST_KEY,
          target: "Demo/demo.gguf",
          extraArgs: ["--host", "0.0.0.0"],
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("refusing to bind llama-server to 0.0.0.0");
  });

  test("allows a non-loopback host bind when allowExternalBind is set", async () => {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env.LLAMA_CPP_BIN = binDir;
    process.env.LLAMA_CPP_HOST = "127.0.0.1";
    process.env.LLAMA_CPP_PORT = "8080";

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
      mockSpawnImplementation(process.pid),
    );
    const fetchSpy = mockReadinessFetch();

    try {
      const result = await startServer({
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        extraArgs: ["--host", "0.0.0.0"],
        allowExternalBind: true,
      });
      expect(result.ok).toBe(true);
      expect(spawnSpy).toHaveBeenCalled();
      const fullArgs = spawnSpy.mock.calls[0]?.[1] ?? [];
      expect(fullArgs).toContain("--host");
      expect(fullArgs).toContain("0.0.0.0");
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("allows loopback host binds without allowExternalBind", async () => {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env.LLAMA_CPP_BIN = binDir;
    process.env.LLAMA_CPP_HOST = "127.0.0.1";
    process.env.LLAMA_CPP_PORT = "8080";

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
      mockSpawnImplementation(process.pid),
    );
    const fetchSpy = mockReadinessFetch();

    try {
      const result = await startServer({
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        extraArgs: ["--host=127.0.0.1"],
      });
      expect(result.ok).toBe(true);
      expect(spawnSpy).toHaveBeenCalled();
      const fullArgs = spawnSpy.mock.calls[0]?.[1] ?? [];
      expect(fullArgs).toContain("--host=127.0.0.1");
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("reports the launched endpoint from serverStatus after a start with an endpoint override", async () => {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env.LLAMA_CPP_BIN = binDir;
    process.env.LLAMA_CPP_HOST = "127.0.0.1";
    process.env.LLAMA_CPP_PORT = "8080";

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
      mockSpawnImplementation(process.pid),
    );
    const fetchSpy = mockReadinessFetch();

    try {
      const result = await startServer({
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        endpoint: { host: "127.0.0.1", port: 8181 },
      });
      expect(result.ok).toBe(true);
      expect(result.endpoint).toBe("http://127.0.0.1:8181");
      expect(result.advertisedEndpoint).toBe("http://127.0.0.1:8181");

      const status = await serverStatus(TEST_KEY);
      expect(status.endpoint).toBe("http://127.0.0.1:8181");
      expect(status.advertisedEndpoint).toBe("http://127.0.0.1:8181");
      expect(status.port).toBe(8181);
      expect(status.rel).toBe("Demo/demo.gguf");
      expect(
        advertisedEndpoint({
          LLAMA_CPP_HOST: "127.0.0.1",
          LLAMA_CPP_PORT: "8080",
        } as ResolvedEnv),
      ).toBe("http://127.0.0.1:8080");
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("uses a per-workload binary override instead of LLAMA_CPP_BIN", async () => {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const defaultBinDir = join(temp.devStorage, "default-bin");
    const customBinDir = join(temp.devStorage, "custom-bin");
    const customBin = join(customBinDir, "llama-server");
    mkdirSync(defaultBinDir, { recursive: true });
    mkdirSync(customBinDir, { recursive: true });
    writeFileSync(join(defaultBinDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    writeFileSync(customBin, "#!/bin/sh\nexit 0\n");
    process.env.LLAMA_CPP_BIN = defaultBinDir;
    process.env.LLAMA_CPP_HOST = "127.0.0.1";
    process.env.LLAMA_CPP_PORT = "8080";

    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
      mockSpawnImplementation(process.pid),
    );
    const fetchSpy = mockReadinessFetch();

    try {
      await startServer({
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        binary: customBin,
      });
      expect(spawnSpy).toHaveBeenCalledWith(
        customBin,
        expect.arrayContaining(["--host", "127.0.0.1", "--port", "8080"]),
        expect.objectContaining({ detached: true }),
      );
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe("server.stopServer", () => {
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

  test("no-op when there is nothing to stop", async () => {
    const result = await stopServer({ key: TEST_KEY });
    expect(result.stopped).toBe(true);
    expect(result.killed).toBe(false);
  });

  test("clears a stale PID file when the process is gone", async () => {
    const dir = ensureWorkloadRuntimeDir(resolveEnv(), TEST_KEY);
    writeFileSync(join(dir, "llama-server.pid"), "999999\n");
    const result = await stopServer({ key: TEST_KEY });
    expect(result.stopped).toBe(true);
    expect(readServerPid(TEST_KEY)).toBeNull();
  });
});

describe("server.readServerState (host/port validation)", () => {
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

  function writeSidecar(fields: Record<string, unknown>): void {
    const dir = ensureWorkloadRuntimeDir(resolveEnv(), TEST_KEY);
    writeFileSync(join(dir, "llama-server.state"), JSON.stringify(fields, null, 2));
  }

  const validSidecar = {
    rel: "Demo/demo.gguf",
    extraArgs: [],
    host: "127.0.0.1",
    port: "8080",
    binary: "",
    pid: 4242,
    startedAt: "2026-06-17T00:00:00.000Z",
    tunedProfile: null,
  };

  test("accepts a well-formed sidecar with a numeric-string port", () => {
    writeSidecar(validSidecar);
    const state = readServerState(TEST_KEY);
    expect(state).not.toBeNull();
    expect(state?.host).toBe("127.0.0.1");
    expect(state?.port).toBe("8080");
  });

  test("accepts a sidecar whose port is a JSON number (legacy/foreign writer)", () => {
    // Real writers (listLocalRoutes fixtures, older sidecars) emit port as a
    // JSON number, not a string; the read boundary must still accept it since
    // the consumer coerces with Number.parseInt.
    writeSidecar({ ...validSidecar, port: 8090 });
    expect(readServerState(TEST_KEY)).not.toBeNull();
  });

  test("returns null when the port does not parse to a finite number", () => {
    writeSidecar({ ...validSidecar, port: "not-a-number" });
    expect(readServerState(TEST_KEY)).toBeNull();
  });

  test("returns null when the port is missing", () => {
    const { port: _port, ...withoutPort } = validSidecar;
    writeSidecar(withoutPort);
    expect(readServerState(TEST_KEY)).toBeNull();
  });

  test("returns null when the host is missing", () => {
    const { host: _host, ...withoutHost } = validSidecar;
    writeSidecar(withoutHost);
    expect(readServerState(TEST_KEY)).toBeNull();
  });

  test("returns null when the host is an empty string", () => {
    writeSidecar({ ...validSidecar, host: "" });
    expect(readServerState(TEST_KEY)).toBeNull();
  });
});

describe("server per-workload isolation", () => {
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

  test("per-workload state files are isolated", () => {
    const resolved = resolveEnv();
    const A = { name: "a" };
    const B = { name: "b" };
    const aDir = ensureWorkloadRuntimeDir(resolved, A);
    writeFileSync(join(aDir, "llama-server.pid"), "12345\n");
    expect(readServerPid(A, resolved)).toBe(12345);
    expect(readServerPid(B, resolved)).toBeNull();
    // Sanity-check that the directories land where we expect.
    expect(workloadRuntimeDir(resolved, A)).toBe(join(temp.runtimeDir, "workloads", "a"));
    expect(workloadRuntimeDir(resolved, B)).toBe(join(temp.runtimeDir, "workloads", "b"));
  });
});

describe("server.hasFlag", () => {
  test("matches an exact long flag", () => {
    expect(hasFlag(["--host", "0.0.0.0"], "--host")).toBe(true);
  });
  test("matches a short flag alias", () => {
    expect(hasFlag(["-fa", "on"], "-fa", "--flash-attn")).toBe(true);
    expect(hasFlag(["--flash-attn", "on"], "-fa", "--flash-attn")).toBe(true);
  });
  test("matches the flag=value form", () => {
    expect(hasFlag(["--host=0.0.0.0"], "--host")).toBe(true);
  });
  test("returns false when no flag matches", () => {
    expect(hasFlag(["--alias", "local", "-ngl", "999"], "--host")).toBe(false);
  });
});

describe("server.filterProfileArgs", () => {
  test("keeps profile args when user has none of them", () => {
    expect(filterProfileArgs(["-fa", "on", "-b", "2048", "-ub", "512"], [])).toEqual([
      "-fa",
      "on",
      "-b",
      "2048",
      "-ub",
      "512",
    ]);
  });
  test("drops -ub from profile when user supplies it", () => {
    expect(filterProfileArgs(["-fa", "on", "-b", "2048", "-ub", "512"], ["-ub", "1024"])).toEqual([
      "-fa",
      "on",
      "-b",
      "2048",
    ]);
  });
  test("drops profile flags when user supplies the long-form alias", () => {
    expect(
      filterProfileArgs(
        ["-fa", "on", "-b", "2048", "-ub", "512"],
        ["--flash-attn", "off", "--batch-size", "4096"],
      ),
    ).toEqual(["-ub", "512"]);
  });
  test("drops everything when user overrides all three profile flags", () => {
    expect(
      filterProfileArgs(
        ["-fa", "on", "-b", "2048", "-ub", "512"],
        ["--flash-attn", "off", "-b", "4096", "--ubatch-size", "1024"],
      ),
    ).toEqual([]);
  });
});
