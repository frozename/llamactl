// #278 (DF-05): startServer must fence its stop-before-start — and the
// mmproj retry's — behind the opt-in residency lease registry: refuse
// while leases are held or a foreign drain is open, run the stop under
// a drain that blocks new acquires, then reopen admission. With no
// registry published, or an unloaded workload, the start is unchanged.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { join } from "node:path";

import { resolveEnv } from "../src/env.js";
import { createResidencyLeases, setResidencyLeaseRegistry } from "../src/residency/leases.js";
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

type LeaseRegistry = ReturnType<typeof createResidencyLeases>;
type Lease = Extract<ReturnType<LeaseRegistry["acquire"]>, { ok: true }>["lease"];
type DrainToken = Extract<ReturnType<LeaseRegistry["beginDrain"]>, { ok: true }>["token"];

function mustLease(registry: LeaseRegistry, workload: string): Lease {
  const res = registry.acquire(workload);
  expect(res.ok).toBe(true);
  if (!res.ok) {
    throw new Error(`acquire(${workload}) refused`);
  }
  return res.lease;
}

function mustDrainToken(registry: LeaseRegistry, workload: string): DrainToken {
  const res = registry.beginDrain(workload);
  expect(res.ok).toBe(true);
  if (!res.ok) {
    throw new Error(`beginDrain(${workload}) refused`);
  }
  return res.token;
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

describe("server.startServer residency start fence (#278)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

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
  });
  afterEach(() => {
    process.env = originalEnv;
    setResidencyLeaseRegistry(null);
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

  test("refuses a start with LeasesActive while a lease is held, before stopping anything", async () => {
    standUpModelAndBin();
    const registry = createResidencyLeases();
    setResidencyLeaseRegistry(registry);
    const lease = mustLease(registry, "test-wl");
    writeTrackedPid(4194305);

    const { result, spawnCalls, fetchCalls } = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf" },
      4194306,
      "rejecting",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/LeasesActive/);
    expect((result as { refused?: unknown }).refused).toEqual({
      reason: "LeasesActive",
      active: [lease.id],
    });
    expect(spawnCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(readServerPid(TEST_KEY)).toBe(4194305);
    expect(registry.snapshot("test-wl").phase).toBe("open");
    expect(registry.active("test-wl")).toEqual([lease.id]);
    expect(lease.signal.aborted).toBe(false);
  });

  test("refuses with DrainInProgress while another drain holds the workload", async () => {
    standUpModelAndBin();
    const registry = createResidencyLeases();
    setResidencyLeaseRegistry(registry);
    const token = mustDrainToken(registry, "test-wl");
    writeTrackedPid(4194305);

    const { result, spawnCalls } = await startWithMockedIo(
      { key: TEST_KEY, target: "Demo/demo.gguf" },
      4194306,
      "rejecting",
    );

    expect(result.ok).toBe(false);
    expect((result as { refused?: unknown }).refused).toMatchObject({
      reason: "DrainInProgress",
    });
    expect(spawnCalls).toBe(0);
    expect(readServerPid(TEST_KEY)).toBe(4194305);
    expect(registry.snapshot("test-wl").phase).toBe("draining");
    expect(registry.cancelDrain(token)).toBe(true);
  });

  test("the stop-before-start runs under a drain that blocks new acquires, then admission reopens", async () => {
    standUpModelAndBin();
    const registry = createResidencyLeases();
    setResidencyLeaseRegistry(registry);
    writeTrackedPid(4194305);
    const seen: { current?: unknown } = {};

    const { result, spawnCalls } = await startWithMockedIo(
      {
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        identity: {
          probe: () => {
            seen.current = registry.acquire("test-wl");
            throw Object.assign(new Error("gone"), { code: "ESRCH" });
          },
        },
      },
      process.pid,
      "readiness",
    );

    expect(result.ok).toBe(true);
    expect(seen.current).toMatchObject({ ok: false, reason: "Draining" });
    expect(spawnCalls).toBe(1);
    expect(registry.snapshot("test-wl").phase).toBe("open");
    const post = registry.acquire("test-wl");
    expect(post.ok).toBe(true);
    if (post.ok) {
      post.lease.release();
    }
  });

  test("refuses the mmproj retry with LeasesActive when a lease appears during the first poll", async () => {
    standUpModelAndBin();
    const registry = createResidencyLeases();
    setResidencyLeaseRegistry(registry);
    const events: string[] = [];
    let leaseId: string | undefined;
    let leaseSignal: AbortSignal | undefined;
    let launches = 0;

    const { result, spawnCalls } = await startWithMockedIo(
      {
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        extraArgs: ["--mmproj", "/tmp/does-not-matter-mmproj.gguf"],
        onEvent: (e) => {
          events.push(e.type);
          if (e.type === "launch") {
            launches += 1;
            if (launches === 1) {
              const res = registry.acquire("test-wl");
              if (res.ok) {
                leaseId = res.lease.id;
                leaseSignal = res.lease.signal;
              }
            }
          }
        },
      },
      4194306,
      "rejecting",
    );

    expect(spawnCalls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/LeasesActive/);
    expect((result as { refused?: unknown }).refused).toEqual({
      reason: "LeasesActive",
      active: [leaseId],
    });
    expect(result.retried).toBe(false);
    expect(events).not.toContain("retry");
    expect(readServerPid(TEST_KEY)).toBe(4194306);
    expect(leaseSignal?.aborted).toBe(false);
  });

  test("no published registry: the start is unchanged", async () => {
    standUpModelAndBin();
    setResidencyLeaseRegistry(null);
    writeTrackedPid(4194305);
    const events: string[] = [];

    const { result, spawnCalls } = await startWithMockedIo(
      {
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        onEvent: (e) => {
          events.push(e.type);
        },
      },
      process.pid,
      "readiness",
    );

    expect(result.ok).toBe(true);
    expect(readServerPid(TEST_KEY)).toBe(process.pid);
    expect(spawnCalls).toBe(1);
    expect(events).toEqual(["launch", "ready"]);
    expect(Object.prototype.hasOwnProperty.call(result, "refused")).toBe(false);
  });

  test("no published registry: the mmproj retry still runs", async () => {
    standUpModelAndBin();
    setResidencyLeaseRegistry(null);
    const events: string[] = [];

    const { spawnCalls } = await startWithMockedIo(
      {
        key: TEST_KEY,
        target: "Demo/demo.gguf",
        extraArgs: ["--mmproj", "/tmp/does-not-matter-mmproj.gguf"],
        onEvent: (e) => {
          events.push(e.type);
        },
      },
      4194306,
      "rejecting",
    );

    expect(spawnCalls).toBe(2);
    expect(events).toContain("retry");
  });

  test("an unloaded workload starts unfenced and stays unloaded", async () => {
    standUpModelAndBin();
    const registry = createResidencyLeases();
    setResidencyLeaseRegistry(registry);
    const token = mustDrainToken(registry, "test-wl");
    expect(registry.commitUnload(token)).toEqual({ ok: true, revoked: [] });
    writeTrackedPid(4194305);

    const { result, spawnCalls } = await startWithMockedIo(
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

    expect(result.ok).toBe(true);
    expect(spawnCalls).toBe(1);
    expect(registry.snapshot("test-wl").phase).toBe("unloaded");
  });
});
