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

export function admitAgainstFiniteBudget(input: FiniteBudgetAdmissionInput): FiniteBudgetAdmission {
  const contributors = [...input.living, input.incoming].filter((r) => r.expectedMemoryGiB > 0);
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
