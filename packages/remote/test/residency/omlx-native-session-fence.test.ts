/**
 * Part of #520 — RED tests for the session-refcount fence on the
 * library-only oMLX native unload (`runUnloadWithLeases` in
 * src/residency/engine-client.ts). Once leases are installed the unload
 * must consult the session registry after the LeasesActive check and
 * before any HTTP call: a live session refuses `SessionsActive`, a
 * throwing `checkUnload` refuses `SessionsUnknown`, the drain is
 * cancelled either way so the phase returns to "open", and the unload
 * never releases sessions. The base client ignores `leases.sessions`
 * entirely, so every R case fails by assertion — never by import or
 * type error — while the G guards pin the inert paths that must hold on
 * both sides of the fix. The fake oMLX copies the minimal
 * status/activity/unload routing of omlx-native.test.ts's startFakeOmlx
 * and counts unload POSTs; the session registry runs on an injected
 * clock — no real timers, no sleeps, no live state.
 */
import {
  createResidencyLeases,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createAgentOmlxNativeClient,
  createOmlxNativeClient,
  type NativeUnloadResult,
  type OmlxNativeClient,
  type OmlxNativeClientOptions,
} from "../../src/residency/engine-client.js";

const REL = "mlx-community/Qwen3-8B-MLX-4bit";
const ID = "Qwen3-8B-MLX-4bit";
const W = "omlx-host";
const IDLE_TIMEOUT_MS = 60_000;

// `as never` keeps the not-yet-existing refusal reasons typechecking at
// the pinned base; bun ignores it and the assertion still fails there.
const EXPECTED_ACTIVE = {
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

type FakeState = {
  loaded: boolean;
  isLoading: boolean;
  activity: { active: number; waiting: number };
  readyStatus: number;
};

type FakeCounts = { unloadPosts: number };

type FakeOmlx = {
  endpoint: { host: string; port: number };
  state: FakeState;
  counts: FakeCounts;
  stop: () => Promise<void>;
};

// The base leases option has no `sessions` field; the widened local type
// keeps the cases typechecking at the pinned base while bun still
// exercises the field — the same loose-cast pattern the #520 profile
// fence suite uses.
type LeasesOption = {
  registry: ResidencyLeases;
  workload: string;
  sessions?: SessionRefcounts | null;
};

type PlainOpts = Omit<OmlxNativeClientOptions, "leases">;

type ClientOpts = PlainOpts & { leases?: LeasesOption };

let t = 0;

const fakes: FakeOmlx[] = [];

beforeEach(() => {
  t = 0;
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
});

afterEach(async () => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  const pending = fakes.splice(0);
  await Promise.all(pending.map((fake) => fake.stop()));
});

function statusResponse(state: FakeState): Response {
  return Response.json({
    models: [
      {
        id: ID,
        loaded: state.loaded,
        is_loading: state.isLoading,
        engine_type: "batched",
        actual_size: state.loaded ? 4_800_000_000 : null,
        resident_estimated_size: 5_000_000_000,
      },
    ],
  });
}

function activityResponse(state: FakeState): Response {
  return Response.json({
    active_requests: state.activity.active,
    waiting_requests: state.activity.waiting,
  });
}

function unloadModelId(path: string): string | null {
  const prefix = "/v1/models/";
  const suffix = "/unload";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    return null;
  }
  const id = path.slice(prefix.length, path.length - suffix.length);
  if (id === "" || id.includes("/")) {
    return null;
  }
  return decodeURIComponent(id);
}

function unloadResponse(state: FakeState, counts: FakeCounts, id: string): Response {
  counts.unloadPosts += 1;
  if (id === ID && state.loaded) {
    state.loaded = false;
    return Response.json({ status: "ok", model_id: id });
  }
  return Response.json({ detail: `Model not loaded: ${id}` }, { status: 400 });
}

function startFakeOmlx(): FakeOmlx {
  const state: FakeState = {
    loaded: true,
    isLoading: false,
    activity: { active: 0, waiting: 0 },
    readyStatus: 503,
  };
  const counts: FakeCounts = { unloadPosts: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "GET" && path === "/v1/models/status") {
        return statusResponse(state);
      }
      if (req.method === "GET" && path === "/api/status") {
        return activityResponse(state);
      }
      if (req.method === "GET" && path === "/ready") {
        return Response.json({}, { status: state.readyStatus });
      }
      if (req.method === "POST") {
        const unloadId = unloadModelId(path);
        if (unloadId !== null) {
          return unloadResponse(state, counts, unloadId);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) {
    throw new Error("fake oMLX did not bind a port");
  }
  let stopped = false;
  const fake: FakeOmlx = {
    endpoint: { host: "127.0.0.1", port },
    state,
    counts,
    stop: async () => {
      if (!stopped) {
        stopped = true;
        await server.stop(true);
      }
    },
  };
  fakes.push(fake);
  return fake;
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

function baseOpts(endpoint: { host: string; port: number }): PlainOpts {
  return {
    endpoint,
    hostedRel: REL,
    activityObservable: true,
    readiness: { path: "/ready" },
    requestTimeoutMs: 600,
    statusTimeoutMs: 300,
  };
}

function nativeClient(fake: FakeOmlx, leases?: LeasesOption): OmlxNativeClient {
  const opts: ClientOpts = {
    ...baseOpts(fake.endpoint),
    ...(leases === undefined ? {} : { leases }),
  };
  return createOmlxNativeClient(opts);
}

function agentClient(fake: FakeOmlx): OmlxNativeClient {
  return createAgentOmlxNativeClient({ ...baseOpts(fake.endpoint), workload: W });
}

function unloadedResult(): NativeUnloadResult {
  return { kind: "unloaded", modelId: ID, reservation: "released" };
}

describe("oMLX native unload session fence (#520)", () => {
  test("R1 an idle-bound session refuses the unload as SessionsActive", async () => {
    // Kills: the session check removed from runUnloadWithLeases; no
    // cancelDrain on the session refusal (the phase would stay
    // "draining"); checkUnload called with {force:true} or forceRelease
    // (s1 would be gone and the unload would proceed).
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);

    const client = nativeClient(fake, { registry, workload: W, sessions });

    expect(await client.unload()).toStrictEqual(EXPECTED_ACTIVE);
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
    expect(await client.status()).toMatchObject({ state: "resident", modelId: ID });
    expect(sessions.activeSessions(W)).toStrictEqual(["s1"]);
  });

  test("R2 an in-flight session refuses the unload as SessionsActive", async () => {
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    acquireSession(sessions, "s1", W);

    const client = nativeClient(fake, { registry, workload: W, sessions });

    expect(await client.unload()).toStrictEqual(EXPECTED_ACTIVE);
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
  });

  test("R3 a throwing session registry fails closed as SessionsUnknown", async () => {
    // Kills: the throw propagating out of unload; a throw treated as a
    // clean check (fail-open); no cancelDrain on the refusal.
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const throwing: SessionRefcounts = {
      acquire: () => {
        throw new Error("boom");
      },
      release: () => undefined,
      touch: () => undefined,
      forceRelease: () => [],
      activeSessions: () => [],
      checkUnload: () => {
        throw new Error("boom");
      },
    };

    const client = nativeClient(fake, { registry, workload: W, sessions: throwing });

    expect(await client.unload()).toStrictEqual(EXPECTED_UNKNOWN);
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
  });

  test("R4 the agent factory fences unload through both installed seams", async () => {
    // Kills: the factory not forwarding the captured session registry —
    // the first unload would proceed — while the ctx ignores an
    // undefined sessions default.
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);
    setResidencyLeaseRegistry(registry);
    setSessionRefcountRegistry(sessions);

    const client = agentClient(fake);

    expect(await client.unload()).toStrictEqual(EXPECTED_ACTIVE);
    expect(fake.counts.unloadPosts).toBe(0);

    expect(sessions.releaseSession?.("s1")).toMatchObject({ ok: true });

    expect(await client.unload()).toStrictEqual(unloadedResult());
    expect(fake.counts.unloadPosts).toBe(1);
    expect(registry.snapshot(W).phase).toBe("unloaded");
  });

  test("R5 an omitted sessions field resolves the installed registry at unload time", async () => {
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);
    setSessionRefcountRegistry(sessions);

    const client = nativeClient(fake, { registry, workload: W });

    expect(await client.unload()).toStrictEqual(EXPECTED_ACTIVE);
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
  });

  test("R5-variant a registry installed after construction still fences at unload", async () => {
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);

    const client = nativeClient(fake, { registry, workload: W });
    setSessionRefcountRegistry(sessions);

    expect(await client.unload()).toStrictEqual(EXPECTED_ACTIVE);
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
  });

  test("R6 the agent factory captures the session registry at construction", async () => {
    // Kills: a lazy factory that leaves sessions undefined and resolves
    // currentSessionRefcounts() at unload time — clearing the seam after
    // construction would then let the unload through.
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);
    setResidencyLeaseRegistry(registry);
    setSessionRefcountRegistry(sessions);

    const client = agentClient(fake);

    setSessionRefcountRegistry(null);

    expect(await client.unload()).toStrictEqual(EXPECTED_ACTIVE);
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
  });

  test("G1 guard: a held lease keeps LeasesActive precedence over a bound session", async () => {
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);
    const held = registry.acquire(W);
    expect(held.ok).toBe(true);
    if (!held.ok) {
      throw new Error(`acquire(${W}) refused`);
    }

    const client = nativeClient(fake, { registry, workload: W, sessions });

    expect(await client.unload()).toStrictEqual({
      kind: "refused",
      reason: "LeasesActive",
      reservation: "held",
      active: [held.lease.id],
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
    expect(sessions.activeSessions(W)).toStrictEqual(["s1"]);
  });

  test("G2 guard: an expired idle session does not block the unload", async () => {
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);
    t = IDLE_TIMEOUT_MS + 1;

    const client = nativeClient(fake, { registry, workload: W, sessions });

    expect(await client.unload()).toStrictEqual(unloadedResult());
    expect(fake.counts.unloadPosts).toBe(1);
    expect(registry.snapshot(W).phase).toBe("unloaded");
  });

  test("G3 guard: a session bound to another workload does not block W", async () => {
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", "other");

    const client = nativeClient(fake, { registry, workload: W, sessions });

    expect(await client.unload()).toStrictEqual(unloadedResult());
    expect(fake.counts.unloadPosts).toBe(1);
    expect(registry.snapshot(W).phase).toBe("unloaded");
    expect(sessions.activeSessions("other")).toStrictEqual(["s1"]);
  });

  test("G4 guard: no leases unloads exactly as before", async () => {
    // The installed session registry is never consulted without the
    // leases option — sessions live under `leases.sessions`.
    const fake = startFakeOmlx();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);
    setSessionRefcountRegistry(sessions);

    const client = createOmlxNativeClient(baseOpts(fake.endpoint));

    expect(await client.unload()).toStrictEqual(unloadedResult());
    expect(fake.counts.unloadPosts).toBe(1);
  });

  test("G5 guard: sessions:null opts out even with the seam installed", async () => {
    const fake = startFakeOmlx();
    const registry = createResidencyLeases();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);
    setSessionRefcountRegistry(sessions);

    const client = nativeClient(fake, { registry, workload: W, sessions: null });

    expect(await client.unload()).toStrictEqual(unloadedResult());
    expect(fake.counts.unloadPosts).toBe(1);
    expect(registry.snapshot(W).phase).toBe("unloaded");
  });

  test("G6 guard: no lease registry means the agent client unloads unfenced", async () => {
    // The documented contract is "exactly createOmlxNativeClient without
    // leases": the agent installs the session registry only together
    // with the lease registry (serve.ts maybePublishResidencyLeases).
    const fake = startFakeOmlx();
    const sessions = createSessionRefcounts({ idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => t });
    idleSession(sessions, "s1", W);
    setSessionRefcountRegistry(sessions);

    const client = agentClient(fake);

    expect(await client.unload()).toStrictEqual(unloadedResult());
    expect(fake.counts.unloadPosts).toBe(1);
  });
});
