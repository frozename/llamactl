/**
 * Finite admission arithmetic for residency budgets (DF-01). Adapter-free:
 * numbers in, decisions out. Callers resolve *where* a budget comes from
 * (NodeRun manifest, local capacity, verified node facts); this module
 * refuses to treat an unknown or non-finite budget as unlimited.
 */

export interface AdmissionReservation {
  name: string;
  expectedMemoryGiB: number;
}

export const MEMORY_BUDGET_HEADROOM_RATIO = 0.75;

/**
 * Residency tuning knobs (Refs #519). `safetyMarginRatio` sizes every
 * computed admission budget via `defaultNodeBudgetGiB` (controller, router
 * and CLI apply paths). `switchCooldownSeconds` is enforced: `residencyPlan`
 * and `residencyApplyProfile` refuse with `Cooldown` within that many seconds
 * of the node's last succeeded profile switch recorded in the node-local
 * residency store. `minResidencySeconds` stays inert until a trustworthy
 * per-workload load time is supplied (#279).
 *
 * `idleEvictSeconds` is parse-only. It is validated as part of NodeRun
 * spec.residency, stored with the NodeRun manifest, and echoed verbatim
 * (unresolved) by residencyStatus. DEFAULT_RESIDENCY_POLICY sets it to 0 and
 * resolveResidencyPolicy copies a non-negative override, but no production
 * caller passes it to the resolver and nothing reads the resolved value: no
 * reconciler, router, residencyPlan/planner or DF-10 llama.cpp sleep driver
 * (packages/remote/src/residency/llamacpp-sleep-client.ts, which has no
 * idle trigger) consults it. Every value therefore behaves like 0 today:
 * residents are never evicted or slept for idleness. The inventory test
 * packages/remote/test/workload/residency-idle-evict-parse-only.test.ts
 * pins this.
 *
 * LLAMACTL_RESIDENCY_SESSION_IDLE_MS (sessions.ts, #520) is unrelated: it
 * expires session refcounts that block an eviction and never starts one.
 *
 * `residentPreference` and `coldLoadPenaltyMs` are consumed by
 * rankRouteCandidates (packages/core/src/routing/ranking.ts) through the
 * unified proxy's `residencyPolicy` option (Part of #519).
 * coldLoadPenaltyMs adds ms to a non-resident candidate's load cost when
 * residency is known. residentPreference adds quality points to a resident
 * candidate. Both are inert at 0 and while residency is unknown. The
 * production shared proxy supplies neither a policy nor resident signals
 * yet.
 */
export interface ResidencyPolicy {
  /** 0 = never evict idle residents. Parse-only (Part of #519): no
   * idle-eviction path exists yet, so every value behaves like 0. */
  idleEvictSeconds: number;
  /** 0 = no minimum before eviction. */
  minResidencySeconds: number;
  /** 0 = no cooldown between model switches. */
  switchCooldownSeconds: number;
  /** The fraction of node memory admission may commit; defaults to
   *  MEMORY_BUDGET_HEADROOM_RATIO. */
  safetyMarginRatio: number;
  /** Quality points added to a resident candidate's ranking score; 0 = no
   * bias toward already-resident models. Consumed by rankRouteCandidates
   * through the unified proxy's residencyPolicy option; inert at 0 and
   * while residency is unknown. */
  residentPreference: number;
  /** Milliseconds added to a non-resident candidate's load cost when
   * residency is known; 0 = no cold-load penalty. Consumed by
   * rankRouteCandidates through the unified proxy's residencyPolicy
   * option; inert at 0 and while residency is unknown. */
  coldLoadPenaltyMs: number;
}

export const DEFAULT_RESIDENCY_POLICY: Readonly<ResidencyPolicy> = Object.freeze({
  idleEvictSeconds: 0,
  minResidencySeconds: 0,
  switchCooldownSeconds: 0,
  safetyMarginRatio: MEMORY_BUDGET_HEADROOM_RATIO,
  residentPreference: 0,
  coldLoadPenaltyMs: 0,
});

export function resolveResidencyPolicy(
  overrides?: Partial<ResidencyPolicy> | null,
): ResidencyPolicy {
  const policy: ResidencyPolicy = { ...DEFAULT_RESIDENCY_POLICY };
  if (!overrides) return policy;
  const { safetyMarginRatio } = overrides;
  if (
    safetyMarginRatio !== undefined &&
    Number.isFinite(safetyMarginRatio) &&
    safetyMarginRatio > 0 &&
    safetyMarginRatio <= 1
  ) {
    policy.safetyMarginRatio = safetyMarginRatio;
  }
  for (const key of [
    "idleEvictSeconds",
    "minResidencySeconds",
    "switchCooldownSeconds",
    "residentPreference",
    "coldLoadPenaltyMs",
  ] as const) {
    const value = overrides[key];
    if (value !== undefined && Number.isFinite(value) && value >= 0) policy[key] = value;
  }
  return policy;
}

const GIB = 1024 ** 3;

export function isFiniteBudgetGiB(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function capacityBudgetGiB(
  memBytes: number,
  headroomRatio: number = MEMORY_BUDGET_HEADROOM_RATIO,
): number {
  return (memBytes / GIB) * headroomRatio;
}

export function sumReservationGiB(reservations: readonly AdmissionReservation[]): number {
  return reservations.reduce((sum, r) => sum + Math.max(0, r.expectedMemoryGiB), 0);
}

export type FiniteBudgetAdmission =
  | { ok: true; reservedAfterGiB: number; budgetGiB: number | null }
  | { ok: false; kind: "invalid-reservation"; invalid: AdmissionReservation[] }
  | { ok: false; kind: "unknown-budget"; reservedAfterGiB: number }
  | {
      ok: false;
      kind: "over-budget";
      reservedAfterGiB: number;
      budgetGiB: number;
      contributors: AdmissionReservation[];
    };

export interface FiniteBudgetAdmissionInput {
  /** null (or a non-finite number) means the budget could not be verified. */
  budgetGiB: number | null | undefined;
  living: readonly AdmissionReservation[];
  incoming: AdmissionReservation;
  forceAdmit: boolean;
}

function isInvalidReservationQuantity(value: number): boolean {
  return !Number.isFinite(value) || value < 0;
}

export function admitAgainstFiniteBudget(input: FiniteBudgetAdmissionInput): FiniteBudgetAdmission {
  const all = [...input.living, input.incoming];
  const invalid = all.filter((r) => isInvalidReservationQuantity(r.expectedMemoryGiB));
  if (invalid.length > 0) {
    return { ok: false, kind: "invalid-reservation", invalid };
  }
  const contributors = all.filter((r) => r.expectedMemoryGiB > 0);
  const reservedAfterGiB = sumReservationGiB(contributors);
  if (input.forceAdmit) {
    return {
      ok: true,
      reservedAfterGiB,
      budgetGiB: isFiniteBudgetGiB(input.budgetGiB) ? input.budgetGiB : null,
    };
  }
  // Nothing declared means nothing to charge: a workload that reserves no
  // memory cannot overspend a budget it cannot be measured against.
  if (reservedAfterGiB === 0) {
    return {
      ok: true,
      reservedAfterGiB,
      budgetGiB: isFiniteBudgetGiB(input.budgetGiB) ? input.budgetGiB : null,
    };
  }
  if (!isFiniteBudgetGiB(input.budgetGiB)) {
    return { ok: false, kind: "unknown-budget", reservedAfterGiB };
  }
  if (reservedAfterGiB > input.budgetGiB) {
    return {
      ok: false,
      kind: "over-budget",
      reservedAfterGiB,
      budgetGiB: input.budgetGiB,
      contributors,
    };
  }
  return { ok: true, reservedAfterGiB, budgetGiB: input.budgetGiB };
}

/**
 * Managed admission policy for target-owned residency authority. Pure and
 * synchronous: claims in, decision out. The target fails closed — an
 * unverifiable budget, an unmeasurable incoming allocation, or a claim that
 * cannot be counted all refuse rather than guess. Pending, resident and
 * uncertain claims all charge against the budget; a duplicate request for
 * the same runtimeKey+specDigest+kind joins the existing claim instead of
 * double-charging, and an uncertain claim is never joined or re-promoted.
 * A ModelRun and a ModelHost sharing one runtimeKey conflict regardless of
 * kind — they share one runtime directory. More than 128 claims refuse
 * before any budget arithmetic.
 */

export type ManagedClaimState = "pending" | "resident" | "uncertain";

export type ManagedWorkloadKind = "ModelRun" | "ModelHost";

export interface ManagedAdmissionClaim {
  claimId: string;
  runtimeKey: string;
  specDigest: string;
  state: ManagedClaimState;
  allocationGiB: number | undefined;
  kind?: ManagedWorkloadKind;
}

export interface ManagedAdmissionInput {
  /** undefined, non-finite or non-positive means the budget is unknown. */
  budgetGiB: number | undefined;
  claims: readonly ManagedAdmissionClaim[];
  incoming: {
    runtimeKey: string;
    specDigest: string;
    allocationGiB: number | undefined;
    kind?: ManagedWorkloadKind;
  };
}

export type ManagedAdmissionRefuseReason =
  | "BudgetUnknown"
  | "ClaimLimit"
  | "AllocationUnknown"
  | "BudgetExceeded"
  | "WorkloadBusy";

export type ManagedAdmissionDecision =
  | {
      kind: "admit";
      chargedGiB: number;
      budgetGiB: number;
      /** Committed total after charging the incoming claim. */
      committedGiB: number;
    }
  | { kind: "join-pending"; claimId: string }
  | { kind: "already-resident"; claimId: string }
  | { kind: "refuse"; reason: ManagedAdmissionRefuseReason; detail: string };

const maxClaims = 128;

const minString = (min: string, id: string): string => (id < min ? id : min);

function isKnownGiB(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function evaluateManagedAdmission(input: ManagedAdmissionInput): ManagedAdmissionDecision {
  if (!isKnownGiB(input.budgetGiB)) {
    return {
      kind: "refuse",
      reason: "BudgetUnknown",
      detail: `target budget is not a positive finite GiB figure (got ${String(input.budgetGiB)})`,
    };
  }
  const budgetGiB = input.budgetGiB;

  if (input.claims.length > maxClaims) {
    return {
      kind: "refuse",
      reason: "ClaimLimit",
      detail: `${String(input.claims.length)} claims exceed the cap of ${String(maxClaims)}`,
    };
  }

  if (!isKnownGiB(input.incoming.allocationGiB)) {
    return {
      kind: "refuse",
      reason: "AllocationUnknown",
      detail: `incoming ${input.incoming.runtimeKey} has no measurable GiB allocation`,
    };
  }
  const chargedGiB = input.incoming.allocationGiB;

  const uncounted = input.claims
    .filter((c) => !isKnownGiB(c.allocationGiB))
    .map((c) => c.claimId)
    .sort();
  if (uncounted.length > 0) {
    return {
      kind: "refuse",
      reason: "AllocationUnknown",
      detail: `claims ${uncounted.join(", ")} cannot be counted against the budget`,
    };
  }

  const sameKey = input.claims.filter((c) => c.runtimeKey === input.incoming.runtimeKey);
  const busy = sameKey
    .filter(
      (c) =>
        c.specDigest !== input.incoming.specDigest ||
        c.kind !== input.incoming.kind ||
        c.state === "uncertain",
    )
    .map((c) => c.claimId)
    .sort();
  if (busy.length > 0) {
    return {
      kind: "refuse",
      reason: "WorkloadBusy",
      detail: `runtimeKey ${input.incoming.runtimeKey} is held by conflicting claims ${busy.join(", ")}`,
    };
  }

  const resident = sameKey.filter((c) => c.state === "resident").map((c) => c.claimId);
  if (resident.length > 0) {
    return { kind: "already-resident", claimId: resident.reduce(minString) };
  }
  if (sameKey.length > 0) {
    return { kind: "join-pending", claimId: sameKey.map((c) => c.claimId).reduce(minString) };
  }

  const claimsCommittedGiB = input.claims.reduce((sum, c) => sum + (c.allocationGiB ?? 0), 0);
  const committedGiB = claimsCommittedGiB + chargedGiB;
  if (committedGiB > budgetGiB) {
    return {
      kind: "refuse",
      reason: "BudgetExceeded",
      detail: `committed ${String(claimsCommittedGiB)} GiB plus incoming ${String(chargedGiB)} GiB exceeds budget ${String(budgetGiB)} GiB`,
    };
  }
  return { kind: "admit", chargedGiB, budgetGiB, committedGiB };
}
