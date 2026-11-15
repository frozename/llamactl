/**
 * DF-10 (#283) agent-side llama.cpp wake driver; not wired into the
 * reconciler or agent start (Part of #283).
 */
import type { LlamacppSleepController } from "@llamactl/core/residency/llamacpp-sleep";

import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";

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
  | { kind: "inert"; reason: "ResidencyPolicyDisabled" };

export type LlamacppWakeDriverOptions = {
  controller: LlamacppSleepController;
  memberId: string;
  endpoint: { host: string; port: number };
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
};

export function createLlamacppWakeDriver(opts: LlamacppWakeDriverOptions): LlamacppWakeDriver {
  const ctx: WakeDriverContext = {
    controller: opts.controller,
    memberId: opts.memberId,
    baseUrl: buildBaseUrl(opts.endpoint.host, opts.endpoint.port),
    wakePath: opts.wakePath ?? "/wake",
    readinessPath: opts.readinessPath ?? "/props",
    apiKey: opts.apiKey,
    cacheIdentity: opts.cacheIdentity,
    slot: opts.slot,
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
    const cacheIdentity = wakeOpts?.cacheIdentity ?? ctx.cacheIdentity;
    let slotRestore: SlotRestoreResult | undefined;
    const start = async (slots: "restore" | "discard"): Promise<WakeStartOutcome> => {
      const attempt = await runWakeAttempt(ctx, external, slots);
      slotRestore = attempt.slotRestore;
      return attempt.outcome;
    };
    const outcome = await wakeLlamacppMember({
      controller: ctx.controller,
      memberId: ctx.memberId,
      ...(cacheIdentity !== undefined ? { cacheIdentity } : {}),
      start,
    });
    if (outcome.kind !== "woke") {
      return outcome;
    }
    if (slotRestore === undefined) {
      return { kind: "woke", slots: "discard" };
    }
    if (slotRestore.ok) {
      return { kind: "woke", slots: "restore", tokensRestored: slotRestore.tokensRestored };
    }
    return { kind: "woke", slots: "discard", slotRestore: slotRestore.failure };
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
    return { outcome: "readiness-failed", slotRestore: undefined };
  }
}

async function postWake(
  ctx: WakeDriverContext,
  external: AbortSignal | undefined,
): Promise<"ok" | "cancelled" | "readiness-failed"> {
  const timeout = AbortSignal.timeout(ctx.wakeTimeoutMs);
  const signal = external === undefined ? timeout : AbortSignal.any([external, timeout]);
  let response: Response;
  try {
    response = await ctx.base(
      `${ctx.baseUrl}${ctx.wakePath}`,
      applyAuth(ctx.apiKey, { method: "POST", signal }),
    );
  } catch {
    return external?.aborted ? "cancelled" : "readiness-failed";
  }
  if (response.body !== null) {
    response.body.cancel().catch(() => undefined);
  }
  if (external?.aborted) {
    return "cancelled";
  }
  return response.ok ? "ok" : "readiness-failed";
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
  } catch {
    if (external?.aborted) {
      return "cancelled";
    }
    return deadline.aborted ? "readiness-failed" : "retry";
  }
}

async function probeOnce(ctx: WakeDriverContext, signal: AbortSignal): Promise<boolean> {
  const response = await ctx.base(
    `${ctx.baseUrl}${ctx.readinessPath}`,
    applyAuth(ctx.apiKey, { method: "GET", signal }),
  );
  if (response.status !== 200) {
    if (response.body !== null) {
      response.body.cancel().catch(() => undefined);
    }
    return false;
  }
  return isAwakeProps(await response.json());
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
  let response: Response;
  try {
    response = await ctx.base(
      `${ctx.baseUrl}/slots/${String(slot.id)}?action=restore`,
      applyAuth(ctx.apiKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: slot.filename }),
        signal,
      }),
    );
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
