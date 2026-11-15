/**
 * #283 DF-10 - agent-side llama.cpp WAKE driver; Part of #283.
 *
 * `src/residency/llamacpp-wake-client` lands with the fix, so the module
 * is reached through a guarded dynamic import and bracket access: at the
 * pinned base every case fails by assertion — never by a missing module
 * or a type error. The fake llama-server is a Bun.serve on loopback
 * whose POST /wake, GET /props and POST /slots/:id routes are
 * programmable per case (status, queued probe responses, hang). An
 * ordered event log plus per-route auth capture prove the driver polls
 * readiness before restoring a slot and carries the bearer key on every
 * request.
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type {
  LlamacppSleepController,
  SleepCapability,
  SleepMember,
} from "@llamactl/core/residency/llamacpp-sleep";

import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { createLlamacppSleepController } from "@llamactl/core/residency/llamacpp-sleep";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSharedBudgetSleepController } from "../../src/residency/llamacpp-sleep-client.js";
import { createTargetAdmissionAuthority } from "../../src/workload/admission.js";

// ── module under test (lands with the fix) ──────────────────────────────

type WakeSlotRestoreReport = {
  ok: boolean;
  reason?: string;
  httpStatus?: number;
  tokensRestored?: number;
};

type WakeDriveOutcome =
  | {
      kind: "woke";
      slots: "restore" | "discard";
      tokensRestored?: number;
      slotRestore?: WakeSlotRestoreReport;
    }
  | { kind: "wake-failed"; outcome: "cancelled" | "readiness-failed" }
  | { kind: "joined" }
  | { kind: "already-awake" }
  | { kind: "process-switch"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "inert"; reason: "ResidencyPolicyDisabled" };

type LlamacppWakeDriverOptions = {
  controller: LlamacppSleepController;
  memberId: string;
  endpoint: { host: string; port: number };
  apiKey?: string;
  cacheIdentity?: string;
  slot?: { id: number; filename: string };
  wakeTimeoutMs?: number;
  readinessPollMs?: number;
  readinessTimeoutMs?: number;
  slotRestoreTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

type LlamacppWakeDriver = {
  wake(opts?: { signal?: AbortSignal; cacheIdentity?: string }): Promise<WakeDriveOutcome>;
};

type LlamacppWakeClientModule = {
  createLlamacppWakeDriver(opts: LlamacppWakeDriverOptions): LlamacppWakeDriver;
  createAgentLlamacppWakeDriver(opts: LlamacppWakeDriverOptions): LlamacppWakeDriver;
};

// The specifier stays a runtime `string` (built from import.meta.url) so
// tsc cannot resolve the not-yet-existing module — a literal specifier
// would be a resolution error, not an assertion failure.
async function loadWakeModule(): Promise<LlamacppWakeClientModule> {
  const href = new URL("../../src/residency/llamacpp-wake-client.ts", import.meta.url).href;
  const mod = (await import(href).catch(() => ({}))) as Record<string, unknown>;
  expect(typeof mod["createLlamacppWakeDriver"]).toBe("function");
  return mod as unknown as LlamacppWakeClientModule;
}

async function loadAgentWakeModule(): Promise<LlamacppWakeClientModule> {
  const href = new URL("../../src/residency/llamacpp-wake-client.ts", import.meta.url).href;
  const mod = (await import(href).catch(() => ({}))) as Record<string, unknown>;
  expect(typeof mod["createAgentLlamacppWakeDriver"]).toBe("function");
  return mod as unknown as LlamacppWakeClientModule;
}

// ── fake llama-server ───────────────────────────────────────────────────

type WakeMode = "ok" | number | "hang";
// An object entry is the 200 /props body verbatim, so a case can serve a
// body with no is_sleeping field at all.
type PropsEntry = number | Record<string, unknown> | "hang";
type SlotMode = number | Record<string, unknown> | "hang";

type SlotRequestRecord = {
  pathname: string;
  action: string | null;
  body: unknown;
  authorization: string | null;
};

type FakeLlamaState = {
  wakeMode: WakeMode;
  propsQueue: PropsEntry[];
  slotMode: SlotMode;
  onWakePost?: (() => void) | undefined;
  onPropsGet?: (() => void) | undefined;
  onSlotPost?: (() => void) | undefined;
};

type FakeLlamaCounts = { wakePosts: number; propsGets: number; slotPosts: number };

type FakeLlamaAuth = {
  wake: (string | null)[];
  props: (string | null)[];
  slots: (string | null)[];
};

type FakeLlama = {
  endpoint: { host: string; port: number };
  baseUrl: string;
  state: FakeLlamaState;
  events: string[];
  counts: FakeLlamaCounts;
  auth: FakeLlamaAuth;
  slotRequests: SlotRequestRecord[];
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

function propsEvent(entry: PropsEntry): string {
  if (entry === "hang") {
    return "props:hang";
  }
  if (typeof entry === "number") {
    return `props:${String(entry)}`;
  }
  if (!("is_sleeping" in entry)) {
    return "props:no-is-sleeping";
  }
  return entry["is_sleeping"] === true ? "props:sleeping" : "props:ready";
}

function startFakeLlama(): FakeLlama {
  const state: FakeLlamaState = { wakeMode: "ok", propsQueue: [], slotMode: {} };
  const events: string[] = [];
  const counts: FakeLlamaCounts = { wakePosts: 0, propsGets: 0, slotPosts: 0 };
  const auth: FakeLlamaAuth = { wake: [], props: [], slots: [] };
  const slotRequests: SlotRequestRecord[] = [];
  let propsIndex = 0;

  // The queue pops one entry per GET; once drained the last entry repeats,
  // so a single-element queue is the "always" fixture. An empty queue
  // answers 503 — still waking — so an unconfigured probe cannot pass.
  const nextPropsEntry = (): PropsEntry => {
    const queue = state.propsQueue;
    if (queue.length === 0) {
      return 503;
    }
    const entry = queue[Math.min(propsIndex, queue.length - 1)];
    propsIndex += 1;
    return entry ?? 503;
  };

  const handleWake = async (req: Request): Promise<Response> => {
    counts.wakePosts += 1;
    events.push("wake");
    auth.wake.push(req.headers.get("authorization"));
    state.onWakePost?.();
    const mode = state.wakeMode;
    if (mode === "hang") {
      return await hangResponse();
    }
    if (mode === "ok") {
      return Response.json({});
    }
    return Response.json({ error: `wake refused with ${String(mode)}` }, { status: mode });
  };

  const handleProps = async (req: Request): Promise<Response> => {
    counts.propsGets += 1;
    const entry = nextPropsEntry();
    events.push(propsEvent(entry));
    auth.props.push(req.headers.get("authorization"));
    state.onPropsGet?.();
    if (entry === "hang") {
      return await hangResponse();
    }
    if (typeof entry === "number") {
      return Response.json({ error: `props responded ${String(entry)}` }, { status: entry });
    }
    return Response.json(entry);
  };

  const handleSlot = async (req: Request, url: URL): Promise<Response> => {
    counts.slotPosts += 1;
    events.push("restore");
    auth.slots.push(req.headers.get("authorization"));
    const body: unknown = await req.json().catch(() => null);
    slotRequests.push({
      pathname: url.pathname,
      action: url.searchParams.get("action"),
      body,
      authorization: req.headers.get("authorization"),
    });
    state.onSlotPost?.();
    const mode = state.slotMode;
    if (mode === "hang") {
      return await hangResponse();
    }
    if (typeof mode === "number") {
      return Response.json({ error: `slot action failed with ${String(mode)}` }, { status: mode });
    }
    return Response.json(mode);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/wake") {
        return await handleWake(req);
      }
      if (req.method === "GET" && url.pathname === "/props") {
        return await handleProps(req);
      }
      if (req.method === "POST" && url.pathname.startsWith("/slots/")) {
        return await handleSlot(req, url);
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
    events,
    counts,
    auth,
    slotRequests,
    stop,
  };
  llamas.push(fake);
  return fake;
}

// ── controller + driver fixtures ────────────────────────────────────────

const GUARDED_CAPABILITY: SleepCapability = {
  kind: "guarded-sleep",
  fork: "ggml-org",
  build: "b1",
};

function memberB(capability: SleepCapability = GUARDED_CAPABILITY): SleepMember {
  return {
    id: "b",
    runtimeKey: "rk-b",
    specDigest: "d-b",
    allocationGiB: 8,
    capability,
  };
}

// b is a sleeping guarded 8 GiB member; an 8 GiB wake fits the 10 GiB
// budget once its released reservation stops counting.
function makeController(): LlamacppSleepController {
  const controller = createLlamacppSleepController({ budgetGiB: 10 });
  controller.register(memberB(), "sleeping");
  return controller;
}

// The restore path: b slept with cacheIdentity recorded, so a wake
// carrying the same identity decides slots "restore".
function sleptController(cacheIdentity: string): LlamacppSleepController {
  const controller = createLlamacppSleepController({ budgetGiB: 10 });
  controller.register(memberB(), "ready");
  expect(controller.requestSleep("b").kind).toBe("sleep");
  controller.sleepSettled("b", "slept", cacheIdentity);
  return controller;
}

type WakeDriverFixture = {
  controller: LlamacppSleepController;
  fake: FakeLlama;
  memberId?: string | undefined;
  apiKey?: string | undefined;
  cacheIdentity?: string | undefined;
  slot?: { id: number; filename: string } | undefined;
  readinessPollMs?: number | undefined;
  readinessTimeoutMs?: number | undefined;
  slotRestoreTimeoutMs?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

function wakeDriverOptions(fixture: WakeDriverFixture): LlamacppWakeDriverOptions {
  return {
    controller: fixture.controller,
    memberId: fixture.memberId ?? "b",
    endpoint: fixture.fake.endpoint,
    readinessPollMs: fixture.readinessPollMs ?? 5,
    readinessTimeoutMs: fixture.readinessTimeoutMs ?? 150,
    wakeTimeoutMs: 200,
    slotRestoreTimeoutMs: fixture.slotRestoreTimeoutMs ?? 200,
    ...(fixture.apiKey !== undefined ? { apiKey: fixture.apiKey } : {}),
    ...(fixture.cacheIdentity !== undefined ? { cacheIdentity: fixture.cacheIdentity } : {}),
    ...(fixture.slot !== undefined ? { slot: fixture.slot } : {}),
    ...(fixture.fetch !== undefined ? { fetch: fixture.fetch } : {}),
  };
}

async function makeWakeDriver(fixture: WakeDriverFixture): Promise<LlamacppWakeDriver> {
  const mod = await loadWakeModule();
  return mod.createLlamacppWakeDriver(wakeDriverOptions(fixture));
}

async function makeAgentWakeDriver(fixture: WakeDriverFixture): Promise<LlamacppWakeDriver> {
  const mod = await loadAgentWakeModule();
  return mod.createAgentLlamacppWakeDriver(wakeDriverOptions(fixture));
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

describe("llama.cpp wake driver (DF-10 #283)", () => {
  test("wake polls readiness past 503 and is_sleeping:true, then settles ready with slots discard", async () => {
    // Kills settling ready as soon as the wake POST returns 2xx without
    // probing, and treating any 200 /props — is_sleeping:true included —
    // or a 503 as ready.
    const fake = startFakeLlama();
    fake.state.propsQueue = [503, { is_sleeping: true }, { is_sleeping: false }];
    const controller = makeController();
    const driver = await makeWakeDriver({ controller, fake });

    const outcome = await driver.wake({});

    expect(outcome).toEqual({ kind: "woke", slots: "discard" });
    expect(fake.events).toEqual(["wake", "props:503", "props:sleeping", "props:ready"]);
    expect(fake.counts.slotPosts).toBe(0);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "ready",
      reservation: "resident",
    });
  });

  test("matching cacheIdentity restores the slot after readiness", async () => {
    // Kills restoring before the readiness probe, skipping the restore,
    // dropping applyAuth, and reporting slots "restore" without the
    // n_restored count.
    const fake = startFakeLlama();
    fake.state.propsQueue = [503, { is_sleeping: true }, { is_sleeping: false }];
    fake.state.slotMode = { n_restored: 42 };
    const controller = sleptController("kv-1");
    const driver = await makeWakeDriver({
      controller,
      fake,
      apiKey: "test-key",
      cacheIdentity: "kv-1",
      slot: { id: 0, filename: "b.kvslot" },
    });

    const outcome = await driver.wake({ cacheIdentity: "kv-1" });

    expect(outcome).toEqual({ kind: "woke", slots: "restore", tokensRestored: 42 });
    expect(fake.events).toEqual(["wake", "props:503", "props:sleeping", "props:ready", "restore"]);
    expect(fake.slotRequests).toHaveLength(1);
    expect(fake.slotRequests[0]).toMatchObject({ pathname: "/slots/0", action: "restore" });
    expect(fake.slotRequests[0]?.body).toMatchObject({ filename: "b.kvslot" });
    expect(fake.auth).toEqual({
      wake: ["Bearer test-key"],
      props: ["Bearer test-key", "Bearer test-key", "Bearer test-key"],
      slots: ["Bearer test-key"],
    });
    expect(snapshotMember(controller, "b")).toEqual({
      state: "ready",
      reservation: "resident",
    });
  });

  test("readiness deadline settles readiness-failed and the shared claim stays uncertain", async () => {
    // Kills returning ready — or releasing the shared claim via
    // observe('sleeping') — when the readiness deadline fires, continuing
    // on to a slot restore after a readiness failure, and counting a 200
    // /props with no is_sleeping field (a populated body, then {}) as
    // awake: only an explicit is_sleeping:false is ready.
    const fake = startFakeLlama();
    fake.state.propsQueue = [503, { total_slots: 1, model_path: "/m/b.gguf" }, {}];
    const authority = createTargetAdmissionAuthority();
    const controller = createSharedBudgetSleepController({
      authority,
      targetIdentity: "node-a",
      budgetGiB: () => 16,
    });
    controller.register(memberB(), "sleeping");
    const driver = await makeWakeDriver({ controller, fake });

    const started = Date.now();
    const outcome = await driver.wake({});
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
    expect(elapsed).toBeLessThan(2000);
    expect(fake.events.slice(0, 4)).toEqual([
      "wake",
      "props:503",
      "props:no-is-sleeping",
      "props:no-is-sleeping",
    ]);
    expect(fake.events).not.toContain("props:ready");
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
    expect(authority.snapshot("node-a").find((c) => c.runtimeKey === "rk-b")).toMatchObject({
      state: "uncertain",
      allocationGiB: 8,
    });
    expect(fake.counts.slotPosts).toBe(0);
  });

  test("a hanging /props probe is still bounded by the readiness deadline", async () => {
    // Kills dropping the deadline signal from each probe fetch — without
    // it the hung /props holds the wake open until the test times out.
    const fake = startFakeLlama();
    fake.state.propsQueue = ["hang"];
    const controller = makeController();
    const driver = await makeWakeDriver({ controller, fake });

    const started = Date.now();
    const outcome = await driver.wake({});
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
    expect(elapsed).toBeLessThan(2000);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
  });

  test("a readiness deadline that fires during a poll sleep settles readiness-failed", async () => {
    // Kills returning ready when the loop wakes from the poll sleep to
    // find the readiness deadline already fired.
    const fake = startFakeLlama();
    fake.state.propsQueue = [503];
    const controller = makeController();
    const driver = await makeWakeDriver({
      controller,
      fake,
      readinessPollMs: 3000,
      readinessTimeoutMs: 100,
    });

    const started = Date.now();
    const outcome = await driver.wake({});
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
    expect(elapsed).toBeLessThan(1500);
    expect(fake.counts.propsGets).toBe(1);
    expect(fake.counts.slotPosts).toBe(0);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
  });

  test("abort mid-wake settles cancelled", async () => {
    // Kills mapping an abort that rejects an in-flight probe fetch to
    // readiness-failed: the abort fires inside the second GET handler. A
    // fetch that ignored the signal still gets its 503 and the 5 ms poll
    // sleep ends on its own, so the probe-fetch signal, the poll-sleep
    // abort listener and the loop-top abort check are pinned by the
    // hanging-/props and long-poll abort cases instead.
    const fake = startFakeLlama();
    fake.state.propsQueue = [503];
    const controller = makeController();
    const driver = await makeWakeDriver({
      controller,
      fake,
      readinessTimeoutMs: 30000,
    });
    const aborter = new AbortController();
    let propsSeen = 0;
    fake.state.onPropsGet = (): void => {
      propsSeen += 1;
      if (propsSeen === 2) {
        aborter.abort();
      }
    };

    const started = Date.now();
    const outcome = await driver.wake({ signal: aborter.signal });
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "cancelled" });
    expect(elapsed).toBeLessThan(2000);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
    expect(fake.counts.slotPosts).toBe(0);
  });

  test("abort during a hanging /props probe settles cancelled well before the deadline", async () => {
    // Kills dropping the external signal from the probe fetch (deadline
    // only): the hung GET then holds the wake open until the 3 s
    // readiness deadline instead of ending on the abort.
    const fake = startFakeLlama();
    fake.state.propsQueue = ["hang"];
    const controller = makeController();
    const driver = await makeWakeDriver({ controller, fake, readinessTimeoutMs: 3000 });
    const aborter = new AbortController();
    fake.state.onPropsGet = (): void => {
      aborter.abort();
    };

    const started = Date.now();
    const outcome = await driver.wake({ signal: aborter.signal });
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "cancelled" });
    expect(elapsed).toBeLessThan(1000);
    expect(fake.counts.propsGets).toBe(1);
    expect(fake.counts.slotPosts).toBe(0);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
  });

  test("abort during a long poll sleep settles cancelled without waiting out the interval", async () => {
    // Kills the poll sleep ignoring the external signal — whether the
    // abort listener is dropped or the signal is not passed at all — since
    // the 3 s sleep then runs to completion before the loop sees the abort,
    // and mapping the abort seen at the top of the poll loop to
    // readiness-failed.
    const fake = startFakeLlama();
    fake.state.propsQueue = [503];
    const controller = makeController();
    const driver = await makeWakeDriver({
      controller,
      fake,
      readinessPollMs: 3000,
      readinessTimeoutMs: 30000,
    });
    const aborter = new AbortController();
    fake.state.onPropsGet = (): void => {
      setTimeout(() => {
        aborter.abort();
      }, 200);
    };

    const started = Date.now();
    const outcome = await driver.wake({ signal: aborter.signal });
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "cancelled" });
    expect(elapsed).toBeLessThan(1500);
    expect(fake.counts.propsGets).toBe(1);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
  });

  test("abort during a hanging wake POST settles cancelled and the shared claim stays uncertain", async () => {
    // Kills mapping an abort of the in-flight wake POST to
    // readiness-failed, and probing /props after the POST was cancelled.
    const fake = startFakeLlama();
    fake.state.wakeMode = "hang";
    fake.state.propsQueue = [{ is_sleeping: false }];
    const authority = createTargetAdmissionAuthority();
    const controller = createSharedBudgetSleepController({
      authority,
      targetIdentity: "node-a",
      budgetGiB: () => 16,
    });
    controller.register(memberB(), "sleeping");
    const driver = await makeWakeDriver({ controller, fake });
    const aborter = new AbortController();
    fake.state.onWakePost = (): void => {
      aborter.abort();
    };

    const outcome = await driver.wake({ signal: aborter.signal });

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "cancelled" });
    expect(fake.counts.wakePosts).toBe(1);
    expect(fake.counts.propsGets).toBe(0);
    expect(fake.counts.slotPosts).toBe(0);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
    expect(authority.snapshot("node-a").find((c) => c.runtimeKey === "rk-b")).toMatchObject({
      state: "uncertain",
      allocationGiB: 8,
    });
  });

  test("an already-aborted signal refuses with no IO and no charge", async () => {
    // Kills removing the pre-admission abort check — without it
    // requestWake charges the member and the wake proceeds to IO.
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    const controller = makeController();
    const driver = await makeWakeDriver({ controller, fake });
    const aborter = new AbortController();
    aborter.abort();

    const outcome = await driver.wake({ signal: aborter.signal });

    expect(outcome).toEqual({ kind: "refused", reason: "WakeAborted" });
    expect(fake.counts.wakePosts).toBe(0);
    expect(fake.counts.propsGets).toBe(0);
    expect(fake.counts.slotPosts).toBe(0);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "sleeping",
      reservation: "released",
    });
    expect(controller.snapshot().committedGiB).toBe(0);
  });

  test("slot restore HTTP failure is documented: wake still ready, cache reported cold", async () => {
    // Kills settling readiness-failed on a restore failure, and
    // reporting slots "restore" after the restore was refused.
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    fake.state.slotMode = 500;
    const controller = sleptController("kv-1");
    const driver = await makeWakeDriver({
      controller,
      fake,
      cacheIdentity: "kv-1",
      slot: { id: 0, filename: "b.kvslot" },
    });

    const outcome = await driver.wake({ cacheIdentity: "kv-1" });

    expect(outcome).toEqual({
      kind: "woke",
      slots: "discard",
      slotRestore: { ok: false, reason: "SlotRestoreFailed", httpStatus: 500 },
    });
    expect(fake.counts.slotPosts).toBe(1);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "ready",
      reservation: "resident",
    });
  });

  test("a 2xx restore without numeric n_restored is SlotRestoreInvalidResponse", async () => {
    // Kills accepting any 2xx slot response as a successful restore.
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    fake.state.slotMode = {};
    const controller = sleptController("kv-1");
    const driver = await makeWakeDriver({
      controller,
      fake,
      cacheIdentity: "kv-1",
      slot: { id: 0, filename: "b.kvslot" },
    });

    const outcome = await driver.wake({ cacheIdentity: "kv-1" });

    expect(outcome).toEqual({
      kind: "woke",
      slots: "discard",
      slotRestore: { ok: false, reason: "SlotRestoreInvalidResponse" },
    });
    expect(fake.counts.slotPosts).toBe(1);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "ready",
      reservation: "resident",
    });
  });

  test("the driver-level cacheIdentity alone selects the slot restore", async () => {
    // Kills dropping the ctx.cacheIdentity fallback in wake(): with no
    // per-call identity the controller would decide slots "discard" and
    // the restore would never be posted.
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    fake.state.slotMode = { n_restored: 7 };
    const controller = sleptController("kv-1");
    const driver = await makeWakeDriver({
      controller,
      fake,
      cacheIdentity: "kv-1",
      slot: { id: 0, filename: "b.kvslot" },
    });

    const outcome = await driver.wake({});

    expect(outcome).toEqual({ kind: "woke", slots: "restore", tokensRestored: 7 });
    expect(fake.events).toEqual(["wake", "props:ready", "restore"]);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "ready",
      reservation: "resident",
    });
  });

  test("a hanging slot restore past slotRestoreTimeoutMs is SlotRestoreTimedOut, member still ready", async () => {
    // Kills swapping SlotRestoreTimedOut and SlotRestoreUnreachable: the
    // restore deadline firing is a timeout, not an unreachable engine.
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    fake.state.slotMode = "hang";
    const controller = sleptController("kv-1");
    const driver = await makeWakeDriver({
      controller,
      fake,
      cacheIdentity: "kv-1",
      slot: { id: 0, filename: "b.kvslot" },
      slotRestoreTimeoutMs: 50,
    });

    const started = Date.now();
    const outcome = await driver.wake({ cacheIdentity: "kv-1" });
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({
      kind: "woke",
      slots: "discard",
      slotRestore: { ok: false, reason: "SlotRestoreTimedOut" },
    });
    expect(elapsed).toBeLessThan(2000);
    expect(fake.counts.slotPosts).toBe(1);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "ready",
      reservation: "resident",
    });
  });

  test("a restore fetch that rejects outright is SlotRestoreUnreachable, member still ready", async () => {
    // Kills swapping SlotRestoreTimedOut and SlotRestoreUnreachable: a
    // connection-level rejection with no deadline fired is unreachable.
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    fake.state.slotMode = { n_restored: 7 };
    const controller = sleptController("kv-1");
    const realFetch = globalThis.fetch;
    const restoreUnreachableFetch = (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      const href = input instanceof Request ? input.url : String(input);
      if (new URL(href).pathname.startsWith("/slots/")) {
        return Promise.reject(new TypeError("fetch failed: connect ECONNREFUSED"));
      }
      return realFetch(input, init);
    };
    const driver = await makeWakeDriver({
      controller,
      fake,
      cacheIdentity: "kv-1",
      slot: { id: 0, filename: "b.kvslot" },
      fetch: restoreUnreachableFetch as typeof globalThis.fetch,
    });

    const outcome = await driver.wake({ cacheIdentity: "kv-1" });

    expect(outcome).toEqual({
      kind: "woke",
      slots: "discard",
      slotRestore: { ok: false, reason: "SlotRestoreUnreachable" },
    });
    expect(fake.counts.wakePosts).toBe(1);
    expect(fake.counts.slotPosts).toBe(0);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "ready",
      reservation: "resident",
    });
  });

  test("abort during slot restore settles cancelled", async () => {
    // Kills ignoring the external signal on the slot-restore fetch —
    // without it the hung POST holds the wake open until the test times
    // out, and mapping the abort to readiness-failed is equally wrong.
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    fake.state.slotMode = "hang";
    const controller = sleptController("kv-1");
    const driver = await makeWakeDriver({
      controller,
      fake,
      cacheIdentity: "kv-1",
      slot: { id: 0, filename: "b.kvslot" },
      slotRestoreTimeoutMs: 30000,
    });
    const aborter = new AbortController();
    fake.state.onSlotPost = (): void => {
      aborter.abort();
    };

    const started = Date.now();
    const outcome = await driver.wake({ signal: aborter.signal, cacheIdentity: "kv-1" });
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "cancelled" });
    expect(elapsed).toBeLessThan(2000);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
  });

  test("a rejected wake POST (409) settles readiness-failed with zero probes", async () => {
    // Kills probing /props after a non-2xx wake POST.
    const fake = startFakeLlama();
    fake.state.wakeMode = 409;
    fake.state.propsQueue = [{ is_sleeping: false }];
    const controller = makeController();
    const driver = await makeWakeDriver({ controller, fake });

    const outcome = await driver.wake({});

    expect(outcome).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
    expect(fake.counts.propsGets).toBe(0);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
  });

  test("process-fallback member returns process-switch with zero HTTP", async () => {
    // Kills issuing the wake POST before the controller decision —
    // process-fallback members must never touch the engine endpoint.
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    const controller = createLlamacppSleepController({ budgetGiB: 10 });
    controller.register(memberB({ kind: "process-fallback", reason: "NotQualified" }), "sleeping");
    const driver = await makeWakeDriver({ controller, fake });

    const outcome = await driver.wake({});

    expect(outcome).toEqual({ kind: "process-switch", reason: "NotQualified" });
    expect(fake.counts.wakePosts).toBe(0);
    expect(fake.counts.propsGets).toBe(0);
    expect(fake.counts.slotPosts).toBe(0);
  });

  test("createAgentLlamacppWakeDriver is inert without a published lease registry", async () => {
    // Kills dropping the residency-registry gate on the agent driver.
    setResidencyLeaseRegistry(null);
    const fake = startFakeLlama();
    fake.state.propsQueue = [{ is_sleeping: false }];
    const controller = makeController();
    const driver = await makeAgentWakeDriver({ controller, fake });

    const outcome = await driver.wake({});

    expect(outcome).toEqual({ kind: "inert", reason: "ResidencyPolicyDisabled" });
    expect(fake.counts.wakePosts).toBe(0);
    expect(fake.counts.propsGets).toBe(0);
    expect(fake.counts.slotPosts).toBe(0);
    expect(snapshotMember(controller, "b")).toEqual({
      state: "sleeping",
      reservation: "released",
    });
  });
});
