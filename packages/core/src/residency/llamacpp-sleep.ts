/**
 * DF-10 (#283) pure, synchronous, no IO and no timers llama.cpp sleep / wake
 * residency controller with process fallback. Not wired into any ingress
 * yet; actual memory admission stays with evaluateManagedAdmission.
 */

import type { ManagedAdmissionClaim, ManagedClaimState } from "./admission.js";

import { evaluateManagedAdmission, isFiniteBudgetGiB } from "./admission.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type SleepCapability =
  | { kind: "guarded-sleep"; fork: string; build: string }
  | { kind: "process-fallback"; reason: string };

export type ObservedSleepState =
  | "unknown"
  | "stopped"
  | "sleeping"
  | "ready"
  | "loading"
  | "unhealthy";

export type SleepReconcileAction =
  | { kind: "none" }
  | { kind: "request-wake" }
  | { kind: "request-sleep" }
  | { kind: "restart" }
  | { kind: "process-stop" }
  | { kind: "start" }
  | { kind: "hold"; reason: "ResidencyUnknown" };

export interface SleepReconcileResult {
  action: SleepReconcileAction;
  wakingProbesAllowed: boolean;
}

export interface SleepMember {
  id: string;
  runtimeKey: string;
  specDigest: string;
  allocationGiB: number;
  capability: SleepCapability;
}

// Internal states for the controller
type ControllerState = "ready" | "waking" | "sleep-pending" | "sleeping" | "stopped" | "unknown";

// Reservation types
type Reservation = "resident" | "pending" | "released" | "uncertain";

interface ControllerMember {
  id: string;
  runtimeKey: string;
  specDigest: string;
  allocationGiB: number;
  capability: SleepCapability;
  state: ControllerState;
  reservation: Reservation;
  cacheIdentity?: string;
}

interface SleepAuditEntry {
  id: string;
  observed: ObservedSleepState;
  kept: ControllerState;
  reason: "WakeInFlight" | "SleepInFlight";
}

// ── qualifySleepCapability ─────────────────────────────────────────────────

export function qualifySleepCapability(
  identity: { engine: string; fork?: string; build?: string },
  qualifications: readonly { fork: string; build: string }[],
): SleepCapability {
  if (identity.engine !== "llamacpp") {
    return { kind: "process-fallback", reason: "EngineNotLlamacpp" };
  }
  const fork = identity.fork;
  const build = identity.build;
  if (!fork || !build) {
    return { kind: "process-fallback", reason: "BuildUnknown" };
  }
  const match = qualifications.find((q) => q.fork === fork && q.build === build);
  if (!match) {
    return { kind: "process-fallback", reason: "NotQualified" };
  }
  return { kind: "guarded-sleep", fork, build };
}

// ── classifySleepObservation ───────────────────────────────────────────────

export function classifySleepObservation(
  observation: {
    processAlive?: boolean;
    healthStatus?: number;
    isSleeping?: boolean;
  },
  capability: SleepCapability,
): ObservedSleepState {
  // Missing process liveness → unknown
  if (observation.processAlive === undefined) {
    return "unknown";
  }
  // Dead process → stopped (even if it claims sleeping)
  if (!observation.processAlive) {
    return "stopped";
  }
  // Live process — check further signals
  if (capability.kind === "guarded-sleep") {
    // Guarded: live + sleeping flag + healthy → sleeping
    if (observation.isSleeping && observation.healthStatus === 200) {
      return "sleeping";
    }
  }
  // 503 → loading
  if (observation.healthStatus === 503) {
    return "loading";
  }
  // Missing health or non-200 → unhealthy (unless it's a guarded process
  // that isn't sleeping, which is ready)
  if (observation.healthStatus !== 200) {
    return "unhealthy";
  }
  // Live + healthy + (not sleeping or process-fallback) → ready
  return "ready";
}

// ── decideSleepReconcile ───────────────────────────────────────────────────

function reconcileReadyAsleep(capability: SleepCapability): SleepReconcileResult {
  if (capability.kind === "guarded-sleep") {
    return { action: { kind: "request-sleep" }, wakingProbesAllowed: false };
  }
  return { action: { kind: "process-stop" }, wakingProbesAllowed: false };
}

export function decideSleepReconcile(input: {
  desired: "awake" | "asleep";
  observed: ObservedSleepState;
  capability: SleepCapability;
}): SleepReconcileResult {
  const { desired, observed, capability } = input;

  switch (observed) {
    case "unknown":
      return {
        action: { kind: "hold", reason: "ResidencyUnknown" },
        wakingProbesAllowed: false,
      };

    case "stopped":
      if (desired === "awake") {
        return { action: { kind: "start" }, wakingProbesAllowed: false };
      }
      return { action: { kind: "none" }, wakingProbesAllowed: false };

    case "sleeping":
      if (capability.kind === "guarded-sleep" && desired === "awake") {
        return { action: { kind: "request-wake" }, wakingProbesAllowed: false };
      }
      return { action: { kind: "none" }, wakingProbesAllowed: false };

    case "ready":
      return desired === "asleep"
        ? reconcileReadyAsleep(capability)
        : { action: { kind: "none" }, wakingProbesAllowed: true };

    case "loading":
      return { action: { kind: "none" }, wakingProbesAllowed: false };

    case "unhealthy":
      if (desired === "awake") {
        return { action: { kind: "restart" }, wakingProbesAllowed: false };
      }
      return {
        action: { kind: "process-stop" },
        wakingProbesAllowed: false,
      };

    default:
      return { action: { kind: "none" }, wakingProbesAllowed: false };
  }
}

// ── createLlamacppSleepController ──────────────────────────────────────────

export interface LlamacppSleepController {
  register: (member: SleepMember, state: ObservedSleepState) => void;
  requestWake: (
    id: string,
    opts?: { cacheIdentity?: string },
  ) =>
    | {
        kind: "wake";
        chargedGiB: number;
        committedGiB: number;
        slots: "restore" | "discard";
      }
    | {
        kind: "join-wake";
        committedGiB: number;
      }
    | {
        kind: "already-awake";
      }
    | {
        kind: "process-switch";
        reason: string;
      }
    | {
        kind: "refuse";
        reason: string;
      };
  wakeSettled: (id: string, outcome: "ready" | "cancelled" | "readiness-failed") => void;
  requestSleep: (id: string) =>
    | {
        kind: "sleep";
        committedGiB: number;
      }
    | {
        kind: "process-stop";
      }
    | {
        kind: "refuse";
        reason: string;
      };
  sleepSettled: (id: string, outcome: "slept" | "failed", cacheIdentity?: string) => void;
  observe: (id: string, state: ObservedSleepState) => void;
  snapshot: () => {
    committedGiB: number;
    members: Record<string, { state: ControllerState; reservation: Reservation }>;
    audit: SleepAuditEntry[];
  };
}

// ── Controller internals ───────────────────────────────────────────────────

function stateToControllerState(state: ObservedSleepState): ControllerState {
  switch (state) {
    case "unknown":
      return "unknown";
    case "stopped":
      return "stopped";
    case "sleeping":
      return "sleeping";
    case "ready":
      return "ready";
    case "loading":
      return "waking";
    case "unhealthy":
      return "unknown";
  }
}

function getReservation(state: ControllerState): Reservation {
  switch (state) {
    case "ready":
      return "resident";
    case "waking":
      return "pending";
    case "sleep-pending":
      return "resident";
    case "sleeping":
    case "stopped":
      return "released";
    case "unknown":
      return "uncertain";
  }
}

function getClaimState(state: ControllerState): ManagedAdmissionClaim["state"] {
  switch (state) {
    case "ready":
      return "resident";
    case "waking":
      return "pending";
    case "sleep-pending":
      return "resident";
    case "sleeping":
    case "stopped":
    case "unknown":
      return "uncertain";
  }
}

// Members that share a runtimeKey+specDigest are handles on one runtime:
// the budget and the admission claims bill the group once, at its largest
// declared allocation, so a wake joining a resident or pending sibling
// never double-charges.
function runtimeGroupKey(member: { runtimeKey: string; specDigest: string }): string {
  return JSON.stringify([member.runtimeKey, member.specDigest]);
}

function computeCommittedGiB(members: ReadonlyMap<string, ControllerMember>): number {
  const groups = new Map<string, number>();
  for (const m of members.values()) {
    if (m.reservation === "released") continue;
    const key = runtimeGroupKey(m);
    const prev = groups.get(key);
    groups.set(key, prev === undefined ? m.allocationGiB : Math.max(prev, m.allocationGiB));
  }
  let total = 0;
  for (const allocationGiB of groups.values()) {
    total += allocationGiB;
  }
  return total;
}

// A joiner declaring more than its runtime group's current billed
// allocation raises committedGiB by only the difference; that delta must
// still fit the budget or the join is refused like any other admit.
function joinDeltaOverBudget(
  members: ReadonlyMap<string, ControllerMember>,
  member: ControllerMember,
  budgetGiB: number | undefined,
): boolean {
  const key = runtimeGroupKey(member);
  let billedGiB = 0;
  for (const m of members.values()) {
    if (m.reservation !== "released" && runtimeGroupKey(m) === key && m.allocationGiB > billedGiB) {
      billedGiB = m.allocationGiB;
    }
  }
  const deltaGiB = member.allocationGiB - billedGiB;
  if (deltaGiB <= 0) return false;
  if (!isFiniteBudgetGiB(budgetGiB)) return true;
  return computeCommittedGiB(members) + deltaGiB > budgetGiB;
}

function managedClaimRank(state: ManagedClaimState): number {
  switch (state) {
    case "pending":
      return 2;
    case "resident":
      return 1;
    case "uncertain":
      return 0;
  }
}

function groupMembersByRuntime(
  members: ReadonlyMap<string, ControllerMember>,
): Map<string, ControllerMember[]> {
  const groups = new Map<string, ControllerMember[]>();
  for (const m of members.values()) {
    if (m.reservation === "released") continue;
    const key = runtimeGroupKey(m);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [m]);
    } else {
      group.push(m);
    }
  }
  return groups;
}

function mergeRuntimeGroup(group: readonly ControllerMember[]): ManagedAdmissionClaim {
  const primary = group.reduce((a, b) => (a.id < b.id ? a : b));
  let state = getClaimState(primary.state);
  let allocationGiB = primary.allocationGiB;
  for (const m of group) {
    const claimState = getClaimState(m.state);
    if (managedClaimRank(claimState) > managedClaimRank(state)) state = claimState;
    if (m.allocationGiB > allocationGiB) allocationGiB = m.allocationGiB;
  }
  return {
    claimId: primary.id,
    runtimeKey: primary.runtimeKey,
    specDigest: primary.specDigest,
    state,
    allocationGiB,
  };
}

function buildClaims(members: ReadonlyMap<string, ControllerMember>): ManagedAdmissionClaim[] {
  const claims: ManagedAdmissionClaim[] = [];
  for (const group of groupMembersByRuntime(members).values()) {
    claims.push(mergeRuntimeGroup(group));
  }
  return claims;
}

function applyWakeSettled(
  member: ControllerMember,
  outcome: "ready" | "cancelled" | "readiness-failed",
): void {
  if (member.state !== "waking") return;
  if (outcome === "ready") {
    member.state = "ready";
    member.reservation = "resident";
  } else {
    member.state = "unknown";
    member.reservation = "uncertain";
  }
}

function applySleepSettled(
  member: ControllerMember,
  outcome: "slept" | "failed",
  cacheIdentity?: string,
): void {
  if (member.state !== "sleep-pending") return;
  if (outcome === "slept") {
    member.state = "sleeping";
    member.reservation = "released";
    if (cacheIdentity !== undefined) {
      member.cacheIdentity = cacheIdentity;
    }
  } else {
    member.state = "unknown";
    member.reservation = "uncertain";
  }
}

// A member mid-transition resolves only through its settle. While 'waking'
// the pending reservation may not be released or restated by a stale probe —
// 'ready' is the one post-transition state safe to accept early because it
// keeps the same charge. While 'sleep-pending' every observed state is gated:
// accepting 'sleeping' would let a later 'failed' settle be ignored and leave
// the member released while still resident.
function pendingObserveBlock(
  member: ControllerMember,
  state: ObservedSleepState,
): "WakeInFlight" | "SleepInFlight" | null {
  if (member.state === "sleep-pending") {
    return "SleepInFlight";
  }
  if (member.state === "waking") {
    const next = stateToControllerState(state);
    if (next !== "waking" && next !== "ready") {
      return "WakeInFlight";
    }
  }
  return null;
}

class LlamacppSleepControllerImpl implements LlamacppSleepController {
  private readonly budgetGiB: number | undefined;
  private readonly members = new Map<string, ControllerMember>();
  private readonly audit: SleepAuditEntry[] = [];

  constructor(opts: { budgetGiB?: number }) {
    this.budgetGiB = opts.budgetGiB;
  }

  register(member: SleepMember, state: ObservedSleepState): void {
    const existing = this.members.get(member.id);
    if (existing !== undefined) {
      // Update existing member but preserve its state
      existing.capability = member.capability;
      return;
    }
    const controllerState = stateToControllerState(state);
    this.members.set(member.id, {
      id: member.id,
      runtimeKey: member.runtimeKey,
      specDigest: member.specDigest,
      allocationGiB: member.allocationGiB,
      capability: member.capability,
      state: controllerState,
      reservation: getReservation(controllerState),
    });
  }

  requestWake(
    id: string,
    opts?: { cacheIdentity?: string },
  ): ReturnType<LlamacppSleepController["requestWake"]> {
    const member = this.members.get(id);
    if (member === undefined) {
      return { kind: "refuse", reason: "UnknownMember" };
    }
    return this.doRequestWake(member, opts);
  }

  wakeSettled(id: string, outcome: "ready" | "cancelled" | "readiness-failed"): void {
    const member = this.members.get(id);
    if (member === undefined) return;
    applyWakeSettled(member, outcome);
  }

  requestSleep(id: string): ReturnType<LlamacppSleepController["requestSleep"]> {
    const member = this.members.get(id);
    if (member === undefined) {
      return { kind: "refuse", reason: "UnknownMember" };
    }
    return this.doRequestSleep(member);
  }

  sleepSettled(id: string, outcome: "slept" | "failed", cacheIdentity?: string): void {
    const member = this.members.get(id);
    if (member === undefined) return;
    applySleepSettled(member, outcome, cacheIdentity);
  }

  observe(id: string, state: ObservedSleepState): void {
    const member = this.members.get(id);
    if (member === undefined) return;
    const blocked = pendingObserveBlock(member, state);
    if (blocked !== null) {
      this.audit.push({
        id: member.id,
        observed: state,
        kept: member.state,
        reason: blocked,
      });
      return;
    }
    const controllerState = stateToControllerState(state);
    member.state = controllerState;
    member.reservation = getReservation(controllerState);
  }

  snapshot(): {
    committedGiB: number;
    members: Record<string, { state: ControllerState; reservation: Reservation }>;
    audit: SleepAuditEntry[];
  } {
    const membersRecord: Record<string, { state: ControllerState; reservation: Reservation }> = {};
    const sorted = [...this.members.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const m of sorted) {
      membersRecord[m.id] = {
        state: m.state,
        reservation: m.reservation,
      };
    }
    return {
      committedGiB: computeCommittedGiB(this.members),
      members: membersRecord,
      audit: [...this.audit],
    };
  }

  private doRequestWake(
    member: ControllerMember,
    opts: { cacheIdentity?: string } | undefined,
  ): ReturnType<LlamacppSleepController["requestWake"]> {
    // Process-fallback: switch process, never touch budget
    if (member.capability.kind === "process-fallback") {
      return {
        kind: "process-switch",
        reason: member.capability.reason,
      };
    }

    // Guarded sleep — check state
    if (member.state === "ready") {
      return { kind: "already-awake" };
    }
    if (member.state === "stopped") {
      return { kind: "refuse", reason: "NotSleeping" };
    }
    if (member.state === "unknown") {
      return { kind: "refuse", reason: "ResidencyUnknown" };
    }

    // A sleep is in flight: refuse wake until the sleep settles.
    // Prevents the overlapping sleep+wake budget overrun:
    // wake charges, late sleepSettled frees, wake completes without budget check.
    if (member.state === "sleep-pending") {
      return { kind: "refuse", reason: "SleepInFlight" };
    }

    // Check if already waking (join-wake)
    if (member.state === "waking") {
      return { kind: "join-wake", committedGiB: computeCommittedGiB(this.members) };
    }

    // Guarded: attempt admission via evaluateManagedAdmission
    const decision = evaluateManagedAdmission({
      budgetGiB: this.budgetGiB,
      claims: buildClaims(this.members),
      incoming: {
        runtimeKey: member.runtimeKey,
        specDigest: member.specDigest,
        allocationGiB: member.allocationGiB,
      },
    });

    switch (decision.kind) {
      case "refuse":
        return { kind: "refuse", reason: decision.reason };
      case "already-resident":
      case "join-pending":
        return this.joinRuntimeGroup(member, decision.kind);
      case "admit": {
        member.state = "waking";
        member.reservation = "pending";
        const slots: "restore" | "discard" =
          opts?.cacheIdentity && member.cacheIdentity === opts.cacheIdentity
            ? "restore"
            : "discard";
        return {
          kind: "wake",
          chargedGiB: member.allocationGiB,
          committedGiB: computeCommittedGiB(this.members),
          slots,
        };
      }
      default: {
        const exhaustive: never = decision;
        throw new Error(`Unhandled admission decision: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // A sibling on the same runtime is already resident or mid-wake: the
  // member joins it and the group stays billed once at its largest member
  // allocation. A joiner above that bill adds only the difference to
  // committedGiB, and the delta must fit the budget.
  private joinRuntimeGroup(
    member: ControllerMember,
    join: "already-resident" | "join-pending",
  ): ReturnType<LlamacppSleepController["requestWake"]> {
    if (joinDeltaOverBudget(this.members, member, this.budgetGiB)) {
      return { kind: "refuse", reason: "BudgetExceeded" };
    }
    if (join === "join-pending") {
      member.state = "waking";
      member.reservation = "pending";
      return {
        kind: "join-wake",
        committedGiB: computeCommittedGiB(this.members),
      };
    }
    member.state = "ready";
    member.reservation = "resident";
    return { kind: "already-awake" };
  }

  private doRequestSleep(
    member: ControllerMember,
  ): ReturnType<LlamacppSleepController["requestSleep"]> {
    // Process-fallback: stop process, never touch budget
    if (member.capability.kind === "process-fallback") {
      return { kind: "process-stop" };
    }

    // Guarded: move to sleep-pending
    if (member.state === "ready") {
      member.state = "sleep-pending";
      return { kind: "sleep", committedGiB: computeCommittedGiB(this.members) };
    }

    // Can't sleep while waking — the wake's pending reservation must be
    // resolved first (either to resident via wakeSettled('ready') or to
    // uncertain via wakeSettled('cancelled')).
    if (member.state === "waking") {
      return { kind: "refuse", reason: "WakeInFlight" };
    }

    if (member.state === "sleeping" || member.state === "sleep-pending") {
      return { kind: "refuse", reason: "AlreadySleeping" };
    }

    return { kind: "refuse", reason: "NotSleeping" };
  }
}

export function createLlamacppSleepController(opts: {
  budgetGiB?: number;
}): LlamacppSleepController {
  return new LlamacppSleepControllerImpl(opts);
}
