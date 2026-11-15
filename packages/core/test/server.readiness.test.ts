import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import type { ModelHostReadiness } from "../src/engines/types.js";

import { resolveEnv } from "../src/env.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { readServerPid, readServerState, startServer } from "../src/server.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

// #220: a ModelRun's declared spec.readiness reaches llama-server.state only
// through startServer. These tests drive the real startServer with spawn and
// fetch stubbed (the server.test.ts pattern), so no process is launched and no
// port is bound, and read the sidecar back with readServerState:
// - a fresh launch records opts.readiness (launchedServerState);
// - a port-conflict adopt forwards opts.readiness into tryAdoptExistingServer
//   (handlePortConflict), where lsof is answered by the spawn stub.
// An undeclared start leaves the key absent on both paths.

const KEY = { name: "readiness-wl" };
const READINESS: ModelHostReadiness = {
  path: "/ready",
  expectStatus: 200,
  expectJson: { status: "ready" },
};

function stubLaunchSpawn(pid: number): ReturnType<typeof spyOn<typeof childProcess, "spawn">> {
  return spyOn(childProcess, "spawn").mockImplementation((() => ({
    pid,
    unref: () => undefined,
  })) as unknown as typeof childProcess.spawn);
}

/** First /health dial refuses (the port is free), every later poll answers 200. */
function stubLaunchFetch(): ReturnType<typeof spyOn<typeof globalThis, "fetch">> {
  let calls = 0;
  return spyOn(globalThis, "fetch").mockImplementation((() => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("connection refused"));
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as unknown as typeof fetch);
}

/** Something healthy already serves our model on the port. */
function stubAdoptFetch(modelId: string): ReturnType<typeof spyOn<typeof globalThis, "fetch">> {
  return spyOn(globalThis, "fetch").mockImplementation(((input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === "/v1/models") {
      return Promise.resolve(Response.json({ data: [{ id: modelId }] }));
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as unknown as typeof fetch);
}

/**
 * Answer lsof (the listener-pid lookup) with `pid`, and any other spawn (a
 * process command-line read) with empty output. Records every command so the
 * test can assert llama-server itself was never launched.
 */
function stubAdoptSpawn(pid: number): {
  spy: ReturnType<typeof spyOn<typeof childProcess, "spawn">>;
  commands: string[];
} {
  const commands: string[] = [];
  const spy = spyOn(childProcess, "spawn").mockImplementation(((command: string) => {
    commands.push(command);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: () => boolean;
      unref: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4_194_303;
    child.kill = (): boolean => true;
    child.unref = (): void => undefined;
    setTimeout(() => {
      if (command.endsWith("lsof")) child.stdout.emit("data", `${String(pid)}\n`);
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }, 0);
    return child;
  }) as unknown as typeof childProcess.spawn);
  return { spy, commands };
}

describe("startServer persists a declared readiness into llama-server.state (#220)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;
  const restores: (() => void)[] = [];

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env["LLAMA_CPP_BIN"] = binDir;
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8083";
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
    process.env = originalEnv;
    temp.cleanup();
  });

  test("a fresh launch records opts.readiness; an undeclared launch leaves it absent", async () => {
    // Kills: launchedServerState dropping opts.readiness.
    const spawnSpy = stubLaunchSpawn(process.pid);
    restores.push(() => {
      spawnSpy.mockRestore();
    });
    const fetchSpy = stubLaunchFetch();
    restores.push(() => {
      fetchSpy.mockRestore();
    });

    const result = await startServer({
      key: KEY,
      target: "Demo/demo.gguf",
      readiness: READINESS,
    });
    expect(result.ok).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const state = readServerState(KEY, resolveEnv());
    expect(state?.pid).toBe(process.pid);
    expect(state?.readiness).toEqual(READINESS);

    fetchSpy.mockRestore();
    const plainFetch = stubLaunchFetch();
    restores.push(() => {
      plainFetch.mockRestore();
    });
    const plainKey = { name: "readiness-wl-plain" };
    const plain = await startServer({
      key: plainKey,
      target: "Demo/demo.gguf",
      endpoint: { port: 8084 },
    });
    expect(plain.ok).toBe(true);
    const plainState = readServerState(plainKey, resolveEnv());
    expect(plainState).not.toBeNull();
    expect(plainState !== null && "readiness" in plainState).toBe(false);
  });

  test("a port-conflict adopt forwards opts.readiness into the adopted sidecar", async () => {
    // Kills: handlePortConflict not forwarding opts.readiness into
    // tryAdoptExistingServer.
    const fetchSpy = stubAdoptFetch("demo.gguf");
    restores.push(() => {
      fetchSpy.mockRestore();
    });
    const { spy: spawnSpy, commands } = stubAdoptSpawn(process.pid);
    restores.push(() => {
      spawnSpy.mockRestore();
    });

    const result = await startServer({
      key: KEY,
      target: "Demo/demo.gguf",
      readiness: READINESS,
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(process.pid);
    // Adopted, not launched: no spawn ran the fake llama-server binary.
    expect(commands.some((c) => c.endsWith("llama-server"))).toBe(false);
    expect(commands.some((c) => c.endsWith("lsof"))).toBe(true);
    expect(readServerPid(KEY, resolveEnv())).toBe(process.pid);
    const state = readServerState(KEY, resolveEnv());
    expect(state?.rel).toBe("Demo/demo.gguf");
    expect(state?.readiness).toEqual(READINESS);

    const plainKey = { name: "readiness-wl-adopt-plain" };
    const plain = await startServer({ key: plainKey, target: "Demo/demo.gguf" });
    expect(plain.ok).toBe(true);
    expect(plain.pid).toBe(process.pid);
    const plainState = readServerState(plainKey, resolveEnv());
    expect(plainState).not.toBeNull();
    expect(plainState !== null && "readiness" in plainState).toBe(false);
  });
});
