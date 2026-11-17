// #520: startServer's stop-before-start must fence the session refcount
// registry the same way the node stop fence does — once the lease drain
// is acquired, a live session (in-flight or idle inside its timeout)
// refuses the restart as SessionsActive, a throwing checkUnload refuses
// SessionsUnknown, the drain is cancelled, and nothing is signalled or
// spawned; a crashed tracked instance and an expired idle session never
// block. Harness copied from server.residencyStartFence.test.ts (#278);
// every case fails on the base commit by assertion, never by import or
// type error.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { join } from "node:path";

import { resolveEnv } from "../src/env.js";
import { createResidencyLeases, setResidencyLeaseRegistry } from "../src/residency/leases.js";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "../src/residency/sessions.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { readServerPid, startServer } from "../src/server.js";
import { ensureWorkloadRuntimeDir } from "../src/workloadRuntime.js";
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

function mockRejectingFetch(): ReturnType<typeof spyOn<typeof globalThis, "fetch">> {
  return spyOn(globalThis, "fetch").mockImplementation((() =>
    Promise.reject(new Error("connection refused"))) as unknown as typeof fetch);
}

async function startWithMockedIo(
  opts: Parameters<typeof startServer>[0],
  spawnPid: number,
  fetchMock: "readiness" | "rejecting",
): Promise<{
  result: Awaited<ReturnType<typeof startServer>>;
  spawnCalls: number;
  fetchCalls: number;
}> {
  const fetchSpy = fetchMock === "readiness" ? mockReadinessFetch() : mockRejectingFetch();
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
    mockSpawnImplementation(spawnPid),
  );
  let result!: Awaited<ReturnType<typeof startServer>>;
  let spawnCalls = -1;
  let fetchCalls = -1;
  try {
    result = await startServer(opts);
  } finally {
    // mockRestore() clears the recorded calls, so capture counts first.
    spawnCalls = spawnSpy.mock.calls.length;
    fetchCalls = fetchSpy.mock.calls.length;
    spawnSpy.mockRestore();
    fetchSpy.mockRestore();
  }
  return { result, spawnCalls, fetchCalls };
}

type KillSpy = ReturnType<typeof spyOn<typeof process, "kill">>;

describe("server.startServer residency session start fence (#520)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;
  let clock = 0;
  let leases: ReturnType<typeof createResidencyLeases>;
  let sessions: SessionRefcounts;
  let killSpy: KillSpy;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    // Never fall back to the default localhost port, which a real server may hold on this host.
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "65534";
    process.env["LLAMA_CPP_BIN"] = join(temp.devStorage, "nonexistent-bin");
    mkdirSync(temp.runtimeDir, { recursive: true });
    clock = 0;
    leases = createResidencyLeases();
    setResidencyLeaseRegistry(leases);
    sessions = createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => clock });
    setSessionRefcountRegistry(sessions);
    // No real signal is ever sent: every tracked pid reads as gone (ESRCH).
    // The mocked spawn hands out process.pid, so a signal-0 liveness probe
    // on it must keep answering alive or the readiness poll exits early.
    killSpy = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ): boolean => {
      if (pid === process.pid && signal === 0) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    process.env = originalEnv;
    setResidencyLeaseRegistry(null);
    setSessionRefcountRegistry(null);
    temp.cleanup();
  });

  function standUpModelAndBin(): void {
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env["LLAMA_CPP_BIN"] = binDir;
  }

  function writeTrackedPid(pid: number): void {
    const dir = ensureWorkloadRuntimeDir(resolveEnv(), TEST_KEY);
    writeFileSync(join(dir, "llama-server.pid"), `${String(pid)}\n`);
  }

  function aliveIdentity(): NonNullable<Parameters<typeof startServer>[0]["identity"]> {
    const binDir = join(temp.devStorage, "fake-bin");
    return {
      probe: () => undefined,
      processStartMs: () => Date.now() - 1000,
      processCommand: () => `${binDir}/llama-server -m Demo/demo.gguf`,
    };
  }

  function acquireSession(sessionId: string, workload: string): number {
    const s = sessions.acquire(sessionId, workload);
    expect(s.ok).toBe(true);
    if (!s.ok) {
      throw new Error(`acquire(${sessionId}) refused`);
    }
    return s.generation;
  }

  // Kills: removing the session check from the start fence's stop path
  // (the live instance is signalled and the start proceeds), refusing on
  // any bound session regardless of instance liveness (the crashed
  // instance would never restart), a checkUnload({ force: true }) or
  // forceRelease instead of a plain check (the session would be
  // released), or a missing cancelDrain on refusal (the workload stays
  // draining).
  test("refuses a restart with SessionsActive while an idle session is bound to the live instance, then a crashed instance restarts", async () => {
    standUpModelAndBin();
    writeTrackedPid(4194305);
    // refs drops to 0 but the session stays live inside the idle window.
    sessions.release("s1", acquireSession("s1", "test-wl"));

    const refusedRun = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf", identity: aliveIdentity() },
      4194306,
      "rejecting",
    );

    expect(refusedRun.result.ok).toBe(false);
    expect(refusedRun.result.error).toMatch(/SessionsActive: s1/);
    expect(refusedRun.result.error).toMatch(/while a session is bound to its running instance$/);
    expect(refusedRun.result.error).not.toMatch(/leases are held/);
    expect((refusedRun.result as { refused?: unknown }).refused).toEqual({
      reason: "SessionsActive",
      active: ["s1"],
    });
    expect(refusedRun.spawnCalls).toBe(0);
    expect(refusedRun.fetchCalls).toBe(0);
    expect(killSpy.mock.calls.length).toBe(0);
    expect(readServerPid(TEST_KEY)).toBe(4194305);
    expect(leases.snapshot("test-wl").phase).toBe("open");
    const readmission = leases.acquire("test-wl");
    expect(readmission.ok).toBe(true);
    if (readmission.ok) {
      readmission.lease.release();
    }
    expect(sessions.activeSessions("test-wl")).toEqual(["s1"]);

    // Same session, but the tracked instance is gone: the restart proceeds
    // and the session stays bound.
    writeTrackedPid(4194305);
    const restarted = await startWithMockedIo(
      {
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        identity: {
          probe: () => {
            throw Object.assign(new Error("gone"), { code: "ESRCH" });
          },
        },
      },
      process.pid,
      "readiness",
    );

    expect(restarted.result.ok).toBe(true);
    expect(restarted.spawnCalls).toBe(1);
    expect(sessions.activeSessions("test-wl")).toEqual(["s1"]);
  });

  // Kills: treating a missing pid file as a live instance in the session
  // liveness probe (the bound session would block a start with nothing
  // to stop).
  test("a bound session with no tracked pid file does not block the start", async () => {
    standUpModelAndBin();
    acquireSession("s1", "test-wl");
    expect(readServerPid(TEST_KEY)).toBeNull();

    const { result, spawnCalls } = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf", identity: aliveIdentity() },
      process.pid,
      "readiness",
    );

    expect(result.ok).toBe(true);
    expect(spawnCalls).toBe(1);
    expect((result as { refused?: unknown }).refused).toBeUndefined();
    expect(sessions.activeSessions("test-wl")).toEqual(["s1"]);
  });

  // Kills: a session check that only refuses refs===0 (idle) sessions, or
  // one keyed on leases only — an in-flight session must refuse the
  // restart exactly like an idle-live one.
  test("an in-flight session (refs>0) refuses the restart even with no lease held", async () => {
    standUpModelAndBin();
    writeTrackedPid(4194305);
    // Never released: refs stays 1 for the life of the test.
    acquireSession("s1", "test-wl");

    const { result, spawnCalls, fetchCalls } = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf", identity: aliveIdentity() },
      4194306,
      "rejecting",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SessionsActive: s1/);
    expect((result as { refused?: unknown }).refused).toEqual({
      reason: "SessionsActive",
      active: ["s1"],
    });
    expect(spawnCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(killSpy.mock.calls.length).toBe(0);
    expect(readServerPid(TEST_KEY)).toBe(4194305);
    expect(sessions.activeSessions("test-wl")).toEqual(["s1"]);
  });

  // Kills: a try/catch that swallows the checkUnload throw and proceeds
  // to signal the live instance, or one that maps the throw to
  // SessionsActive — a registry that cannot answer must fail closed.
  test("a session registry whose checkUnload throws refuses SessionsUnknown and cancels the drain", async () => {
    standUpModelAndBin();
    writeTrackedPid(4194305);
    const broken: SessionRefcounts = {
      acquire: () => ({ ok: true, workload: "test-wl", refs: 1, generation: 1 }),
      release: () => undefined,
      touch: () => undefined,
      forceRelease: () => [],
      activeSessions: () => [],
      checkUnload: () => {
        throw new Error("boom");
      },
    };
    setSessionRefcountRegistry(broken);

    const { result, spawnCalls, fetchCalls } = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf", identity: aliveIdentity() },
      4194306,
      "rejecting",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SessionsUnknown/);
    expect((result as { refused?: unknown }).refused).toEqual({
      reason: "SessionsUnknown",
      active: [],
    });
    expect(spawnCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(killSpy.mock.calls.length).toBe(0);
    expect(readServerPid(TEST_KEY)).toBe(4194305);
    expect(leases.snapshot("test-wl").phase).toBe("open");
  });

  // Kills: checking sessions before leases (the held lease must keep
  // LeasesActive precedence), and an expiry check that ignores
  // idleTimeoutMs (the lapsed idle session would keep refusing).
  test("a lease held alongside a session keeps LeasesActive precedence, and an expired session no longer blocks", async () => {
    standUpModelAndBin();
    writeTrackedPid(4194305);
    sessions.release("s1", acquireSession("s1", "test-wl"));
    const held = leases.acquire("test-wl");
    if (!held.ok) {
      throw new Error("lease acquire refused");
    }

    const leased = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf", identity: aliveIdentity() },
      4194306,
      "rejecting",
    );
    expect(leased.result.ok).toBe(false);
    expect((leased.result as { refused?: unknown }).refused).toEqual({
      reason: "LeasesActive",
      active: [held.lease.id],
    });
    expect(leased.spawnCalls).toBe(0);
    expect(leased.fetchCalls).toBe(0);
    expect(killSpy.mock.calls.length).toBe(0);

    held.lease.release();
    writeTrackedPid(4194305);
    const sessionRefused = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf", identity: aliveIdentity() },
      4194306,
      "rejecting",
    );
    expect(sessionRefused.result.ok).toBe(false);
    expect(sessionRefused.result.error).toMatch(/SessionsActive: s1/);
    expect((sessionRefused.result as { refused?: unknown }).refused).toEqual({
      reason: "SessionsActive",
      active: ["s1"],
    });
    expect(sessionRefused.spawnCalls).toBe(0);
    expect(sessionRefused.fetchCalls).toBe(0);
    expect(killSpy.mock.calls.length).toBe(0);
    expect(readServerPid(TEST_KEY)).toBe(4194305);

    // The idle window lapses: the same live instance no longer blocks.
    clock += 60_000;
    writeTrackedPid(4194305);
    const restarted = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf", identity: aliveIdentity() },
      process.pid,
      "readiness",
    );
    expect(restarted.result.ok).toBe(true);
    expect(restarted.spawnCalls).toBe(1);
    expect((restarted.result as { refused?: unknown }).refused).toBeUndefined();
    expect(sessions.activeSessions("test-wl")).toEqual([]);
  });
});
