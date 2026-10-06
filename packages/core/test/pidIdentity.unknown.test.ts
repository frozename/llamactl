import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import * as keepAlive from "../src/keepAlive.js";
import * as pid from "../src/pidIdentity.js";
import { stopRpcServer } from "../src/rpcServer.js";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "../src/safe-fs.js";
import { startServer, stopServer } from "../src/server.js";
import { listLocalRoutes } from "../src/workloadRuntime.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

// "unknown" is a distinct fail-closed verdict: when the identity resolver
// cannot classify the process holding a recorded pid, every caller must stop
// short — no signal, no teardown, no file removal — because the record may
// still be ours. Dependencies are injected (never module mocks) so the same
// code path production runs decides the outcome.

const KEY = { name: "unknown-wl" };
const hourAgo = (): Date => new Date(Date.now() - 3_600_000);

const alive = (p: number): boolean => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};

describe("unknown identity is fail-closed at every caller", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let resolved: ResolvedEnv;
  let originalEnv: NodeJS.ProcessEnv;
  let impostor: ChildProcess;
  let impostorPid: number;

  beforeEach(async () => {
    impostor = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    if (impostor.pid === undefined) throw new Error("impostor spawn failed");
    impostorPid = impostor.pid;
    // Let the impostor's start time settle so record-vs-start comparisons are
    // unambiguous in both directions.
    await new Promise((r) => setTimeout(r, 300));
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    resolved = resolveEnv();
  });

  afterEach(() => {
    try {
      impostor.kill("SIGKILL");
    } catch {
      // already gone
    }
    process.env = originalEnv;
    temp.cleanup();
  });

  const seedServer = (backdate: boolean): string => {
    const dir = join(temp.runtimeDir, "workloads", KEY.name);
    mkdirSync(dir, { recursive: true });
    const pidPath = join(dir, "llama-server.pid");
    writeFileSync(pidPath, `${String(impostorPid)}\n`);
    writeFileSync(
      join(dir, "llama-server.state"),
      JSON.stringify({
        rel: "probe/model.gguf",
        extraArgs: [],
        host: "127.0.0.1",
        port: "1",
        binary: "/bin/false",
        pid: impostorPid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );
    if (backdate) utimesSync(pidPath, hourAgo(), hourAgo());
    return pidPath;
  };

  test("verifyPidFile classifies an unresolvable live pid as unknown", () => {
    mkdirSync(temp.runtimeDir, { recursive: true });
    const recordPath = join(temp.runtimeDir, "x.pid");
    writeFileSync(recordPath, `${String(impostorPid)}\n`);
    expect(
      pid.verifyPidFile(recordPath, impostorPid, {
        processStartMs: () => null,
      }),
    ).toBe("unknown");
  });

  test("verifyPidFiles batches start-time lookups into a single call", () => {
    mkdirSync(temp.runtimeDir, { recursive: true });
    const recordA = join(temp.runtimeDir, "a.pid");
    const recordB = join(temp.runtimeDir, "b.pid");
    writeFileSync(recordA, `${String(impostorPid)}\n`);
    writeFileSync(recordB, `${String(impostorPid)}\n`);
    const batches: number[][] = [];
    const verdicts = pid.verifyPidFiles(
      [
        { recordPath: recordA, pid: impostorPid },
        { recordPath: recordB, pid: impostorPid },
      ],
      {
        processStartMsMany: (pids) => {
          batches.push([...pids]);
          return new Map(pids.map((p) => [p, Date.now()]));
        },
      },
    );
    expect(verdicts.get(recordA)).toBe("alive");
    expect(verdicts.get(recordB)).toBe("alive");
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  test("stopServer refuses to signal or reap while identity is unknown", async () => {
    const pidPath = seedServer(false);
    const res = await stopServer({
      key: KEY,
      resolved,
      graceSeconds: 1,
      identity: { processStartMs: () => null },
    });
    expect(res.stopped).toBe(false);
    expect(alive(impostorPid)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    expect(existsSync(join(temp.runtimeDir, "workloads", KEY.name, "llama-server.state"))).toBe(
      true,
    );
  });

  test("stopRpcServer refuses to signal or reap while identity is unknown", async () => {
    mkdirSync(temp.runtimeDir, { recursive: true });
    const pidPath = join(temp.runtimeDir, "rpc-server.pid");
    writeFileSync(pidPath, `${String(impostorPid)}\n`);
    const res = await stopRpcServer({
      resolved,
      graceSeconds: 1,
      identity: { processStartMs: () => null },
    });
    expect(res.stopped).toBe(false);
    expect(alive(impostorPid)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
  });

  test("stopKeepAlive refuses to signal or reap while identity is unknown", async () => {
    mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
    const pidPath = keepAlive.keepAlivePidFile(resolved);
    writeFileSync(pidPath, `${String(impostorPid)}\n`);
    const res = await keepAlive.stopKeepAlive({
      key: KEY,
      resolved,
      graceSeconds: 1,
      identity: { processStartMs: () => null },
    });
    expect(res.stopped).toBe(false);
    expect(alive(impostorPid)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
  });

  test("readKeepAliveRecord exposes the verdict instead of collapsing to a pid", () => {
    mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
    const pidPath = keepAlive.keepAlivePidFile(resolved);
    writeFileSync(pidPath, `${String(impostorPid)}\n`);
    expect(keepAlive.readKeepAliveRecord(resolved, { processStartMs: () => null })).toEqual({
      pid: impostorPid,
      verdict: "unknown",
    });
  });

  test("readKeepAliveRecord flags a command-line impostor as unknown", () => {
    // A fresh record passes the start-time check, so only the command line
    // can show this pid is not the keep-alive supervisor.
    mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
    const pidPath = keepAlive.keepAlivePidFile(resolved);
    writeFileSync(pidPath, `${String(impostorPid)}\n`);
    expect(keepAlive.readKeepAliveRecord(resolved)).toEqual({
      pid: impostorPid,
      verdict: "unknown",
    });
  });

  test("R2-4 stopServer mismatch refuses and keeps every tracking file", async () => {
    const pidPath = seedServer(false);
    const statePath = join(temp.runtimeDir, "workloads", KEY.name, "llama-server.state");
    const state = readFileSync(statePath, "utf8");
    const res = await stopServer({
      key: KEY,
      resolved,
      graceSeconds: 1,
      identity: { processCommand: () => "/bin/sleep 60" },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(res.stopped).toBe(false);
    expect(res.killed).toBe(false);
    expect(alive(impostorPid)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf8").trim()).toBe(String(impostorPid));
    expect(readFileSync(statePath, "utf8")).toBe(state);
  });

  test("R2-4 stopRpcServer mismatch refuses and keeps every tracking file", async () => {
    mkdirSync(temp.runtimeDir, { recursive: true });
    const pidPath = join(temp.runtimeDir, "rpc-server.pid");
    const statePath = join(temp.runtimeDir, "rpc-server.state");
    writeFileSync(pidPath, `${String(impostorPid)}\n`);
    const state = JSON.stringify({ pid: impostorPid, host: "127.0.0.1", port: 1 });
    writeFileSync(statePath, state);
    const res = await stopRpcServer({
      resolved,
      graceSeconds: 1,
      identity: { processCommand: () => "/bin/sleep 60" },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(res.stopped).toBe(false);
    expect(res.killed).toBe(false);
    expect(alive(impostorPid)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf8").trim()).toBe(String(impostorPid));
    expect(readFileSync(statePath, "utf8")).toBe(state);
  });

  test("R2-4 stopKeepAlive mismatch refuses without writing a stop file", async () => {
    mkdirSync(temp.runtimeDir, { recursive: true });
    const pidPath = keepAlive.keepAlivePidFile(resolved);
    writeFileSync(pidPath, `${String(impostorPid)}\n`);
    const res = await keepAlive.stopKeepAlive({
      key: KEY,
      resolved,
      graceSeconds: 1,
      identity: { processCommand: () => "/bin/sleep 60" },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(res.stopped).toBe(false);
    expect(res.killed).toBe(false);
    expect(alive(impostorPid)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf8").trim()).toBe(String(impostorPid));
    expect(existsSync(keepAlive.keepAliveStopFile(resolved))).toBe(false);
  });

  test("R2-3 mmproj retry refuses instead of launching over an unverifiable process", async () => {
    const modelDir = join(temp.modelsDir, "probe");
    mkdirSync(modelDir, { recursive: true });
    const modelPath = join(modelDir, "model.gguf");
    writeFileSync(modelPath, "");
    const marker = join(temp.devStorage, "launches.log");
    const binary = join(temp.devStorage, "fake-llama-server");
    writeFileSync(binary, `#!/bin/sh\necho $$ >> '${marker}'\nexec /bin/sleep 30\n`, {
      mode: 0o755,
    });
    const portServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = portServer.port!;
    await portServer.stop(true);
    const pidPath = join(temp.runtimeDir, "workloads", KEY.name, "llama-server.pid");
    const launches = (): number[] =>
      existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").map(Number) : [];
    try {
      const res = await startServer({
        key: KEY,
        target: "probe/model.gguf",
        resolved,
        binary,
        endpoint: { host: "127.0.0.1", port },
        extraArgs: ["--mmproj", modelPath],
        timeoutSeconds: 1,
        skipTuned: true,
        identity: { processCommand: () => "/bin/sleep 60" },
      });
      expect(launches()).toHaveLength(1);
      const firstPid = launches()[0]!;
      expect(res.ok).toBe(false);
      expect(res.retried).toBe(true);
      expect(res.error).toContain("pid identity unknown");
      expect(res.error).toContain(pidPath);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(firstPid)).toBe(true);
      expect(readFileSync(pidPath, "utf8").trim()).toBe(String(firstPid));
    } finally {
      for (const launched of launches()) {
        try {
          process.kill(-launched, "SIGKILL");
        } catch {
          // The detached group may already be gone.
        }
        try {
          process.kill(launched, "SIGKILL");
        } catch {
          // The child may already be gone.
        }
      }
    }
  }, 15_000);

  test("listLocalRoutes keeps routes whose recorded pid cannot be verified", () => {
    // Backdated so only the injected resolver can classify the record.
    seedServer(true);
    const routes = listLocalRoutes(resolved, { processStartMs: () => null });
    expect(routes.some((r) => r.workload === KEY.name)).toBe(true);
  });
});
