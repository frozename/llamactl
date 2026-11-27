/**
 * #520 — RED tests for the session-refcount fence on the agent-side
 * llama.cpp sleep driver. A live session bound to the member must refuse
 * sleep before `requestSleep` mutates the controller and before any POST or
 * process stop; a throwing session registry fails closed. The base driver
 * has no session seam, so every R case fails by assertion while the G
 * guards pin behavior that must hold on both sides of the fix. The fake
 * llama-server is loopback-only and the session clock is injected — no real
 * network, processes, sleeps or live user state.
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type {
  LlamacppSleepController,
  ObservedSleepState,
  SleepCapability,
  SleepMember,
} from "@llamactl/core/residency/llamacpp-sleep";
import type { SessionRefcounts } from "@llamactl/core/residency/sessions";

import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { createLlamacppSleepController } from "@llamactl/core/residency/llamacpp-sleep";
import {
  createSessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createAgentLlamacppSleepDriver,
  type LlamacppSleepDriver,
} from "../../src/residency/llamacpp-sleep-client.js";

const IDLE_TIMEOUT_MS = 60_000;

// `as never` keeps the not-yet-existing refusal shape typechecking at the
// pinned base; bun ignores it and the assertion still fails there.
const EXPECTED_ACTIVE_S1 = {
  kind: "refused",
  reason: "SessionsActive",
  reservation: "held",
  active: ["s1"],
} as never;

const EXPECTED_UNKNOWN = {
  kind: "refused",
  reason: "SessionsUnknown",
  reservation: "held",
  active: [],
} as never;

type SessionFence = {
  checkUnload: SessionRefcounts["checkUnload"];
};

// ── fake llama-server ───────────────────────────────────────────────────

type SleepMode = "ok" | 409 | 503 | 404 | 501 | "hang";

type FakeLlamaState = { sleepMode: SleepMode };
type FakeLlamaCounts = { sleepPosts: number; healthGets: number };

type FakeLlama = {
  endpoint: { host: string; port: number };
  baseUrl: string;
  state: FakeLlamaState;
  counts: FakeLlamaCounts;
  stop: () => Promise<void>;
};

const llamas: FakeLlama[] = [];

let previousRegistry: ResidencyLeases | null = null;
let nowMs = 0;

beforeEach(() => {
  nowMs = 0;
  previousRegistry = getResidencyLeaseRegistry();
  setResidencyLeaseRegistry(createResidencyLeases());
  setSessionRefcountRegistry(null);
});

afterEach(async () => {
  setResidencyLeaseRegistry(previousRegistry);
  setSessionRefcountRegistry(null);
  const pending = llamas.splice(0);
  await Promise.all(pending.map((fake): Promise<void> => fake.stop()));
});

function hangResponse(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

function startFakeLlama(): FakeLlama {
  const state: FakeLlamaState = { sleepMode: "ok" };
  const counts: FakeLlamaCounts = { sleepPosts: 0, healthGets: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/sleep") {
        counts.sleepPosts += 1;
        const mode = state.sleepMode;
        if (mode === "hang") {
          return hangResponse();
        }
        if (mode === "ok") {
          return Response.json({});
        }
        return Response.json({ error: `sleep refused with ${String(mode)}` }, { status: mode });
      }
      if (req.method === "GET" && url.pathname === "/props") {
        return Response.json({ is_sleeping: true });
      }
      if (req.method === "GET" && url.pathname === "/health") {
        counts.healthGets += 1;
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const { port } = server;
  if (port === undefined) {
    throw new Error("fake llama-server did not bind a port");
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      await server.stop(true);
    }
  };
  const fake: FakeLlama = {
    endpoint: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${String(port)}`,
    state,
    counts,
    stop,
  };
  llamas.push(fake);
  return fake;
}

// ── verifiedStop seam ───────────────────────────────────────────────────

type StopProof = { ok: true } | { ok: false; reason: string };
type VerifiedStop = () => Promise<StopProof>;
type StopCounter = { count: number };

function releaseVerifiedStop(fake: FakeLlama, stops: StopCounter): VerifiedStop {
  return async () => {
    stops.count += 1;
    await fake.stop();
    try {
      await fetch(`${fake.baseUrl}/health`);
      return { ok: false, reason: "EvictReleaseUnverified" };
    } catch {
      return { ok: true };
    }
  };
}

// ── controller + driver fixtures ────────────────────────────────────────

const GUARDED_CAPABILITY: SleepCapability = {
  kind: "guarded-sleep",
  fork: "ggml-org",
  build: "b1",
};

function memberSpec(id: string, capability: SleepCapability): SleepMember {
  return {
    id,
    runtimeKey: `rk-${id}`,
    specDigest: `d-${id}`,
    allocationGiB: 8,
    capability,
  };
}

function makeController(
  capabilityA: SleepCapability = GUARDED_CAPABILITY,
  stateA: ObservedSleepState = "ready",
): LlamacppSleepController {
  const controller = createLlamacppSleepController({ budgetGiB: 10 });
  controller.register(memberSpec("a", capabilityA), stateA);
  controller.register(memberSpec("b", GUARDED_CAPABILITY), "sleeping");
  return controller;
}

function makeDriver(opts: {
  controller: LlamacppSleepController;
  fake: FakeLlama;
  verifiedStop: VerifiedStop;
  sessions?: SessionFence | null;
}): LlamacppSleepDriver {
  return createAgentLlamacppSleepDriver({
    controller: opts.controller,
    memberId: "a",
    endpoint: opts.fake.endpoint,
    verifiedStop: opts.verifiedStop,
    ...(opts.sessions !== undefined ? { sessions: opts.sessions } : {}),
  });
}

function snapshotMember(
  controller: LlamacppSleepController,
  id: string,
): { state: string; reservation: string } {
  const member = controller.snapshot().members[id];
  expect(member).toBeDefined();
  if (member === undefined) {
    throw new Error(`missing member ${id}`);
  }
  return { state: member.state, reservation: member.reservation };
}

type MemberSnapshot = { state: string; reservation: string };

function expectMemberUnchanged(
  controller: LlamacppSleepController,
  beforeMember: MemberSnapshot,
  beforeCommittedGiB: number,
): void {
  expect(snapshotMember(controller, "a")).toEqual(beforeMember);
  expect(controller.snapshot().committedGiB).toBe(beforeCommittedGiB);
}

function memberSnapshotBeforeSleep(controller: LlamacppSleepController): {
  member: MemberSnapshot;
  committedGiB: number;
} {
  return {
    member: snapshotMember(controller, "a"),
    committedGiB: controller.snapshot().committedGiB,
  };
}

function createSessions(): SessionRefcounts {
  return createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => nowMs });
}

function acquireSession(sessions: SessionRefcounts, id: string, workload: string): number {
  const acquired = sessions.acquire(id, workload);
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) {
    throw new Error(`session acquire refused: ${acquired.reason}`);
  }
  return acquired.generation;
}

function idleSession(sessions: SessionRefcounts, id: string, workload: string): void {
  sessions.release(id, acquireSession(sessions, id, workload));
}

function installBoundIdleSession(workload = "a", id = "s1"): SessionRefcounts {
  const sessions = createSessions();
  setSessionRefcountRegistry(sessions);
  idleSession(sessions, id, workload);
  return sessions;
}

describe("#520 llama.cpp sleep session fence", () => {
  test("R1 an idle-bound session refuses sleep as SessionsActive", async () => {
    // Kills: a sleep with no checkUnload, and a fence that calls
    // forceRelease or checkUnload({force:true}).
    const fake = startFakeLlama();
    const controller = makeController();
    const before = memberSnapshotBeforeSleep(controller);
    const sessions = installBoundIdleSession();
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    expect(await driver.sleep()).toEqual(EXPECTED_ACTIVE_S1);
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expect(snapshotMember(controller, "a")).toEqual({ state: "ready", reservation: "resident" });
    expectMemberUnchanged(controller, before.member, before.committedGiB);
    expect(sessions.activeSessions("a")).toEqual(["s1"]);
  });

  test("R2 an in-flight session refuses sleep as SessionsActive", async () => {
    // Kills: treating only idle bindings as live, or releasing the
    // in-flight binding to make the sleep proceed.
    const fake = startFakeLlama();
    const controller = makeController();
    const before = memberSnapshotBeforeSleep(controller);
    const sessions = createSessions();
    setSessionRefcountRegistry(sessions);
    acquireSession(sessions, "s1", "a");
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    expect(await driver.sleep()).toEqual(EXPECTED_ACTIVE_S1);
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expect(snapshotMember(controller, "a")).toEqual({ state: "ready", reservation: "resident" });
    expectMemberUnchanged(controller, before.member, before.committedGiB);
    expect(sessions.activeSessions("a")).toEqual(["s1"]);
  });

  test("R3 a throwing session registry fails closed as SessionsUnknown", async () => {
    // Kills: letting a throwing checkUnload proceed to sleep or escape as
    // an unclassified driver failure.
    const fake = startFakeLlama();
    const controller = makeController();
    const before = memberSnapshotBeforeSleep(controller);
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
      sessions: {
        checkUnload() {
          throw new Error("boom");
        },
      },
    });

    expect(await driver.sleep()).toEqual(EXPECTED_UNKNOWN);
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expectMemberUnchanged(controller, before.member, before.committedGiB);
  });

  test("R4 the process-fallback path is fenced before any process stop", async () => {
    // Kills: running the session check only on the guarded HTTP path,
    // after the process-stop branch has already killed the member.
    const fake = startFakeLlama();
    const controller = makeController({ kind: "process-fallback", reason: "r" });
    const before = memberSnapshotBeforeSleep(controller);
    const sessions = installBoundIdleSession();
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    expect(await driver.sleep()).toEqual(EXPECTED_ACTIVE_S1);
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expectMemberUnchanged(controller, before.member, before.committedGiB);
    expect(sessions.activeSessions("a")).toEqual(["s1"]);
  });

  test("R5 the agent factory captures the session registry at construction", async () => {
    // Kills: resolving currentSessionRefcounts() only at sleep time inside
    // the agent factory.
    const fake = startFakeLlama();
    const controller = makeController();
    const before = memberSnapshotBeforeSleep(controller);
    const sessions = installBoundIdleSession();
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    setSessionRefcountRegistry(null);

    expect(await driver.sleep()).toEqual(EXPECTED_ACTIVE_S1);
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expectMemberUnchanged(controller, before.member, before.committedGiB);
    expect(sessions.activeSessions("a")).toEqual(["s1"]);
  });

  test("R6 an injected sessions option is honoured with no installed registry", async () => {
    // Kills: ignoring the explicit sessions option and consulting only the
    // process-wide registry seam.
    const fake = startFakeLlama();
    const controller = makeController();
    const before = memberSnapshotBeforeSleep(controller);
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
      sessions: {
        checkUnload: () => ({ ok: false, reason: "SessionActive", sessions: ["x1", "x2"] }),
      },
    });

    expect(await driver.sleep()).toEqual({
      kind: "refused",
      reason: "SessionsActive",
      reservation: "held",
      active: ["x1", "x2"],
    } as never);
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expectMemberUnchanged(controller, before.member, before.committedGiB);
  });

  test("G1 guard: no session registry installed and none injected sleeps normally", async () => {
    // Kills: the fence failing closed when no session seam exists at all.
    const fake = startFakeLlama();
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    expect(await driver.sleep()).toEqual({ kind: "slept", reservation: "released" });
    expect(fake.counts.sleepPosts).toBe(1);
    expect(stops.count).toBe(0);
    expect(snapshotMember(controller, "a")).toEqual({ state: "sleeping", reservation: "released" });
    expect(controller.snapshot().committedGiB).toBe(0);
  });

  test("G2 guard: a session bound to another member does not block a", async () => {
    // Kills: matching sessions globally rather than by the member being
    // put to sleep.
    const fake = startFakeLlama();
    const controller = makeController();
    const sessions = installBoundIdleSession("b");
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    expect(await driver.sleep()).toEqual({ kind: "slept", reservation: "released" });
    expect(fake.counts.sleepPosts).toBe(1);
    expect(stops.count).toBe(0);
    expect(sessions.activeSessions("b")).toEqual(["s1"]);
  });

  test("G3 guard: an expired idle session does not block sleep", async () => {
    // Kills: consulting stale idle rows without applying idleTimeoutMs.
    const fake = startFakeLlama();
    const controller = makeController();
    const sessions = installBoundIdleSession();
    nowMs = IDLE_TIMEOUT_MS + 1;
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    expect(await driver.sleep()).toEqual({ kind: "slept", reservation: "released" });
    expect(fake.counts.sleepPosts).toBe(1);
    expect(stops.count).toBe(0);
    expect(sessions.activeSessions("a")).toEqual([]);
  });

  test("G4 guard: sessions:null opts out even while a bound registry is installed", async () => {
    // Kills: treating an explicit null opt-out as an undefined fallback to
    // the process-wide session registry.
    const fake = startFakeLlama();
    const controller = makeController();
    const sessions = installBoundIdleSession();
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
      sessions: null,
    });

    expect(await driver.sleep()).toEqual({ kind: "slept", reservation: "released" });
    expect(fake.counts.sleepPosts).toBe(1);
    expect(stops.count).toBe(0);
    expect(sessions.activeSessions("a")).toEqual(["s1"]);
  });

  test("G5 guard: no lease registry keeps the driver inert even with a bound session", async () => {
    // Kills: consulting sessions when the residency lease registry is
    // absent, which would make an otherwise disabled driver refuse work.
    const fake = startFakeLlama();
    const controller = makeController();
    const before = memberSnapshotBeforeSleep(controller);
    const sessions = installBoundIdleSession();
    setResidencyLeaseRegistry(null);
    const stops: StopCounter = { count: 0 };
    const driver = makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    expect(await driver.sleep()).toEqual({ kind: "inert", reason: "ResidencyPolicyDisabled" });
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expectMemberUnchanged(controller, before.member, before.committedGiB);
    expect(sessions.activeSessions("a")).toEqual(["s1"]);
  });
});
