/**
 * DF-10 (#283) guarded llama.cpp sleep with verified process-stop fallback;
 * inert unless the residency lease registry is published.
 *
 * #520 — When a lease registry is installed, the driver consults the session
 * registry at sleep time: a bound session (idle within its timeout or in
 * flight) refuses the sleep as `SessionsActive` with the session ids in
 * `active`, and a registry whose `checkUnload` throws refuses it as
 * `SessionsUnknown`. The refusal applies to both the guarded sleep and the
 * process-stop fallback: no `POST /sleep` is sent, no stop runs, and the
 * reservation stays `held`. The factory captures the installed session
 * registry at construction, and `sessions: null` opts out. The driver never
 * releases sessions.
 */
import type {
  ManagedAdmissionClaim,
  ManagedAdmissionDecision,
  ManagedWorkloadKind,
} from "@llamactl/core/residency/admission";
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type { SessionRefcounts } from "@llamactl/core/residency/sessions";

import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  createLlamacppSleepController,
  type LlamacppSleepController,
  type SleepWakeAdmission,
} from "@llamactl/core/residency/llamacpp-sleep";
import { currentSessionRefcounts } from "@llamactl/core/residency/sessions";

import type {
  TargetAdmissionAuthority,
  TargetAdmissionClaimHandle,
} from "../workload/admission.js";

import {
  applyAuth,
  buildBaseUrl,
  classifyFetchError,
  sessionUnloadRefusal,
} from "./engine-client.js";

// ── Public types ──────────────────────────────────────────────────────────

export type LlamacppVerifiedStopResult =
  | { ok: true }
  | { ok: false; reason: string; message?: string };

export type LlamacppSleepTrigger =
  | "SleepRefused"
  | "SleepUnsupported"
  | "SleepTimedOut"
  | "SleepUnreachable"
  | "ProcessFallback";

export type LlamacppSleepOutcome =
  | { kind: "slept"; reservation: "released" }
  | {
      kind: "stopped";
      trigger: LlamacppSleepTrigger;
      httpStatus?: number;
      reservation: "released";
    }
  | {
      kind: "stop-failed";
      trigger: LlamacppSleepTrigger;
      httpStatus?: number;
      stopReason: string;
      reservation: "uncertain";
    }
  | { kind: "refused"; reason: string; reservation: "held"; active?: string[] }
  | { kind: "inert"; reason: "ResidencyPolicyDisabled" };

export type LlamacppSleepDriver = { sleep(): Promise<LlamacppSleepOutcome> };

export type LlamacppSleepDriverOptions = {
  controller: LlamacppSleepController;
  memberId: string;
  endpoint: { host: string; port: number };
  sleepPath?: string;
  apiKey?: string;
  cacheIdentity?: string;
  sleepTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /**
   * undefined: resolve the installed session registry at sleep time;
   * null: opt out (#520).
   */
  sessions?: Pick<SessionRefcounts, "checkUnload"> | null;
  verifiedStop: () => Promise<LlamacppVerifiedStopResult>;
};

// ── Driver implementation ────────────────────────────────────────────────

function createLlamacppSleepDriver(opts: LlamacppSleepDriverOptions): LlamacppSleepDriver {
  const {
    controller,
    memberId,
    endpoint,
    sleepPath: rawSleepPath,
    apiKey,
    cacheIdentity,
    sleepTimeoutMs = 30_000,
    fetch: baseFetch,
    sessions,
    verifiedStop,
  } = opts;
  const baseUrl = buildBaseUrl(endpoint.host, endpoint.port);
  const sleepPath = rawSleepPath ?? "/sleep";
  const base = baseFetch ?? globalThis.fetch;

  async function sleep(): Promise<LlamacppSleepOutcome> {
    // #520: session check runs before controller.requestSleep — no IO, no
    // controller mutation, no process stop.
    const sessionRefusal = sessionUnloadRefusal(sessions, memberId);
    if (sessionRefusal !== null) {
      return {
        kind: "refused",
        reason: sessionRefusal.reason,
        reservation: "held",
        active: sessionRefusal.active,
      };
    }

    const v = controller.requestSleep(memberId);

    // Step 1: controller refusal — no IO
    if (v.kind === "refuse") {
      return { kind: "refused", reason: v.reason, reservation: "held" };
    }

    // Step 2: process-fallback — skip HTTP, go straight to verified stop.
    // The controller answers process-stop whatever the member's state, but
    // a member mid-transition cannot accept the 'stopped' observation that
    // proves the release, so killing it would report a release the
    // controller never records. Hold it, as the guarded path does.
    if (v.kind === "process-stop") {
      const inFlight = transitionInFlight(controller, memberId);
      if (inFlight !== null) {
        return { kind: "refused", reason: inFlight, reservation: "held" };
      }
      return await runVerifiedStop(
        "ProcessFallback",
        undefined,
        verifiedStop,
        controller,
        memberId,
      );
    }

    // Step 3: guarded sleep — POST to the endpoint
    const signal = AbortSignal.timeout(sleepTimeoutMs);
    let httpStatus: number | undefined;

    try {
      const response = await base(
        `${baseUrl}${sleepPath}`,
        applyAuth(apiKey, { method: "POST", signal }),
      );
      httpStatus = response.status;

      // Cancel the unread body to release the connection; a rejected cancel
      // has nothing left to clean up, so it is swallowed.
      if (response.body) {
        response.body.cancel().catch(() => undefined);
      }

      // Step 4: classify the response
      if (response.ok) {
        controller.sleepSettled(memberId, "slept", cacheIdentity);
        return { kind: "slept", reservation: "released" };
      }

      // Non-2xx: sleep failed, mark as failed first so member is unknown/uncertain
      controller.sleepSettled(memberId, "failed");

      const trigger: LlamacppSleepTrigger =
        httpStatus === 404 || httpStatus === 405 || httpStatus === 501
          ? "SleepUnsupported"
          : "SleepRefused";

      return await runVerifiedStop(trigger, httpStatus, verifiedStop, controller, memberId);
    } catch (err) {
      // Step 4 (cont): fetch error — mark as failed first
      controller.sleepSettled(memberId, "failed");
      const fetchError = classifyFetchError(signal, err);
      const trigger: LlamacppSleepTrigger =
        fetchError === "Timeout" ? "SleepTimedOut" : "SleepUnreachable";
      return await runVerifiedStop(trigger, undefined, verifiedStop, controller, memberId);
    }
  }

  return { sleep };
}

// A waking member blocks every observation except 'ready'/'loading'
// (WakeInFlight), and a sleep-pending one blocks all of them (SleepInFlight).
function transitionInFlight(
  controller: LlamacppSleepController,
  memberId: string,
): "WakeInFlight" | "SleepInFlight" | null {
  const state = controller.snapshot().members[memberId]?.state;
  if (state === "waking") return "WakeInFlight";
  if (state === "sleep-pending") return "SleepInFlight";
  return null;
}

// ── Verified stop fallback (step 5) ──────────────────────────────────────

async function runVerifiedStop(
  trigger: LlamacppSleepTrigger,
  httpStatus: number | undefined,
  verifiedStop: () => Promise<LlamacppVerifiedStopResult>,
  controller: LlamacppSleepController,
  memberId: string,
): Promise<LlamacppSleepOutcome> {
  let r: LlamacppVerifiedStopResult;
  try {
    r = await verifiedStop();
  } catch (thrown) {
    const message =
      typeof thrown === "object" &&
      thrown !== null &&
      "reason" in thrown &&
      typeof (thrown as Record<string, unknown>)["reason"] === "string"
        ? ((thrown as Record<string, unknown>)["reason"] as string)
        : "StopFailed";
    // A throwing stop is as unproven as an ok:false one: leave the member in
    // the same unknown/uncertain controller state either way.
    controller.observe(memberId, "unknown");
    return {
      kind: "stop-failed",
      trigger,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      stopReason: message,
      reservation: "uncertain",
    };
  }

  if (r.ok) {
    controller.observe(memberId, "stopped");
    return {
      kind: "stopped",
      trigger,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      reservation: "released",
    };
  }

  const stopReason = r.reason;
  controller.observe(memberId, "unknown");
  return {
    kind: "stop-failed",
    trigger,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    stopReason,
    reservation: "uncertain",
  };
}

// ── Agent-side driver (residency-lease-registry gated) ───────────────────

export type AgentLlamacppSleepDriverOptions = Omit<LlamacppSleepDriverOptions, "controller"> & {
  controller: LlamacppSleepController;
};

export function createAgentLlamacppSleepDriver(
  opts: AgentLlamacppSleepDriverOptions,
): LlamacppSleepDriver {
  const registry: ResidencyLeases | null = getResidencyLeaseRegistry();
  if (registry === null) {
    return {
      sleep(): Promise<LlamacppSleepOutcome> {
        return Promise.resolve({ kind: "inert", reason: "ResidencyPolicyDisabled" });
      },
    };
  }
  const sessions = opts.sessions !== undefined ? opts.sessions : currentSessionRefcounts();
  return createLlamacppSleepDriver({ ...opts, sessions });
}

// ── Shared-budget binding + wake driver (DF-10 #283) ─────────────────────

export type SharedBudgetSleepControllerOptions = {
  authority: TargetAdmissionAuthority;
  targetIdentity: string;
  budgetGiB: () => number | undefined;
  living?: () => readonly ManagedAdmissionClaim[];
  kind?: ManagedWorkloadKind;
};

export type LlamacppWakeOutcome =
  | { kind: "woke"; slots: "restore" | "discard" }
  | { kind: "wake-failed"; outcome: "cancelled" | "readiness-failed" }
  | { kind: "joined" }
  | { kind: "already-awake" }
  | { kind: "process-switch"; reason: string }
  | { kind: "refused"; reason: string };

type SleepWakeAdmissionInput = Parameters<SleepWakeAdmission>[0];
type SleepWakeRequest = ReturnType<LlamacppSleepController["requestWake"]>;
type SleepMemberSnapshot = NonNullable<
  ReturnType<LlamacppSleepController["snapshot"]>["members"][string]
>;
type SleepReservation = SleepMemberSnapshot["reservation"];
type LlamacppWakeStart = (
  slots: "restore" | "discard",
) => Promise<"ready" | "cancelled" | "readiness-failed">;

function sleepGroupKey(runtimeKey: string, specDigest: string): string {
  return JSON.stringify([runtimeKey, specDigest]);
}

// Local (inner-controller) claims ride along as `living`, tagged with the
// same kind — an untagged claim reads as a kind mismatch and core refuses
// WorkloadBusy.
function sharedLivingClaims(
  living: (() => readonly ManagedAdmissionClaim[]) | undefined,
  claims: readonly ManagedAdmissionClaim[],
  kind: ManagedWorkloadKind,
): ManagedAdmissionClaim[] {
  return [...(living?.() ?? []), ...claims.map((claim) => ({ ...claim, kind }))];
}

// already-resident/join-pending with no matching local claim means another
// workload owns that runtime in the shared ledger — the ClaimHeldElsewhere
// mirror from omlx-managed.
function heldOutsideController(
  decision: ManagedAdmissionDecision,
  admission: SleepWakeAdmissionInput,
): string | null {
  if (decision.kind !== "already-resident" && decision.kind !== "join-pending") return null;
  const heldLocally = admission.claims.some(
    (claim) =>
      claim.runtimeKey === admission.incoming.runtimeKey &&
      claim.specDigest === admission.incoming.specDigest,
  );
  return heldLocally ? null : decision.claimId;
}

function settleAdmissionOutcome(
  handles: Map<string, TargetAdmissionClaimHandle>,
  groupKey: string,
  admission: SleepWakeAdmissionInput,
  outcome: { decision: ManagedAdmissionDecision; handle: TargetAdmissionClaimHandle | null },
): ManagedAdmissionDecision {
  if (outcome.handle !== null) {
    handles.set(groupKey, outcome.handle);
    return outcome.decision;
  }
  const foreignClaimId = heldOutsideController(outcome.decision, admission);
  if (foreignClaimId !== null) {
    return {
      kind: "refuse",
      reason: "WorkloadBusy",
      detail: `runtimeKey ${admission.incoming.runtimeKey} is held by claim ${foreignClaimId} outside this sleep controller`,
    };
  }
  return outcome.decision;
}

function createSharedAdmission(input: {
  authority: TargetAdmissionAuthority;
  targetIdentity: string;
  budgetGiB: () => number | undefined;
  living: (() => readonly ManagedAdmissionClaim[]) | undefined;
  kind: ManagedWorkloadKind;
  handles: Map<string, TargetAdmissionClaimHandle>;
}): SleepWakeAdmission {
  return (admission): ManagedAdmissionDecision => {
    const groupKey = sleepGroupKey(admission.incoming.runtimeKey, admission.incoming.specDigest);
    const claimed = input.authority.tryClaim({
      targetIdentity: input.targetIdentity,
      runtimeKey: admission.incoming.runtimeKey,
      specDigest: admission.incoming.specDigest,
      kind: input.kind,
      allocationGiB: admission.incoming.allocationGiB,
      budgetGiB: input.budgetGiB(),
      living: sharedLivingClaims(input.living, admission.claims, input.kind),
    });
    return settleAdmissionOutcome(input.handles, groupKey, admission, claimed);
  };
}

// Folds one runtime group's member reservations into its shared claim.
// Returns true when every member released, so the caller drops the handle.
function foldGroupClaim(
  handle: TargetAdmissionClaimHandle,
  reservations: readonly SleepReservation[],
): boolean {
  if (reservations.every((reservation) => reservation === "released")) {
    if (handle.state() === "pending") {
      handle.releaseUnstarted();
    } else {
      handle.releaseVerified();
    }
    return true;
  }
  if (reservations.some((reservation) => reservation === "pending")) return false;
  if (reservations.some((reservation) => reservation === "resident")) {
    handle.markResident();
    return false;
  }
  handle.markUncertain();
  handle.demoteUncertain();
  return false;
}

// Wraps a LlamacppSleepController so wakes admit through the shared
// TargetAdmissionAuthority: every requestWake charges the node budget in the
// shared ledger, billed once per runtime group (core merges same-runtime
// members into one claim and the ledger dedupes by runtimeKey). Member
// lifecycle transitions re-fold the group's reservations into the claim —
// a confirmed sleep of the last awake member, including the driver's
// verified-stop path ending in observe('stopped'), releases it. Members
// registered already awake are not adopted into the ledger yet; that is
// deferred to the wiring slice (Part of #283).
export function createSharedBudgetSleepController(
  opts: SharedBudgetSleepControllerOptions,
): LlamacppSleepController {
  const kind = opts.kind ?? "ModelRun";
  const groupOf = new Map<string, string>();
  const handles = new Map<string, TargetAdmissionClaimHandle>();

  const inner = createLlamacppSleepController({
    admitWake: createSharedAdmission({
      authority: opts.authority,
      targetIdentity: opts.targetIdentity,
      budgetGiB: opts.budgetGiB,
      living: opts.living,
      kind,
      handles,
    }),
  });

  const groupReservations = (groupKey: string): SleepReservation[] => {
    const members = inner.snapshot().members;
    const reservations: SleepReservation[] = [];
    for (const [memberId, memberGroup] of groupOf) {
      if (memberGroup !== groupKey) continue;
      const reservation = members[memberId]?.reservation;
      if (reservation !== undefined) reservations.push(reservation);
    }
    return reservations;
  };

  const syncGroup = (groupKey: string | undefined): void => {
    if (groupKey === undefined) return;
    const handle = handles.get(groupKey);
    if (handle === undefined) return;
    if (foldGroupClaim(handle, groupReservations(groupKey))) handles.delete(groupKey);
  };

  return {
    register(member, state): void {
      if (!groupOf.has(member.id)) {
        groupOf.set(member.id, sleepGroupKey(member.runtimeKey, member.specDigest));
      }
      inner.register(member, state);
    },
    requestWake(id, wakeOpts): ReturnType<LlamacppSleepController["requestWake"]> {
      const result = inner.requestWake(id, wakeOpts);
      syncGroup(groupOf.get(id));
      return result;
    },
    wakeSettled(id, outcome): void {
      inner.wakeSettled(id, outcome);
      syncGroup(groupOf.get(id));
    },
    requestSleep(id): ReturnType<LlamacppSleepController["requestSleep"]> {
      return inner.requestSleep(id);
    },
    sleepSettled(id, outcome, cacheIdentity): void {
      inner.sleepSettled(id, outcome, cacheIdentity);
      syncGroup(groupOf.get(id));
    },
    observe(id, state): void {
      inner.observe(id, state);
      syncGroup(groupOf.get(id));
    },
    snapshot(): ReturnType<LlamacppSleepController["snapshot"]> {
      return inner.snapshot();
    },
  };
}

function nonWakeOutcome(
  decision: Exclude<SleepWakeRequest, { kind: "wake" }>,
): LlamacppWakeOutcome {
  switch (decision.kind) {
    case "refuse":
      return { kind: "refused", reason: decision.reason };
    case "join-wake":
      return { kind: "joined" };
    case "already-awake":
      return { kind: "already-awake" };
    case "process-switch":
      return { kind: "process-switch", reason: decision.reason };
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unhandled wake decision: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function runWakeStart(
  controller: LlamacppSleepController,
  memberId: string,
  start: LlamacppWakeStart,
  slots: "restore" | "discard",
): Promise<LlamacppWakeOutcome> {
  let outcome: "ready" | "cancelled" | "readiness-failed";
  try {
    outcome = await start(slots);
  } catch {
    // A start that may have reached the engine stays charged as uncertain.
    controller.wakeSettled(memberId, "readiness-failed");
    return { kind: "wake-failed", outcome: "readiness-failed" };
  }
  controller.wakeSettled(memberId, outcome);
  if (outcome === "ready") {
    return { kind: "woke", slots };
  }
  return { kind: "wake-failed", outcome };
}

export async function wakeLlamacppMember(opts: {
  controller: LlamacppSleepController;
  memberId: string;
  cacheIdentity?: string;
  start: LlamacppWakeStart;
}): Promise<LlamacppWakeOutcome> {
  const decision = opts.controller.requestWake(
    opts.memberId,
    opts.cacheIdentity !== undefined ? { cacheIdentity: opts.cacheIdentity } : undefined,
  );
  if (decision.kind === "wake") {
    return await runWakeStart(opts.controller, opts.memberId, opts.start, decision.slots);
  }
  return nonWakeOutcome(decision);
}
