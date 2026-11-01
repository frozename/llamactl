/**
 * Managed admission policy for target-owned residency authority. Pure and
 * synchronous: claims in, decision out. The target fails closed — an
 * unverifiable budget, an unmeasurable incoming allocation, or a claim that
 * cannot be counted all refuse rather than guess. Pending, resident and
 * uncertain claims all charge against the budget; a duplicate request for
 * the same runtimeKey+specDigest joins the existing claim instead of
 * double-charging, and an uncertain claim is never joined or re-promoted.
 */

export type ManagedClaimState = "pending" | "resident" | "uncertain";

export interface ManagedAdmissionClaim {
  claimId: string;
  runtimeKey: string;
  specDigest: string;
  state: ManagedClaimState;
  allocationGiB: number | undefined;
}

export interface ManagedAdmissionInput {
  /** undefined, non-finite or non-positive means the budget is unknown. */
  budgetGiB: number | undefined;
  claims: readonly ManagedAdmissionClaim[];
  incoming: {
    runtimeKey: string;
    specDigest: string;
    allocationGiB: number | undefined;
  };
}

export type ManagedAdmissionRefuseReason =
  | "BudgetUnknown"
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
    .filter((c) => c.specDigest !== input.incoming.specDigest || c.state === "uncertain")
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

  const committedGiB =
    input.claims.reduce((sum, c) => sum + (c.allocationGiB ?? 0), 0) + chargedGiB;
  if (committedGiB > budgetGiB) {
    return {
      kind: "refuse",
      reason: "BudgetExceeded",
      detail: `committed ${String(committedGiB)} GiB exceeds budget ${String(budgetGiB)} GiB`,
    };
  }
  return { kind: "admit", chargedGiB, budgetGiB, committedGiB };
}
