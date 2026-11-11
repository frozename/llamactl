/**
 * #283 DF-10 — agent-side llama.cpp sleep driver with verified
 * process-stop fallback. `src/residency/llamacpp-sleep-client` lands with
 * the fix, so the module is reached through a guarded dynamic import and
 * bracket access: at the pinned base every case fails by assertion —
 * never by a missing module or a type error. The fake llama-server is a
 * Bun.serve on loopback whose POST /sleep route is programmable per case
 * (200, refusal, unsupported, hang); the verifiedStop seam is injected
 * per case and proves release by fetching the port after server.stop.
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type {
  LlamacppSleepController,
  ObservedSleepState,
  SleepCapability,
  SleepMember,
} from "@llamactl/core/residency/llamacpp-sleep";

import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createLlamacppSleepController,
  qualifySleepCapability,
} from "@llamactl/core/residency/llamacpp-sleep";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ── module under test (lands with the fix) ──────────────────────────────

type StopProof = { ok: true } | { ok: false; reason: string };
type VerifiedStop = () => Promise<StopProof>;

type SleepDriveOutcome = {
  kind: string;
  trigger?: string | undefined;
  httpStatus?: number | undefined;
  stopReason?: string | undefined;
  reason?: string | undefined;
  reservation?: string | undefined;
};

type AgentLlamacppSleepDriverOptions = {
  controller: LlamacppSleepController;
  memberId: string;
  endpoint: { host: string; port: number };
  verifiedStop: VerifiedStop;
  cacheIdentity?: string | undefined;
  sleepTimeoutMs?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

type AgentLlamacppSleepDriver = {
  sleep(): Promise<SleepDriveOutcome>;
};

type LlamacppSleepClientModule = {
  createAgentLlamacppSleepDriver(opts: AgentLlamacppSleepDriverOptions): AgentLlamacppSleepDriver;
};

// The specifier stays a runtime `string` (built from import.meta.url) so
// tsc cannot resolve the not-yet-existing module — a literal specifier
// would be a resolution error, not an assertion failure.
async function loadClientModule(): Promise<LlamacppSleepClientModule> {
  const href = new URL("../../src/residency/llamacpp-sleep-client.ts", import.meta.url).href;
  const mod = (await import(href).catch(() => ({}))) as Record<string, unknown>;
  expect(typeof mod["createAgentLlamacppSleepDriver"]).toBe("function");
  return mod as unknown as LlamacppSleepClientModule;
}

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

beforeEach(() => {
  previousRegistry = getResidencyLeaseRegistry();
  setResidencyLeaseRegistry(createResidencyLeases());
});

afterEach(async () => {
  setResidencyLeaseRegistry(previousRegistry);
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

// ── verifiedStop seams ──────────────────────────────────────────────────

type StopCounter = { count: number };

// The verified stop: stop the server, then prove the port no longer
// answers. A port that still responds means the release is unverified.
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

// Refused without touching the process: the server stays up.
function refusedVerifiedStop(stops: StopCounter): VerifiedStop {
  return () => {
    stops.count += 1;
    return Promise.resolve<StopProof>({ ok: false, reason: "EvictStopRefused" });
  };
}

function throwingVerifiedStop(stops: StopCounter): VerifiedStop {
  return () => {
    stops.count += 1;
    return Promise.reject(
      Object.assign(new Error("EvictStopRefused"), { reason: "EvictStopRefused" }),
    );
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

// a is a ready guarded 8 GiB member; b is a sleeping guarded 8 GiB member
// whose wake fits the 10 GiB budget only while a's charge is released.
function makeController(
  capabilityA: SleepCapability = GUARDED_CAPABILITY,
  stateA: ObservedSleepState = "ready",
): LlamacppSleepController {
  const controller = createLlamacppSleepController({ budgetGiB: 10 });
  controller.register(memberSpec("a", capabilityA), stateA);
  controller.register(memberSpec("b", GUARDED_CAPABILITY), "sleeping");
  return controller;
}

async function makeDriver(opts: {
  controller: LlamacppSleepController;
  fake: FakeLlama;
  verifiedStop: VerifiedStop;
  memberId?: string | undefined;
  cacheIdentity?: string | undefined;
  sleepTimeoutMs?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}): Promise<AgentLlamacppSleepDriver> {
  const mod = await loadClientModule();
  return mod.createAgentLlamacppSleepDriver({
    controller: opts.controller,
    memberId: opts.memberId ?? "a",
    endpoint: opts.fake.endpoint,
    verifiedStop: opts.verifiedStop,
    cacheIdentity: opts.cacheIdentity,
    sleepTimeoutMs: opts.sleepTimeoutMs,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
}

function snapshotMember(
  controller: LlamacppSleepController,
  id: string,
): { state: string; reservation: string } {
  const member = controller.snapshot().members[id];
  expect(member).toBeDefined();
  return member as { state: string; reservation: string };
}

// ── cases ───────────────────────────────────────────────────────────────

describe("createAgentLlamacppSleepDriver (DF-10 #283)", () => {
  test("refused sleep (409) falls back to verified stop and releases the budget", async () => {
    const fake = startFakeLlama();
    fake.state.sleepMode = 409;
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "stopped",
      trigger: "SleepRefused",
      httpStatus: 409,
      reservation: "released",
    });
    expect(stops.count).toBe(1);
    expect(fake.counts.sleepPosts).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "stopped",
      reservation: "released",
    });
    expect(controller.snapshot().committedGiB).toBe(0);
    expect(controller.requestWake("b").kind).toBe("wake");
  });

  test("unsupported sleep endpoint (404) falls back with trigger SleepUnsupported", async () => {
    const fake = startFakeLlama();
    fake.state.sleepMode = 404;
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "stopped",
      trigger: "SleepUnsupported",
      httpStatus: 404,
      reservation: "released",
    });
    expect(stops.count).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "stopped",
      reservation: "released",
    });
    expect(controller.snapshot().committedGiB).toBe(0);
    expect(controller.requestWake("b").kind).toBe("wake");
  });

  test("unsupported sleep endpoint (501) falls back with trigger SleepUnsupported", async () => {
    const fake = startFakeLlama();
    fake.state.sleepMode = 501;
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "stopped",
      trigger: "SleepUnsupported",
      httpStatus: 501,
      reservation: "released",
    });
    expect(stops.count).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "stopped",
      reservation: "released",
    });
    expect(controller.snapshot().committedGiB).toBe(0);
    expect(controller.requestWake("b").kind).toBe("wake");
  });

  test("hung sleep request times out (sleepTimeoutMs: 50) and falls back with trigger SleepTimedOut", async () => {
    const fake = startFakeLlama();
    fake.state.sleepMode = "hang";
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
      sleepTimeoutMs: 50,
    });

    const raced = await Promise.race([
      driver.sleep(),
      new Promise<"HUNG">((resolve) => {
        setTimeout(() => {
          resolve("HUNG");
        }, 2000);
      }),
    ]);
    expect(raced).not.toBe("HUNG");
    if (raced === "HUNG") {
      throw new Error("unreachable");
    }

    expect(raced).toMatchObject({
      kind: "stopped",
      trigger: "SleepTimedOut",
      reservation: "released",
    });
    expect(stops.count).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "stopped",
      reservation: "released",
    });
    expect(controller.snapshot().committedGiB).toBe(0);
  });

  test("successful sleep keeps today's path", async () => {
    const fake = startFakeLlama();
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
      cacheIdentity: "k1",
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({ kind: "slept", reservation: "released" });
    expect(stops.count).toBe(0);
    expect(fake.counts.sleepPosts).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "sleeping",
      reservation: "released",
    });
    const health = await fetch(`${fake.baseUrl}/health`);
    expect(health.ok).toBe(true);
    expect(controller.requestWake("a", { cacheIdentity: "k1" })).toMatchObject({
      kind: "wake",
      slots: "restore",
    });
  });

  test("fallback stop that fails retains the reservation", async () => {
    const fake = startFakeLlama();
    fake.state.sleepMode = 503;
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: refusedVerifiedStop(stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "stop-failed",
      trigger: "SleepRefused",
      stopReason: "EvictStopRefused",
      reservation: "uncertain",
    });
    expect(stops.count).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
    expect(controller.snapshot().committedGiB).toBe(8);
    expect(controller.requestWake("b").kind).toBe("refuse");
  });

  test("fallback stop that throws retains the reservation", async () => {
    const fake = startFakeLlama();
    fake.state.sleepMode = 503;
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: throwingVerifiedStop(stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "stop-failed",
      trigger: "SleepRefused",
      stopReason: "EvictStopRefused",
      reservation: "uncertain",
    });
    expect(stops.count).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
    expect(controller.snapshot().committedGiB).toBe(8);
    expect(controller.requestWake("b").kind).toBe("refuse");
  });

  test("process-fallback capability stops without any sleep request", async () => {
    const fake = startFakeLlama();
    const capability = qualifySleepCapability({ engine: "llamacpp" }, []);
    expect(capability).toEqual({ kind: "process-fallback", reason: "BuildUnknown" });
    const controller = makeController(capability);
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "stopped",
      trigger: "ProcessFallback",
      reservation: "released",
    });
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "stopped",
      reservation: "released",
    });
    expect(controller.snapshot().committedGiB).toBe(0);
  });

  test("process-fallback stop that fails or throws ends in the same uncertain controller state", async () => {
    const capability = qualifySleepCapability({ engine: "llamacpp" }, []);
    expect(capability.kind).toBe("process-fallback");

    async function runFailedFallback(makeStop: (stops: StopCounter) => VerifiedStop): Promise<{
      outcome: SleepDriveOutcome;
      member: { state: string; reservation: string };
      committedGiB: number;
      sleepPosts: number;
      stops: number;
    }> {
      const fake = startFakeLlama();
      const controller = makeController(capability);
      const stops: StopCounter = { count: 0 };
      const driver = await makeDriver({ controller, fake, verifiedStop: makeStop(stops) });
      const outcome = await driver.sleep();
      return {
        outcome,
        member: snapshotMember(controller, "a"),
        committedGiB: controller.snapshot().committedGiB,
        sleepPosts: fake.counts.sleepPosts,
        stops: stops.count,
      };
    }

    const refused = await runFailedFallback(refusedVerifiedStop);
    const thrown = await runFailedFallback(throwingVerifiedStop);

    const expected = {
      outcome: {
        kind: "stop-failed",
        trigger: "ProcessFallback",
        stopReason: "EvictStopRefused",
        reservation: "uncertain",
      },
      member: { state: "unknown", reservation: "uncertain" },
      committedGiB: 8,
      sleepPosts: 0,
      stops: 1,
    };
    expect(refused).toEqual(expected);
    expect(thrown).toEqual(expected);
  });

  test("unreachable sleep endpoint (connection refused) falls back with trigger SleepUnreachable", async () => {
    const fake = startFakeLlama();
    // Close the port first so the sleep POST is refused at connect time.
    await fake.stop();
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "stopped",
      trigger: "SleepUnreachable",
      reservation: "released",
    });
    expect(outcome.httpStatus).toBeUndefined();
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "stopped",
      reservation: "released",
    });
    expect(controller.snapshot().committedGiB).toBe(0);
  });

  test("inert by default without a published residency lease registry", async () => {
    setResidencyLeaseRegistry(null);
    const fake = startFakeLlama();
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({ kind: "inert", reason: "ResidencyPolicyDisabled" });
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "ready",
      reservation: "resident",
    });
    expect(controller.snapshot().committedGiB).toBe(8);
  });

  test("controller refusal does no IO", async () => {
    const fake = startFakeLlama();
    const controller = makeController();
    expect(controller.requestSleep("a").kind).toBe("sleep");
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: "AlreadySleeping",
      reservation: "held",
    });
    expect(fake.counts.sleepPosts).toBe(0);
    expect(stops.count).toBe(0);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "sleep-pending",
      reservation: "resident",
    });
  });
  // bun test fails a test on any unhandled rejection, so dropping the
  // driver's .catch on body.cancel() is already caught by the runner. The
  // cases below also make the handling observable on their own: cancel()
  // returns a rejected promise we keep, and we record every rejection
  // handler the driver attaches to it.
  type CancelRecord = { cancels: number; rejectionHandlers: number };

  function trackedCancelFetch(status: number): {
    fetch: typeof globalThis.fetch;
    record: CancelRecord;
  } {
    const record: CancelRecord = { cancels: 0, rejectionHandlers: 0 };
    const fetchImpl = (): Promise<Response> => {
      const rejected = Promise.reject(new Error("boom"));
      // Pre-handled so a missing driver handler fails our assertion below,
      // not the runner's unhandled-rejection check.
      rejected.catch(() => undefined);
      const originalThen = rejected.then.bind(rejected);
      // Promise.prototype.catch delegates to this.then, so recording then
      // covers both .then(_, onRejected) and .catch(onRejected).
      // defineProperty returns the (pre-handled) promise itself.
      void Object.defineProperty(rejected, "then", {
        value: (onFulfilled?: unknown, onRejected?: unknown): Promise<unknown> => {
          if (typeof onRejected === "function") {
            record.rejectionHandlers += 1;
          }
          return originalThen(
            onFulfilled as ((value: never) => unknown) | undefined,
            onRejected as ((reason: unknown) => unknown) | undefined,
          );
        },
      });
      const response = new Response(null, { status });
      Object.defineProperty(response, "body", {
        value: {
          cancel: (): Promise<void> => {
            record.cancels += 1;
            return rejected;
          },
        },
      });
      return Promise.resolve(response);
    };
    return { fetch: fetchImpl as unknown as typeof globalThis.fetch, record };
  }

  test("a rejecting body cancel on a 2xx sleep is handled and still sleeps", async () => {
    const fake = startFakeLlama();
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const tracked = trackedCancelFetch(200);
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
      fetch: tracked.fetch,
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({ kind: "slept", reservation: "released" });
    expect(tracked.record).toEqual({ cancels: 1, rejectionHandlers: 1 });
    expect(stops.count).toBe(0);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "sleeping",
      reservation: "released",
    });
  });

  test("a rejecting body cancel on a non-2xx sleep is handled and falls back", async () => {
    const fake = startFakeLlama();
    const controller = makeController();
    const stops: StopCounter = { count: 0 };
    const tracked = trackedCancelFetch(409);
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
      fetch: tracked.fetch,
    });

    const outcome = await driver.sleep();

    expect(outcome).toMatchObject({
      kind: "stopped",
      trigger: "SleepRefused",
      httpStatus: 409,
      reservation: "released",
    });
    expect(tracked.record).toEqual({ cancels: 1, rejectionHandlers: 1 });
    expect(stops.count).toBe(1);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "stopped",
      reservation: "released",
    });
  });

  test("process-fallback member mid-sleep is held with SleepInFlight, not stopped", async () => {
    const fake = startFakeLlama();
    const controller = makeController();
    expect(controller.requestSleep("a").kind).toBe("sleep");
    const capability = qualifySleepCapability({ engine: "llamacpp" }, []);
    expect(capability.kind).toBe("process-fallback");
    // Re-registering an existing member swaps its capability and keeps its
    // sleep-pending state.
    controller.register(memberSpec("a", capability), "ready");
    expect(snapshotMember(controller, "a")).toEqual({
      state: "sleep-pending",
      reservation: "resident",
    });
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toEqual({ kind: "refused", reason: "SleepInFlight", reservation: "held" });
    expect(stops.count).toBe(0);
    expect(fake.counts.sleepPosts).toBe(0);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "sleep-pending",
      reservation: "resident",
    });
  });

  // Every registered state that is not mid-transition accepts the 'stopped'
  // observation, so each one is process-stopped and released. 'unhealthy'
  // registers as 'unknown' in the controller, which is why both start from
  // an uncertain reservation.
  test.each<ObservedSleepState>(["unknown", "unhealthy", "sleeping", "stopped"])(
    "process-fallback member registered %s is process-stopped and released",
    async (registered) => {
      const fake = startFakeLlama();
      const capability = qualifySleepCapability({ engine: "llamacpp" }, []);
      expect(capability.kind).toBe("process-fallback");
      const controller = makeController(capability, registered);
      const stops: StopCounter = { count: 0 };
      const driver = await makeDriver({
        controller,
        fake,
        verifiedStop: releaseVerifiedStop(fake, stops),
      });

      const outcome = await driver.sleep();

      expect(outcome).toMatchObject({ kind: "stopped", trigger: "ProcessFallback" });
      expect(stops.count).toBe(1);
      expect(fake.counts.sleepPosts).toBe(0);
      expect(snapshotMember(controller, "a")).toEqual({
        state: "stopped",
        reservation: "released",
      });
    },
  );

  test("process-fallback member mid-wake is held, not stopped", async () => {
    const fake = startFakeLlama();
    const capability = qualifySleepCapability({ engine: "llamacpp" }, []);
    expect(capability.kind).toBe("process-fallback");
    const controller = makeController(capability, "loading");
    expect(snapshotMember(controller, "a")).toEqual({
      state: "waking",
      reservation: "pending",
    });
    const stops: StopCounter = { count: 0 };
    const driver = await makeDriver({
      controller,
      fake,
      verifiedStop: releaseVerifiedStop(fake, stops),
    });

    const outcome = await driver.sleep();

    expect(outcome).toEqual({ kind: "refused", reason: "WakeInFlight", reservation: "held" });
    expect(stops.count).toBe(0);
    expect(fake.counts.sleepPosts).toBe(0);
    expect(snapshotMember(controller, "a")).toEqual({
      state: "waking",
      reservation: "pending",
    });
    expect(controller.snapshot().committedGiB).toBe(8);
    const health = await fetch(`${fake.baseUrl}/health`);
    expect(health.ok).toBe(true);
  });
});
