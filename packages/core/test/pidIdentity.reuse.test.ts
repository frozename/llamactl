import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { rpcServerPidFile, rpcServerStatus, stopRpcServer } from "../src/rpcServer.js";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "../src/safe-fs.js";
import { serverStatus, stopServer } from "../src/server.js";
import { listLocalRoutes, listLocalWorkloads } from "../src/workloadRuntime.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

// A tracking file older than the process now holding its pid is a recycled-pid
// record: tracking files are only written while their process is alive, so the
// recorded process cannot have started after the record. A recycled pid must be
// treated as dead — never trusted for status or routing, never signalled.

const KEY = { name: "reuse-impostor" };

const hourAgo = (): Date => new Date(Date.now() - 3_600_000);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("recycled recorded pid", () => {
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
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "1";
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

  const workloadDir = (): string => {
    const dir = join(temp.runtimeDir, "workloads", KEY.name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const seedServer = (backdate: boolean): string => {
    const dir = workloadDir();
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

  const seedFile = (path: string, backdate: boolean): void => {
    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(path, `${String(impostorPid)}\n`);
    if (backdate) utimesSync(path, hourAgo(), hourAgo());
  };

  test("serverStatus reports a recycled pid as down and reaps the record", async () => {
    const pidPath = seedServer(true);
    const status = await serverStatus(KEY, resolved);
    expect(status.pid).toBeNull();
    expect(status.state).toBe("down");
    expect(existsSync(pidPath)).toBe(false);
  });

  test("listLocalWorkloads/listLocalRoutes do not trust a recycled pid", () => {
    seedServer(true);
    const entry = listLocalWorkloads(resolved).find((w) => w.name === KEY.name);
    expect(entry?.alive).toBe(false);
    expect(listLocalRoutes(resolved).filter((r) => r.workload === KEY.name)).toEqual([]);
  });

  test("stopServer never signals a recycled pid", async () => {
    const pidPath = seedServer(true);
    const result = await stopServer({ key: KEY, resolved, graceSeconds: 1 });
    expect(alive(impostorPid)).toBe(true);
    expect(result.killed).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("rpc-server status/stop do not trust or signal a recycled pid", async () => {
    const pidPath = rpcServerPidFile(resolved);
    seedFile(pidPath, true);
    expect((await rpcServerStatus(resolved)).state).toBe("down");
    seedFile(pidPath, true);
    await stopRpcServer({ resolved, graceSeconds: 1 });
    expect(alive(impostorPid)).toBe(true);
  });

  test("control: a record written after the process started is trusted", () => {
    seedServer(false);
    const entry = listLocalWorkloads(resolved).find((w) => w.name === KEY.name);
    expect(entry?.alive).toBe(true);
  });
});
