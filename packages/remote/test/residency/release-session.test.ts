// #520: operator per-session release — the releaseResidencySession helper
// (force-unload.ts) and the residencyReleaseSession tRPC mutation. Neither
// seam exists at the pinned base: the helper is reached through a guarded
// dynamic import and the procedure through the untyped _def lookup, so every
// case fails by assertion, never by a missing module, a thrown TRPCError or
// a type error.
import {
  createResidencyLeases,
  type Lease,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fenceWorkloadStop, type StopFenceRefusal } from "../../src/residency/stop-fence.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const MOD = "../../src/residency/force-unload.js";

type ReleaseSessionResult = {
  ok: boolean;
  sessionId?: string;
  workload?: string;
  refs?: number;
  forced?: boolean;
  source?: string;
  reason?: string;
  detail?: string;
};

type ReleaseResidencySessionModule = {
  releaseResidencySession: (opts: {
    sessionId: string;
    force?: boolean;
    sessions?: SessionRefcounts | null;
  }) => Promise<ReleaseSessionResult>;
};

type ReleaseCaller = {
  residencyReleaseSession: (input: {
    sessionId: string;
    force?: boolean;
    confirm?: boolean;
  }) => Promise<ReleaseSessionResult>;
};

type FenceResult = { stopped: boolean } | StopFenceRefusal;

const originalEnv = { ...process.env };
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-release-session-"));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(tmp, "residency-state", "operations.sqlite"),
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

async function loadRelease(): Promise<ReleaseResidencySessionModule> {
  const mod = (await import(MOD).catch(() => ({}))) as Record<string, unknown>;
  expect(typeof mod["releaseResidencySession"]).toBe("function");
  return mod as unknown as ReleaseResidencySessionModule;
}

function releaseCaller(): ReleaseCaller {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyReleaseSession");
  return router.createCaller({}) as unknown as ReleaseCaller;
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the mutation to reject");
}

function acquireLease(reg: ResidencyLeases, workload: string): Lease {
  const got = reg.acquire(workload);
  if (!got.ok) {
    throw new Error(`acquire(${workload}) refused: ${got.reason}`);
  }
  return got.lease;
}

function bindIdle(reg: SessionRefcounts, sessionId: string, workload: string): void {
  const got = reg.acquire(sessionId, workload);
  if (!got.ok) {
    throw new Error(`acquire(${sessionId}) refused: ${got.reason}`);
  }
  reg.release(sessionId, got.generation);
}

function registryWithoutRelease(): SessionRefcounts {
  return {
    acquire: () => ({ ok: false, reason: "AffinityConflict", boundWorkload: "w" }),
    release: () => undefined,
    touch: () => undefined,
    forceRelease: () => [],
    activeSessions: () => [],
    checkUnload: () => ({ ok: true, released: [] }),
  };
}

function fencedStop(workload: string, stopCalls: { count: number }): () => Promise<FenceResult> {
  return () =>
    fenceWorkloadStop<FenceResult>({
      workload,
      stop: () => {
        stopCalls.count += 1;
        return Promise.resolve({ stopped: true });
      },
      isVerifiedStop: (r) => "stopped" in r && r.stopped,
      refuse: (f) => f,
    });
}

describe("releaseResidencySession", () => {
  test("#520 H1: no session registry resolves typed Unavailable", async () => {
    const { releaseResidencySession } = await loadRelease();

    const result = await releaseResidencySession({ sessionId: "s1", sessions: null });

    expect(result).toEqual({
      ok: false,
      reason: "Unavailable",
      sessionId: "s1",
      detail: "no session registry installed; nothing to release",
    });
  });

  test("#520 H2: a registry without releaseSession resolves typed Unavailable", async () => {
    const { releaseResidencySession } = await loadRelease();

    const result = await releaseResidencySession({
      sessionId: "s1",
      sessions: registryWithoutRelease(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Unavailable",
      sessionId: "s1",
      detail: "the installed session registry does not support per-session release",
    });
  });

  test("#520 H3: a throwing releaseSession resolves SessionsUnknown", async () => {
    const { releaseResidencySession } = await loadRelease();
    const throwing = {
      ...registryWithoutRelease(),
      releaseSession: (): never => {
        throw new Error("boom");
      },
    };

    const result = await releaseResidencySession({ sessionId: "s1", sessions: throwing });

    expect(result).toEqual({
      ok: false,
      reason: "SessionsUnknown",
      sessionId: "s1",
      detail: "session registry could not release s1 (boom)",
    });
  });

  test("#520 H4: an idle session releases ok with source operator", async () => {
    const { releaseResidencySession } = await loadRelease();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    bindIdle(sessions, "s1", "w1");

    const result = await releaseResidencySession({ sessionId: "s1", sessions });

    expect(result).toEqual({
      ok: true,
      sessionId: "s1",
      workload: "w1",
      refs: 0,
      forced: false,
      source: "operator",
    });
    expect(sessions.activeSessions("w1")).toEqual([]);
  });

  test("#520 H5: in-flight and unknown sessions resolve typed refusals", async () => {
    const { releaseResidencySession } = await loadRelease();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    sessions.acquire("s1", "w1");

    const busy = await releaseResidencySession({ sessionId: "s1", sessions });
    expect(busy).toEqual({
      ok: false,
      reason: "SessionInFlight",
      sessionId: "s1",
      workload: "w1",
      refs: 1,
      detail: "session s1 has 1 in-flight request(s) on w1; retry once they settle or pass force",
    });

    const missing = await releaseResidencySession({ sessionId: "zz", sessions });
    expect(missing).toEqual({
      ok: false,
      reason: "SessionNotFound",
      sessionId: "zz",
      detail: "no live session zz (unknown or idled out)",
    });
  });

  test("#520 H6: sessions omitted resolves the installed registry", async () => {
    // Kills: always using a fresh or null registry.
    const { releaseResidencySession } = await loadRelease();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    setSessionRefcountRegistry(sessions);
    bindIdle(sessions, "s1", "w1");

    const result = await releaseResidencySession({ sessionId: "s1" });

    expect(result).toEqual({
      ok: true,
      sessionId: "s1",
      workload: "w1",
      refs: 0,
      forced: false,
      source: "operator",
    });
    expect(sessions.activeSessions("w1")).toEqual([]);
  });
});

describe("residencyReleaseSession procedure", () => {
  test("#520 R1: releasing the bound session unblocks the DF-05 fenced stop", async () => {
    // Kills: router wiring that does not resolve currentSessionRefcounts().
    const leases = createResidencyLeases();
    setResidencyLeaseRegistry(leases);
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    setSessionRefcountRegistry(sessions);
    bindIdle(sessions, "s1", "w1");

    const stopCalls = { count: 0 };
    const fenced = fencedStop("w1", stopCalls);
    expect(await fenced()).toEqual({ reason: "SessionsActive", active: ["s1"] });
    expect(stopCalls.count).toBe(0);

    const caller = releaseCaller();
    const released = await caller.residencyReleaseSession({ sessionId: "s1", confirm: true });
    expect(released).toMatchObject({ ok: true, workload: "w1", source: "operator" });

    expect(await fenced()).toEqual({ stopped: true });
    expect(stopCalls.count).toBe(1);
    expect(leases.snapshot("w1").phase).toBe("unloaded");
  });

  test("#520 R2: confirm gate rejects and force keeps held leases held", async () => {
    // Kills: a session release that revokes leases or routes through
    // forceUnloadWorkload.
    const leases = createResidencyLeases();
    setResidencyLeaseRegistry(leases);
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    setSessionRefcountRegistry(sessions);
    bindIdle(sessions, "s1", "w1");

    const caller = releaseCaller();
    expect(await rejectionOf(caller.residencyReleaseSession({ sessionId: "s1" }))).toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(
      await rejectionOf(caller.residencyReleaseSession({ sessionId: "bad id!", confirm: true })),
    ).toMatchObject({ code: "BAD_REQUEST" });
    expect(sessions.activeSessions("w1")).toEqual(["s1"]);

    const lease = acquireLease(leases, "w1");
    sessions.acquire("s1", "w1");

    const forced = await caller.residencyReleaseSession({
      sessionId: "s1",
      force: true,
      confirm: true,
    });
    expect(forced).toMatchObject({ ok: true, forced: true });

    const stopCalls = { count: 0 };
    const fenced = await fencedStop("w1", stopCalls)();
    expect(fenced).toEqual({ reason: "LeasesActive", active: [lease.id] });
    expect(stopCalls.count).toBe(0);
    expect(lease.signal.aborted).toBe(false);
  });
});
