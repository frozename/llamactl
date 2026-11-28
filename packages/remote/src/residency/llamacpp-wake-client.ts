/**
 * DF-10 (#283) agent-side llama.cpp wake driver; not wired into the
 * reconciler or agent start (Part of #283).
 */
import type { DrainToken, ResidencyLeases } from "@llamactl/core/residency/leases";
import type { LlamacppSleepController } from "@llamactl/core/residency/llamacpp-sleep";

import { resolveEnv } from "@llamactl/core/env";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { hasManagedRuntimeMarker } from "@llamactl/core/residency/managed-runtime";

import { applyAuth, buildBaseUrl, classifyFetchError } from "./engine-client.js";
import { type LlamacppWakeOutcome, wakeLlamacppMember } from "./llamacpp-sleep-client.js";

// ── Public types ──────────────────────────────────────────────────────────

export type LlamacppWakeSlotRestoreFailure = {
  ok: false;
  reason:
    | "SlotRestoreFailed"
    | "SlotRestoreInvalidResponse"
    | "SlotRestoreTimedOut"
    | "SlotRestoreUnreachable";
  httpStatus?: number;
};

export type LlamacppWakeDriveOutcome =
  | Exclude<LlamacppWakeOutcome, { kind: "woke" }>
  | { kind: "woke"; slots: "restore"; tokensRestored: number }
  | { kind: "woke"; slots: "discard"; slotRestore?: LlamacppWakeSlotRestoreFailure }
  | { kind: "inert"; reason: "ResidencyPolicyDisabled" | "ManagedWakeProofRequired" };

type WakeEndpoint = Readonly<{ host: string; port: number }>;

type ManagedWakeRuntime = Readonly<{
  workload: string;
  specDigest: string;
  pid: number;
  birthId: string;
  endpoint: WakeEndpoint;
}>;

type ManagedWakePin = Readonly<{
  memberId: string;
  runtime: ManagedWakeRuntime;
  sleepDrain: Readonly<DrainToken>;
  claim: Readonly<{ claimId: string; fenceToken: string; allocationGiB: number }>;
}>;

/** Only the target owner can supply a native listener observation and fenced durable claim. */
export type ManagedLlamacppWakeProof = {
  sleepRegistry: ResidencyLeases;
  pin: ManagedWakePin;
  /** Observe the process birth and its current listener, stopping at the supplied deadline. */
  observeRuntime(pin: ManagedWakePin, signal: AbortSignal): Promise<ManagedWakeRuntime | undefined>;
  /** Confirm this exact pending claim still covers the wake against fresh physical capacity. */
  isReserved(pin: ManagedWakePin): boolean;
  /** Claims exclusive dispatch of this already reserved wake without releasing its charge. */
  beginDispatch(pin: ManagedWakePin): boolean;
  qualifiedReady(pin: ManagedWakePin, props: unknown): boolean;
  commitReady(pin: ManagedWakePin): boolean;
  markUncertain(pin: ManagedWakePin): void;
};

export type LlamacppWakeDriverOptions = {
  controller: LlamacppSleepController;
  memberId: string;
  endpoint: WakeEndpoint;
  wakePath?: string;
  readinessPath?: string;
  apiKey?: string;
  cacheIdentity?: string;
  slot?: { id: number; filename: string };
  wakeTimeoutMs?: number;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  slotRestoreTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  managed?: ManagedLlamacppWakeProof;
};

export type LlamacppWakeDriver = {
  wake(opts?: { signal?: AbortSignal; cacheIdentity?: string }): Promise<LlamacppWakeDriveOutcome>;
};

// ── Driver implementation ────────────────────────────────────────────────

type WakeStartOutcome = "ready" | "cancelled" | "readiness-failed";

type SlotRestoreResult =
  | { ok: true; tokensRestored: number }
  | { ok: false; failure: LlamacppWakeSlotRestoreFailure };

type WakeAttemptResult = {
  outcome: WakeStartOutcome;
  slotRestore: SlotRestoreResult | undefined;
};

type WakeDriverContext = {
  controller: LlamacppSleepController;
  memberId: string;
  baseUrl: string;
  wakePath: string;
  readinessPath: string;
  apiKey: string | undefined;
  cacheIdentity: string | undefined;
  slot: { id: number; filename: string } | undefined;
  wakeTimeoutMs: number;
  readinessTimeoutMs: number;
  readinessPollMs: number;
  slotRestoreTimeoutMs: number;
  base: typeof globalThis.fetch;
  managed?: ManagedWakeGuard;
};

class ManagedWakeProofLostError extends Error {}

type ManagedWakeGuard = {
  verifyRuntime(signal: AbortSignal): Promise<boolean>;
  stillReserved(): boolean;
  beginDispatch(): boolean;
  qualifiedReady(props: unknown): boolean;
  publishReady(): boolean;
  retainIfUnsettled(): void;
};

function endpointMatches(a: WakeEndpoint, b: WakeEndpoint): boolean {
  return a.host === b.host && a.port === b.port;
}

function runtimeMatches(actual: ManagedWakeRuntime, expected: ManagedWakeRuntime): boolean {
  return (
    actual.workload === expected.workload &&
    actual.specDigest === expected.specDigest &&
    actual.pid === expected.pid &&
    actual.birthId === expected.birthId &&
    endpointMatches(actual.endpoint, expected.endpoint)
  );
}

function validWakePin(pin: ManagedWakePin, ctx: WakeDriverContext): boolean {
  const { runtime, sleepDrain, claim } = pin;
  return (
    pin.memberId === ctx.memberId &&
    runtime.workload.trim().length > 0 &&
    runtime.specDigest.length > 0 &&
    Number.isSafeInteger(runtime.pid) &&
    runtime.pid > 0 &&
    runtime.birthId.length > 0 &&
    (runtime.endpoint.host === "127.0.0.1" || runtime.endpoint.host === "::1") &&
    Number.isSafeInteger(runtime.endpoint.port) &&
    runtime.endpoint.port > 0 &&
    runtime.endpoint.port <= 65535 &&
    buildBaseUrl(runtime.endpoint.host, runtime.endpoint.port) === ctx.baseUrl &&
    sleepDrain.workload === runtime.workload &&
    Number.isSafeInteger(sleepDrain.epoch) &&
    sleepDrain.epoch > 0 &&
    claim.claimId.length > 0 &&
    claim.fenceToken.length > 0 &&
    Number.isFinite(claim.allocationGiB) &&
    claim.allocationGiB > 0 &&
    ctx.wakePath === "/wake" &&
    ctx.readinessPath === "/props"
  );
}

function bindManagedWakeGuard(
  proof: ManagedLlamacppWakeProof,
  registry: ResidencyLeases,
): ManagedWakeGuard {
  const pin = Object.freeze({
    ...proof.pin,
    runtime: Object.freeze({
      ...proof.pin.runtime,
      endpoint: Object.freeze({ ...proof.pin.runtime.endpoint }),
    }),
    sleepDrain: Object.freeze({ ...proof.pin.sleepDrain }),
    claim: Object.freeze({ ...proof.pin.claim }),
  });
  let dispatched = false;
  let published = false;
  const ownsDrain = (): boolean => {
    if (getResidencyLeaseRegistry() !== registry) return false;
    const snapshot = registry.snapshot(pin.runtime.workload);
    return snapshot.phase === "unloaded" && snapshot.epoch === pin.sleepDrain.epoch;
  };
  const stillReserved = (): boolean => proof.isReserved(pin) && ownsDrain();
  return {
    stillReserved,
    async verifyRuntime(signal): Promise<boolean> {
      if (signal.aborted || !stillReserved()) return false;
      const actual = await proof.observeRuntime(pin, signal);
      return actual !== undefined && runtimeMatches(actual, pin.runtime);
    },
    beginDispatch(): boolean {
      dispatched = proof.beginDispatch(pin);
      return dispatched;
    },
    qualifiedReady: (props) => proof.qualifiedReady(pin, props),
    publishReady(): boolean {
      published =
        stillReserved() && proof.commitReady(pin) && ownsDrain() && registry.reopen(pin.sleepDrain);
      return published;
    },
    retainIfUnsettled(): void {
      if (!dispatched || published) return;
      try {
        proof.markUncertain(pin);
      } catch {
        // The pre-reserved charge stays held while its durable outcome is unavailable.
      }
    },
  };
}

async function verifyManagedRuntime(managed: ManagedWakeGuard, signal: AbortSignal): Promise<void> {
  let verified = false;
  try {
    verified = await managed.verifyRuntime(signal);
  } catch {
    // A failed listener observation cannot identify the sleeping generation.
  }
  if (!verified) {
    throw new ManagedWakeProofLostError();
  }
}

function checkManagedReservation(managed: ManagedWakeGuard, signal: AbortSignal): void {
  if (signal.aborted || !managed.stillReserved()) throw new ManagedWakeProofLostError();
}

function reportWake(
  outcome: LlamacppWakeOutcome,
  slotRestore: SlotRestoreResult | undefined,
): LlamacppWakeDriveOutcome {
  if (outcome.kind !== "woke") return outcome;
  if (slotRestore === undefined) return { kind: "woke", slots: "discard" };
  return slotRestore.ok
    ? { kind: "woke", slots: "restore", tokensRestored: slotRestore.tokensRestored }
    : { kind: "woke", slots: "discard", slotRestore: slotRestore.failure };
}

export function createLlamacppWakeDriver(opts: LlamacppWakeDriverOptions): LlamacppWakeDriver {
  const registry = getResidencyLeaseRegistry();
  const runtimeDir = resolveEnv().LOCAL_AI_RUNTIME_DIR;
  const initiallyManaged = hasManagedRuntimeMarker(runtimeDir);
  const managed = opts.managed;
  const ctx: WakeDriverContext = {
    controller: opts.controller,
    memberId: opts.memberId,
    baseUrl: buildBaseUrl(opts.endpoint.host, opts.endpoint.port),
    wakePath: opts.wakePath ?? "/wake",
    readinessPath: opts.readinessPath ?? "/props",
    apiKey: opts.apiKey,
    cacheIdentity: opts.cacheIdentity,
    slot: opts.slot === undefined ? undefined : { ...opts.slot },
    wakeTimeoutMs: opts.wakeTimeoutMs ?? 30_000,
    readinessTimeoutMs: opts.readinessTimeoutMs ?? 120_000,
    readinessPollMs: opts.readinessPollMs ?? 250,
    slotRestoreTimeoutMs: opts.slotRestoreTimeoutMs ?? 30_000,
    base: opts.fetch ?? globalThis.fetch,
  };

  async function wake(wakeOpts?: {
    signal?: AbortSignal;
    cacheIdentity?: string;
  }): Promise<LlamacppWakeDriveOutcome> {
    const external = wakeOpts?.signal;
    if (external?.aborted) {
      return { kind: "refused", reason: "WakeAborted" };
    }
    if (managed === undefined && (initiallyManaged || hasManagedRuntimeMarker(runtimeDir))) {
      return { kind: "inert", reason: "ManagedWakeProofRequired" };
    }
    if (
      managed !== undefined &&
      (managed.sleepRegistry !== registry || !validWakePin(managed.pin, ctx))
    ) {
      return { kind: "refused", reason: "ManagedWakeProofInvalid" };
    }
    const guard =
      managed === undefined || registry === null
        ? undefined
        : bindManagedWakeGuard(managed, registry);
    const attemptContext = guard === undefined ? ctx : { ...ctx, managed: guard };
    const cacheIdentity = wakeOpts?.cacheIdentity ?? ctx.cacheIdentity;
    let slotRestore: SlotRestoreResult | undefined;
    const start = async (slots: "restore" | "discard"): Promise<WakeStartOutcome> => {
      try {
        const attempt = await runWakeAttempt(attemptContext, external, slots);
        slotRestore = attempt.slotRestore;
        if (attempt.outcome !== "ready" || guard === undefined) return attempt.outcome;
        const deadline = AbortSignal.timeout(ctx.wakeTimeoutMs);
        const signal = external === undefined ? deadline : AbortSignal.any([external, deadline]);
        await verifyManagedRuntime(guard, signal);
        checkManagedReservation(guard, signal);
        return guard.publishReady() ? "ready" : "readiness-failed";
      } catch {
        return external?.aborted ? "cancelled" : "readiness-failed";
      } finally {
        guard?.retainIfUnsettled();
      }
    };
    const outcome = await wakeLlamacppMember({
      controller: ctx.controller,
      memberId: ctx.memberId,
      ...(cacheIdentity !== undefined ? { cacheIdentity } : {}),
      start,
    });
    if (guard !== undefined && outcome.kind === "already-awake") {
      return { kind: "refused", reason: "ManagedWakeUnverified" };
    }
    return reportWake(outcome, slotRestore);
  }

  return { wake };
}

async function runWakeAttempt(
  ctx: WakeDriverContext,
  external: AbortSignal | undefined,
  slots: "restore" | "discard",
): Promise<WakeAttemptResult> {
  try {
    const posted = await postWake(ctx, external);
    if (posted !== "ok") {
      return { outcome: posted, slotRestore: undefined };
    }
    const readiness = await probeReadiness(ctx, external);
    if (readiness !== "ready") {
      return { outcome: readiness, slotRestore: undefined };
    }
    if (slots !== "restore" || ctx.slot === undefined) {
      return { outcome: "ready", slotRestore: undefined };
    }
    const restored = await restoreSlot(ctx, external, ctx.slot);
    if (restored === "cancelled") {
      return { outcome: "cancelled", slotRestore: undefined };
    }
    // Every restore failure still settles ready: the model is loaded and
    // healthy, so the member goes ready/resident and only the cache is
    // cold; the driver neither retries nor erases.
    return { outcome: "ready", slotRestore: restored };
  } catch {
    return {
      outcome: external?.aborted ? "cancelled" : "readiness-failed",
      slotRestore: undefined,
    };
  }
}

function wakeRequest(ctx: WakeDriverContext, path: string, init: RequestInit): Promise<Response> {
  const request: RequestInit =
    ctx.managed === undefined ? init : { ...init, redirect: "error", cache: "no-store" };
  return ctx.base(`${ctx.baseUrl}${path}`, applyAuth(ctx.apiKey, request));
}

async function postWake(
  ctx: WakeDriverContext,
  external: AbortSignal | undefined,
): Promise<"ok" | "cancelled" | "readiness-failed"> {
  const timeout = AbortSignal.timeout(ctx.wakeTimeoutMs);
  const signal = external === undefined ? timeout : AbortSignal.any([external, timeout]);
  let response: Response;
  try {
    const managed = ctx.managed;
    if (managed !== undefined) {
      await verifyManagedRuntime(managed, signal);
      checkManagedReservation(managed, signal);
      if (!managed.beginDispatch()) return "readiness-failed";
      checkManagedReservation(managed, signal);
    }
    response = await wakeRequest(ctx, ctx.wakePath, { method: "POST", signal });
  } catch {
    return external?.aborted ? "cancelled" : "readiness-failed";
  }
  if (response.body !== null) {
    response.body.cancel().catch(() => undefined);
  }
  if (external?.aborted) {
    return "cancelled";
  }
  return response.ok && (ctx.managed === undefined || !signal.aborted) ? "ok" : "readiness-failed";
}

type ReadinessStep = "ready" | "retry" | "cancelled" | "readiness-failed";

async function probeReadiness(
  ctx: WakeDriverContext,
  external: AbortSignal | undefined,
): Promise<WakeStartOutcome> {
  const deadline = AbortSignal.timeout(ctx.readinessTimeoutMs);
  const signal = external === undefined ? deadline : AbortSignal.any([external, deadline]);
  for (;;) {
    if (external?.aborted) {
      return "cancelled";
    }
    if (deadline.aborted) {
      return "readiness-failed";
    }
    const step = await readinessStep(ctx, signal, external, deadline);
    if (step === "ready") {
      return "ready";
    }
    if (step !== "retry") {
      return step;
    }
    await abortableDelay(ctx.readinessPollMs, external, deadline);
  }
}

async function readinessStep(
  ctx: WakeDriverContext,
  signal: AbortSignal,
  external: AbortSignal | undefined,
  deadline: AbortSignal,
): Promise<ReadinessStep> {
  try {
    return (await probeOnce(ctx, signal)) ? "ready" : "retry";
  } catch (error) {
    if (external?.aborted) {
      return "cancelled";
    }
    return deadline.aborted || error instanceof ManagedWakeProofLostError
      ? "readiness-failed"
      : "retry";
  }
}

async function probeOnce(ctx: WakeDriverContext, signal: AbortSignal): Promise<boolean> {
  if (ctx.managed !== undefined) {
    await verifyManagedRuntime(ctx.managed, signal);
    checkManagedReservation(ctx.managed, signal);
  }
  const response = await wakeRequest(ctx, ctx.readinessPath, { method: "GET", signal });
  if (response.status !== 200) {
    if (response.body !== null) {
      response.body.cancel().catch(() => undefined);
    }
    return false;
  }
  const body: unknown = await response.json();
  return isAwakeProps(body) && (ctx.managed === undefined || ctx.managed.qualifiedReady(body));
}

function isAwakeProps(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  return (body as Record<string, unknown>)["is_sleeping"] === false;
}

function abortableDelay(
  ms: number,
  external: AbortSignal | undefined,
  deadline: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      external?.removeEventListener("abort", finish);
      deadline.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (external?.aborted || deadline.aborted) {
      finish();
      return;
    }
    external?.addEventListener("abort", finish, { once: true });
    deadline.addEventListener("abort", finish, { once: true });
  });
}

async function restoreSlot(
  ctx: WakeDriverContext,
  external: AbortSignal | undefined,
  slot: { id: number; filename: string },
): Promise<SlotRestoreResult | "cancelled"> {
  const timeout = AbortSignal.timeout(ctx.slotRestoreTimeoutMs);
  const signal = external === undefined ? timeout : AbortSignal.any([external, timeout]);
  if (ctx.managed !== undefined) {
    await verifyManagedRuntime(ctx.managed, signal);
    checkManagedReservation(ctx.managed, signal);
  }
  let response: Response;
  try {
    response = await wakeRequest(ctx, `/slots/${String(slot.id)}?action=restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: slot.filename }),
      signal,
    });
  } catch (err) {
    if (external?.aborted) {
      return "cancelled";
    }
    const kind = classifyFetchError(signal, err);
    return {
      ok: false,
      failure: {
        ok: false,
        reason: kind === "Timeout" ? "SlotRestoreTimedOut" : "SlotRestoreUnreachable",
      },
    };
  }
  if (external?.aborted) {
    return "cancelled";
  }
  if (!response.ok) {
    if (response.body !== null) {
      response.body.cancel().catch(() => undefined);
    }
    return {
      ok: false,
      failure: { ok: false, reason: "SlotRestoreFailed", httpStatus: response.status },
    };
  }
  return await readSlotRestoreBody(response, external, signal);
}

async function readSlotRestoreBody(
  response: Response,
  external: AbortSignal | undefined,
  signal: AbortSignal,
): Promise<SlotRestoreResult | "cancelled"> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (external?.aborted) {
      return "cancelled";
    }
    if (signal.aborted) {
      return { ok: false, failure: { ok: false, reason: "SlotRestoreTimedOut" } };
    }
    return { ok: false, failure: { ok: false, reason: "SlotRestoreInvalidResponse" } };
  }
  const nRestored = readFiniteNRestored(body);
  if (nRestored === null) {
    return { ok: false, failure: { ok: false, reason: "SlotRestoreInvalidResponse" } };
  }
  return { ok: true, tokensRestored: nRestored };
}

function readFiniteNRestored(body: unknown): number | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const value = (body as Record<string, unknown>)["n_restored"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ── Agent-side driver (residency-lease-registry gated) ───────────────────

export function createAgentLlamacppWakeDriver(opts: LlamacppWakeDriverOptions): LlamacppWakeDriver {
  if (getResidencyLeaseRegistry() === null) {
    return {
      wake(): Promise<LlamacppWakeDriveOutcome> {
        return Promise.resolve({ kind: "inert", reason: "ResidencyPolicyDisabled" });
      },
    };
  }
  return createLlamacppWakeDriver(opts);
}
