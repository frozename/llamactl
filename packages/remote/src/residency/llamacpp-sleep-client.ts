/**
 * DF-10 (#283) guarded llama.cpp sleep with verified process-stop fallback;
 * inert unless the residency lease registry is published. An unresolved
 * sleep or stop keeps the exact workload drain closed and its capacity charged.
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
  ManagedClaimState,
  ManagedWorkloadKind,
} from "@llamactl/core/residency/admission";
import type { DrainToken, ResidencyLeases } from "@llamactl/core/residency/leases";
import type { SessionRefcounts } from "@llamactl/core/residency/sessions";

import { resolveEnv } from "@llamactl/core/env";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  createLlamacppSleepController,
  type LlamacppSleepController,
  type SleepMember,
  type SleepWakeAdmission,
} from "@llamactl/core/residency/llamacpp-sleep";
import { hasManagedRuntimeMarker } from "@llamactl/core/residency/managed-runtime";
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
  | "SleepUnconfirmed"
  | "SleepTimedOut"
  | "SleepUnreachable"
  | "ProcessFallback";

type InferenceHoldRefusal = "PriorInferenceHold" | "InferenceHoldActive" | "InferenceHoldUnknown";
type SleepFenceRefusal = InferenceHoldRefusal | "DrainChanged" | "NativeSleepGenerationChanged";

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
  | {
      kind: "unconfirmed";
      reason: SleepFenceRefusal | "NativeReleaseUnverified";
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
  /** The owner verifies the exact process while reusing this operation's drain. */
  verifiedStop: (drain: DrainToken) => Promise<LlamacppVerifiedStopResult>;
};

// ── Driver implementation ────────────────────────────────────────────────

async function confirmsSleep(
  base: typeof globalThis.fetch,
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await base(
      `${baseUrl}/props`,
      applyAuth(apiKey, { method: "GET", signal, redirect: "error", cache: "no-store" }),
    );
    if (response.status !== 200) {
      response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body: unknown = await response.json();
    return (
      !signal.aborted &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>)["is_sleeping"] === true
    );
  } catch {
    return false;
  }
}

function createLlamacppSleepDriver(
  opts: AgentLlamacppSleepDriverOptions,
  registry: ResidencyLeases,
): LlamacppSleepDriver {
  const {
    controller,
    memberId,
    endpoint: configuredEndpoint,
    sleepPath: rawSleepPath,
    apiKey,
    cacheIdentity,
    sleepTimeoutMs = 30_000,
    fetch: baseFetch,
    sessions,
    verifiedStop,
    managed,
  } = opts;
  const endpoint = Object.freeze({ ...configuredEndpoint });
  const baseUrl = buildBaseUrl(endpoint.host, endpoint.port);
  const sleepPath = rawSleepPath ?? "/sleep";
  const base = baseFetch ?? globalThis.fetch;
  const workload = managed?.workload ?? memberId;
  const holdRefusal = (): InferenceHoldRefusal | undefined =>
    inferenceHoldRefusal(managed?.readInferenceHold, workload);
  const confirmRelease = (drain: DrainToken): SleepFenceRefusal | undefined =>
    holdRefusal() ?? (registry.commitUnload(drain).ok ? undefined : "DrainChanged");
  const receipt = (sleepDrain: DrainToken): NativeSleepReceipt => ({
    sleepRegistry: registry,
    sleepDrain,
    memberId,
    endpoint,
  });

  async function sleepWithDrain(token: DrainToken): Promise<LlamacppSleepOutcome> {
    const sessionRefusal = sessionUnloadRefusal(sessions, workload);
    if (sessionRefusal !== null) {
      return {
        kind: "refused",
        reason: sessionRefusal.reason,
        reservation: "held",
        active: sessionRefusal.active,
      };
    }

    if (!verifyManagedDispatch(managed, receipt(token)))
      return { kind: "refused", reason: "NativeSleepGenerationChanged", reservation: "held" };
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
      return await stopUnderDrain("ProcessFallback", undefined, token);
    }

    // Step 3: guarded sleep — POST to the endpoint
    const signal = AbortSignal.timeout(sleepTimeoutMs);
    let httpStatus: number | undefined;

    try {
      const response = await base(
        `${baseUrl}${sleepPath}`,
        applyAuth(apiKey, { method: "POST", signal, redirect: "error" }),
      );
      httpStatus = response.status;

      // Cancel the unread body to release the connection; a rejected cancel
      // has nothing left to clean up, so it is swallowed.
      if (response.body) {
        response.body.cancel().catch(() => undefined);
      }

      // A successful command acknowledgement is not proof that the model
      // released memory. /props observes the state without triggering wake.
      if (response.ok && (await confirmsSleep(base, baseUrl, apiKey, signal))) {
        return settleNativeSleep({
          reason: confirmRelease(token),
          receipt: receipt(token),
          park: managed?.parkAfterSleep,
          controller,
          cacheIdentity,
        });
      }

      controller.sleepSettled(memberId, "failed");
      return await stopUnderDrain(sleepResponseTrigger(response), httpStatus, token);
    } catch (err) {
      // Step 4 (cont): fetch error — mark as failed first
      controller.sleepSettled(memberId, "failed");
      const fetchError = classifyFetchError(signal, err);
      const trigger: LlamacppSleepTrigger =
        fetchError === "Timeout" ? "SleepTimedOut" : "SleepUnreachable";
      return await stopUnderDrain(trigger, undefined, token);
    }
  }

  function stopUnderDrain(
    trigger: LlamacppSleepTrigger,
    httpStatus: number | undefined,
    token: DrainToken,
  ): Promise<LlamacppSleepOutcome> {
    const reason = fallbackFenceRefusal(managed, receipt(token), holdRefusal);
    if (reason !== undefined) {
      return Promise.resolve(
        trigger === "ProcessFallback"
          ? { kind: "refused", reason, reservation: "held" }
          : { kind: "unconfirmed", reason, reservation: "uncertain" },
      );
    }
    return runVerifiedStop(
      trigger,
      httpStatus,
      () => verifiedStop(token),
      controller,
      memberId,
      () => confirmRelease(token),
    );
  }

  return {
    sleep(): Promise<LlamacppSleepOutcome> {
      const reason = managedSleepRefusal(managed, endpoint, sleepPath);
      return reason === undefined
        ? withSleepDrain(registry, workload, holdRefusal, sleepWithDrain)
        : Promise.resolve({ kind: "refused", reason, reservation: "held" });
    },
  };
}

function fallbackFenceRefusal(
  managed: ManagedSleepProof | undefined,
  receipt: NativeSleepReceipt,
  holdRefusal: () => InferenceHoldRefusal | undefined,
): SleepFenceRefusal | undefined {
  const { sleepDrain, sleepRegistry } = receipt;
  const snapshot = sleepRegistry.snapshot(sleepDrain.workload);
  if (snapshot.phase !== "draining" || snapshot.epoch !== sleepDrain.epoch) return "DrainChanged";
  return (
    holdRefusal() ??
    (verifyManagedDispatch(managed, receipt) ? undefined : "NativeSleepGenerationChanged")
  );
}

function settleNativeSleep(opts: {
  reason: SleepFenceRefusal | undefined;
  receipt: NativeSleepReceipt;
  park: ManagedSleepProof["parkAfterSleep"];
  controller: LlamacppSleepController;
  cacheIdentity: string | undefined;
}): LlamacppSleepOutcome {
  const { controller, receipt, park, cacheIdentity } = opts;
  const { memberId } = receipt;
  const reason =
    opts.reason ?? (sealManagedPark(park, receipt) ? undefined : "NativeReleaseUnverified");
  if (reason !== undefined) {
    controller.sleepSettled(memberId, "failed");
    return { kind: "unconfirmed", reason, reservation: "uncertain" };
  }
  controller.sleepSettled(memberId, "slept", cacheIdentity);
  return { kind: "slept", reservation: "released" };
}

async function withSleepDrain(
  registry: ResidencyLeases,
  workload: string,
  holdRefusal: () => InferenceHoldRefusal | undefined,
  sleep: (token: DrainToken) => Promise<LlamacppSleepOutcome>,
): Promise<LlamacppSleepOutcome> {
  if (workload.trim().length === 0) {
    return { kind: "refused", reason: "WorkloadUnknown", reservation: "held" };
  }
  const drain = registry.beginDrain(workload);
  if (!drain.ok) {
    const reason = drain.reason === "AlreadyDraining" ? "DrainInProgress" : drain.reason;
    return { kind: "refused", reason, reservation: "held" };
  }
  const { token, active } = drain;
  if (active.length > 0) {
    registry.cancelDrain(token);
    return { kind: "refused", reason: "LeasesActive", reservation: "held", active };
  }
  const held = holdRefusal();
  const result: LlamacppSleepOutcome =
    held === undefined
      ? await sleep(token)
      : { kind: "refused", reason: held, reservation: "held" };
  // Failed dispatch and failed stop can leave a live engine in transition.
  if (result.kind === "refused") registry.cancelDrain(token);
  return result;
}

function sleepResponseTrigger(response: Response): LlamacppSleepTrigger {
  if (response.ok) return "SleepUnconfirmed";
  const { status } = response;
  return status === 404 || status === 405 || status === 501 ? "SleepUnsupported" : "SleepRefused";
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
  confirmRelease: () => SleepFenceRefusal | undefined,
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

  const stopReason = r.ok ? confirmRelease() : r.reason;
  if (stopReason === undefined) {
    controller.observe(memberId, "stopped");
    return {
      kind: "stopped",
      trigger,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      reservation: "released",
    };
  }

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

export type NativeSleepReceipt = Readonly<{
  sleepRegistry: ResidencyLeases;
  sleepDrain: Readonly<DrainToken>;
  memberId: string;
  endpoint: Readonly<{ host: string; port: number }>;
}>;

type ManagedSleepProof = {
  workload: string;
  readInferenceHold: (workload: string) => "clear" | "current" | "prior" | "unknown";
  /** Recheck the owned process and endpoint before a native command or stop. */
  beforeDispatch?: (receipt: NativeSleepReceipt) => boolean;
  /** Return true only once the exact lease epoch and measured residual are durably parked. */
  parkAfterSleep?: (receipt: NativeSleepReceipt) => boolean;
};

function managedSleepRefusal(
  proof: ManagedSleepProof | undefined,
  endpoint: LlamacppSleepDriverOptions["endpoint"],
  path: string,
): "ManagedSleepReleaseProofRequired" | "ManagedSleepBindingInvalid" | undefined {
  if (proof?.parkAfterSleep === undefined) {
    return hasManagedRuntimeMarker(resolveEnv().LOCAL_AI_RUNTIME_DIR)
      ? "ManagedSleepReleaseProofRequired"
      : undefined;
  }
  if (proof.beforeDispatch === undefined) return "ManagedSleepReleaseProofRequired";
  if (
    (endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") ||
    !Number.isSafeInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535 ||
    path !== "/sleep"
  ) {
    return "ManagedSleepBindingInvalid";
  }
  return undefined;
}

function verifyManagedDispatch(
  proof: ManagedSleepProof | undefined,
  receipt: NativeSleepReceipt,
): boolean {
  const verify = proof?.beforeDispatch;
  try {
    return verify === undefined || verify(receipt);
  } catch {
    return false;
  }
}

function sealManagedPark(
  park: ManagedSleepProof["parkAfterSleep"],
  receipt: NativeSleepReceipt,
): boolean {
  try {
    return park === undefined || park(receipt);
  } catch {
    return false;
  }
}

function inferenceHoldRefusal(
  read: ManagedSleepProof["readInferenceHold"] | undefined,
  workload: string,
): InferenceHoldRefusal | undefined {
  if (read === undefined) return undefined;
  try {
    switch (read(workload)) {
      case "prior":
        return "PriorInferenceHold";
      case "current":
        return "InferenceHoldActive";
      case "clear":
        return undefined;
      case "unknown":
        return "InferenceHoldUnknown";
    }
  } catch {
    return "InferenceHoldUnknown";
  }
}

export type AgentLlamacppSleepDriverOptions = LlamacppSleepDriverOptions & {
  managed?: ManagedSleepProof;
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
  return createLlamacppSleepDriver({ ...opts, sessions }, registry);
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

type GroupMemberEntry = { member: SleepMember; reservation: SleepReservation };

// Mirrors core computeCommittedGiB for one runtime group: the largest
// allocation among members whose reservation is not released (0 when none).
function largestHeldAllocationGiB(entries: readonly GroupMemberEntry[]): number {
  let allocationGiB = 0;
  for (const entry of entries) {
    if (entry.reservation === "released") continue;
    if (entry.member.allocationGiB > allocationGiB) allocationGiB = entry.member.allocationGiB;
  }
  return allocationGiB;
}

// Folds one runtime group's member reservations into its shared claim,
// billing it at its largest held allocation on every sync so a larger
// member observed awake raises the bill (and its release lowers it) exactly
// as core committedGiB does. The bill is restated before the state fold, so
// the ledger never reads a ready member at a smaller allocation. Returns
// true when every member released, so the caller drops the handle.
function foldGroupClaim(
  handle: TargetAdmissionClaimHandle,
  entries: readonly GroupMemberEntry[],
): boolean {
  const reservations = entries.map((entry) => entry.reservation);
  if (reservations.every((reservation) => reservation === "released")) {
    if (handle.state() === "pending") {
      handle.releaseUnstarted();
    } else {
      handle.releaseVerified();
    }
    return true;
  }
  handle.restateAllocation(largestHeldAllocationGiB(entries));
  if (reservations.some((reservation) => reservation === "pending")) return false;
  if (reservations.some((reservation) => reservation === "resident")) {
    handle.markResident();
    return false;
  }
  handle.markUncertain();
  handle.demoteUncertain();
  return false;
}

// A group's reservations fold into one claimed state the way core folds them
// into one runtime-group claim: pending wins, then resident, else uncertain.
function adoptedClaimState(entries: readonly GroupMemberEntry[]): ManagedClaimState {
  if (entries.some((entry) => entry.reservation === "pending")) return "pending";
  if (entries.some((entry) => entry.reservation === "resident")) return "resident";
  return "uncertain";
}

// Records a runtime group's observed residency in the shared ledger without
// admitting it: no budget check, and it bills the group once at its largest
// held allocation. A null handle means the runtime is charged elsewhere, so
// nothing is stored — a later sleep of this group must not release a foreign
// claim, and the next sync tries again.
function adoptGroupClaim(input: {
  groupKey: string;
  entries: readonly GroupMemberEntry[];
  authority: TargetAdmissionAuthority;
  targetIdentity: string;
  kind: ManagedWorkloadKind;
  handles: Map<string, TargetAdmissionClaimHandle>;
}): void {
  const held = input.entries.filter((entry) => entry.reservation !== "released");
  const [first] = held;
  if (first === undefined) return;
  const allocationGiB = largestHeldAllocationGiB(held);
  const adopted = input.authority.adopt({
    targetIdentity: input.targetIdentity,
    runtimeKey: first.member.runtimeKey,
    specDigest: first.member.specDigest,
    kind: input.kind,
    allocationGiB,
    state: adoptedClaimState(held),
  });
  if (adopted.handle !== null) input.handles.set(input.groupKey, adopted.handle);
}

// Wraps a LlamacppSleepController so wakes admit through the shared
// TargetAdmissionAuthority: every requestWake charges the node budget in the
// shared ledger, billed once per runtime group (core merges same-runtime
// members into one claim and the ledger dedupes by runtimeKey). Member
// lifecycle transitions re-fold the group's reservations into the claim —
// a confirmed sleep of the last awake member, including the driver's
// verified-stop path ending in observe('stopped'), releases it. Members
// observed awake, loading or of unknown residency are adopted into the
// ledger at registration and on every later transition, which covers an
// auto-wake outside a requested wake; adopt defers to a claim already held
// elsewhere on the same runtime.
export function createSharedBudgetSleepController(
  opts: SharedBudgetSleepControllerOptions,
): LlamacppSleepController {
  const kind = opts.kind ?? "ModelRun";
  const groupOf = new Map<string, string>();
  const membersById = new Map<string, SleepMember>();
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

  const groupEntries = (groupKey: string): GroupMemberEntry[] => {
    const members = inner.snapshot().members;
    const entries: GroupMemberEntry[] = [];
    for (const [memberId, member] of membersById) {
      if (groupOf.get(memberId) !== groupKey) continue;
      const reservation = members[memberId]?.reservation;
      if (reservation !== undefined) entries.push({ member, reservation });
    }
    return entries;
  };

  const syncGroup = (groupKey: string | undefined): void => {
    if (groupKey === undefined) return;
    const handle = handles.get(groupKey);
    if (handle === undefined) {
      adoptGroupClaim({
        groupKey,
        entries: groupEntries(groupKey),
        authority: opts.authority,
        targetIdentity: opts.targetIdentity,
        kind,
        handles,
      });
      return;
    }
    if (foldGroupClaim(handle, groupEntries(groupKey))) handles.delete(groupKey);
  };

  return {
    register(member, state): void {
      if (!groupOf.has(member.id)) {
        groupOf.set(member.id, sleepGroupKey(member.runtimeKey, member.specDigest));
        membersById.set(member.id, member);
      }
      inner.register(member, state);
      syncGroup(groupOf.get(member.id));
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
