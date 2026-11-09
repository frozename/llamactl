import { expect, test } from "bun:test";

import type {
  AdmissionReservation,
  FiniteBudgetAdmissionInput,
  ManagedAdmissionClaim,
} from "../src/residency/admission.js";

import * as admission from "../src/residency/admission.js";
import {
  admitAgainstFiniteBudget,
  capacityBudgetGiB,
  isFiniteBudgetGiB,
  MEMORY_BUDGET_HEADROOM_RATIO,
  sumReservationGiB,
} from "../src/residency/admission.js";

const evaluate = (admission as Partial<typeof admission>).evaluateManagedAdmission;

const r = (name: string, expectedMemoryGiB: number): AdmissionReservation => ({
  name,
  expectedMemoryGiB,
});

test("sumReservationGiB sums declared allocations and ignores negatives", () => {
  expect(sumReservationGiB([r("a", 8), r("b", 16), r("c", -4)])).toBe(24);
  expect(sumReservationGiB([])).toBe(0);
});

test("capacityBudgetGiB applies the headroom ratio", () => {
  expect(capacityBudgetGiB(128 * 1024 ** 3)).toBe(128 * MEMORY_BUDGET_HEADROOM_RATIO);
  expect(capacityBudgetGiB(100 * 1024 ** 3, 1)).toBe(100);
});

test("isFiniteBudgetGiB rejects Infinity, NaN, negatives and non-numbers", () => {
  expect(isFiniteBudgetGiB(24)).toBe(true);
  expect(isFiniteBudgetGiB(0)).toBe(true);
  expect(isFiniteBudgetGiB(Number.POSITIVE_INFINITY)).toBe(false);
  expect(isFiniteBudgetGiB(Number.NaN)).toBe(false);
  expect(isFiniteBudgetGiB(-1)).toBe(false);
  expect(isFiniteBudgetGiB("24")).toBe(false);
  expect(isFiniteBudgetGiB(null)).toBe(false);
  expect(isFiniteBudgetGiB(undefined)).toBe(false);
});

const base: FiniteBudgetAdmissionInput = {
  budgetGiB: 24,
  living: [r("host-a", 16)],
  incoming: r("run-b", 8),
  forceAdmit: false,
};

test("admitAgainstFiniteBudget admits at exactly the budget", () => {
  const out = admitAgainstFiniteBudget(base);
  expect(out.ok).toBe(true);
  if (out.ok) {
    expect(out.reservedAfterGiB).toBe(24);
    expect(out.budgetGiB).toBe(24);
  }
});

test("admitAgainstFiniteBudget refuses over-budget with attributed contributors", () => {
  const out = admitAgainstFiniteBudget({ ...base, incoming: r("run-b", 9) });
  expect(out.ok).toBe(false);
  if (!out.ok && out.kind === "over-budget") {
    expect(out.reservedAfterGiB).toBe(25);
    expect(out.budgetGiB).toBe(24);
    expect(out.contributors).toEqual([r("host-a", 16), r("run-b", 9)]);
  }
});

test("admitAgainstFiniteBudget refuses unknown budgets instead of treating them as unlimited", () => {
  for (const budgetGiB of [null, undefined, Number.POSITIVE_INFINITY, Number.NaN]) {
    const out = admitAgainstFiniteBudget({ ...base, budgetGiB });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("unknown-budget");
  }
});

test("admitAgainstFiniteBudget admits zero declared allocation without a verifiable budget", () => {
  const out = admitAgainstFiniteBudget({
    budgetGiB: null,
    living: [],
    incoming: r("run-b", 0),
    forceAdmit: false,
  });
  expect(out.ok).toBe(true);
});

test("admitAgainstFiniteBudget forceAdmit bypasses over-budget and unknown-budget", () => {
  const over = admitAgainstFiniteBudget({ ...base, incoming: r("run-b", 40), forceAdmit: true });
  expect(over.ok).toBe(true);
  const unknown = admitAgainstFiniteBudget({ ...base, budgetGiB: null, forceAdmit: true });
  expect(unknown.ok).toBe(true);
  if (unknown.ok) expect(unknown.budgetGiB).toBe(null);
});

test("admitAgainstFiniteBudget refuses invalid incoming quantities instead of treating them as zero", () => {
  for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, -4]) {
    const out = admitAgainstFiniteBudget({ ...base, incoming: r("run-b", quantity) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("invalid-reservation");
  }
});

test("admitAgainstFiniteBudget refuses invalid living quantities and names the offenders", () => {
  const out = admitAgainstFiniteBudget({
    budgetGiB: 24,
    living: [r("host-nan", Number.NaN), r("host-neg", -2), r("host-ok", 8)],
    incoming: r("run-b", 8),
    forceAdmit: false,
  });
  expect(out.ok).toBe(false);
  if (!out.ok && out.kind === "invalid-reservation") {
    expect(out.invalid.map((i) => i.name)).toEqual(["host-nan", "host-neg"]);
  }
});

test("forceAdmit does not launder invalid reservation quantities", () => {
  const out = admitAgainstFiniteBudget({
    ...base,
    incoming: r("run-b", Number.NaN),
    forceAdmit: true,
  });
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.kind).toBe("invalid-reservation");
});

test("a valid zero-declared reservation stays admissible and is never flagged invalid", () => {
  const out = admitAgainstFiniteBudget({
    budgetGiB: 24,
    living: [r("host-a", 0)],
    incoming: r("run-b", 0),
    forceAdmit: false,
  });
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.reservedAfterGiB).toBe(0);
});

test("E-1: managed admission admits exactly one of two pending 16 GiB loads on a 24 GiB budget", () => {
  const claims: ManagedAdmissionClaim[] = [];
  const admitted: string[] = [];
  const decisions = [];
  for (const name of ["a", "b"]) {
    const decision = evaluate?.({
      budgetGiB: 24,
      claims,
      incoming: {
        runtimeKey: name,
        specDigest: `d-${name}`,
        allocationGiB: 16,
        kind: "ModelRun",
      },
    });
    decisions.push(decision);
    if (decision?.kind === "admit") {
      admitted.push(name);
      claims.push({
        claimId: name,
        runtimeKey: name,
        specDigest: `d-${name}`,
        state: "pending",
        allocationGiB: 16,
        kind: "ModelRun",
      });
    }
  }
  expect(admitted).toEqual(["a"]);
  expect(decisions[1]).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
});

test("E-1: uncertain claims stay charged against the managed budget", () => {
  const uncertain: ManagedAdmissionClaim = {
    claimId: "old-claim",
    runtimeKey: "old",
    specDigest: "d-old",
    state: "uncertain",
    allocationGiB: 16,
    kind: "ModelRun",
  };
  const incoming8 = evaluate?.({
    budgetGiB: 24,
    claims: [uncertain],
    incoming: {
      runtimeKey: "new",
      specDigest: "d-new",
      allocationGiB: 8,
      kind: "ModelRun",
    },
  });
  expect(incoming8).toMatchObject({
    kind: "admit",
    chargedGiB: 8,
    budgetGiB: 24,
    committedGiB: 24,
  });
  const incoming9 = evaluate?.({
    budgetGiB: 24,
    claims: [uncertain],
    incoming: {
      runtimeKey: "new",
      specDigest: "d-new",
      allocationGiB: 9,
      kind: "ModelRun",
    },
  });
  expect(incoming9).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
});

test("E-1: managed admission fails closed on unknown budget or allocation", () => {
  const incoming = {
    runtimeKey: "w",
    specDigest: "d-w",
    allocationGiB: 8,
    kind: "ModelRun" as const,
  };
  for (const budgetGiB of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    expect(evaluate?.({ budgetGiB, claims: [], incoming })).toMatchObject({
      kind: "refuse",
      reason: "BudgetUnknown",
    });
  }
  for (const allocationGiB of [undefined, 0]) {
    expect(
      evaluate?.({
        budgetGiB: 24,
        claims: [],
        incoming: { ...incoming, allocationGiB },
      }),
    ).toMatchObject({ kind: "refuse", reason: "AllocationUnknown" });
  }
  const badClaim: ManagedAdmissionClaim = {
    claimId: "bad-alloc",
    runtimeKey: "bad",
    specDigest: "d-bad",
    state: "pending",
    allocationGiB: undefined,
    kind: "ModelRun",
  };
  expect(evaluate?.({ budgetGiB: 24, claims: [badClaim], incoming })).toMatchObject({
    kind: "refuse",
    reason: "AllocationUnknown",
  });
});

test("E-1: a matching runtimeKey joins pending, reports resident, and refuses busy claims", () => {
  const incoming = {
    runtimeKey: "k",
    specDigest: "d-k",
    allocationGiB: 8,
    kind: "ModelRun" as const,
  };
  const pending: ManagedAdmissionClaim = {
    claimId: "c-pending",
    runtimeKey: "k",
    specDigest: "d-k",
    state: "pending",
    allocationGiB: 8,
    kind: "ModelRun",
  };
  expect(evaluate?.({ budgetGiB: 24, claims: [pending], incoming })).toMatchObject({
    kind: "join-pending",
    claimId: "c-pending",
  });
  const resident: ManagedAdmissionClaim = {
    ...pending,
    claimId: "c-resident",
    state: "resident",
  };
  expect(evaluate?.({ budgetGiB: 24, claims: [resident], incoming })).toMatchObject({
    kind: "already-resident",
  });
  const uncertain: ManagedAdmissionClaim = {
    ...pending,
    claimId: "c-uncertain",
    state: "uncertain",
  };
  expect(evaluate?.({ budgetGiB: 24, claims: [uncertain], incoming })).toMatchObject({
    kind: "refuse",
    reason: "WorkloadBusy",
  });
  expect(
    evaluate?.({
      budgetGiB: 24,
      claims: [pending],
      incoming: { ...incoming, specDigest: "d-other" },
    }),
  ).toMatchObject({ kind: "refuse", reason: "WorkloadBusy" });
  expect(
    evaluate?.({
      budgetGiB: 24,
      claims: [pending],
      incoming: { ...incoming, kind: "ModelHost" as const },
    }),
  ).toMatchObject({ kind: "refuse", reason: "WorkloadBusy" });
});

test("E-1: managed admission refuses beyond the charged-claim cap", () => {
  const claims: ManagedAdmissionClaim[] = Array.from(
    { length: 129 },
    (_, i): ManagedAdmissionClaim => ({
      claimId: `claim-${String(i).padStart(3, "0")}`,
      runtimeKey: `runtime-${String(i)}`,
      specDigest: `digest-${String(i)}`,
      state: "resident",
      allocationGiB: 1,
      kind: "ModelRun",
    }),
  );
  expect(
    evaluate?.({
      budgetGiB: 1000,
      claims,
      incoming: {
        runtimeKey: "new",
        specDigest: "d-new",
        allocationGiB: 1,
        kind: "ModelRun",
      },
    }),
  ).toMatchObject({ kind: "refuse", reason: "ClaimLimit" });
});

test("E-1: managed admission decisions do not depend on claim order", () => {
  const claims: ManagedAdmissionClaim[] = [
    {
      claimId: "zeta",
      runtimeKey: "k",
      specDigest: "d-k",
      state: "pending",
      allocationGiB: 4,
      kind: "ModelRun",
    },
    {
      claimId: "alpha",
      runtimeKey: "k",
      specDigest: "d-k",
      state: "pending",
      allocationGiB: 4,
      kind: "ModelRun",
    },
    {
      claimId: "mid",
      runtimeKey: "other",
      specDigest: "d-other",
      state: "resident",
      allocationGiB: 4,
      kind: "ModelRun",
    },
  ];
  const incoming = {
    runtimeKey: "k",
    specDigest: "d-k",
    allocationGiB: 4,
    kind: "ModelRun" as const,
  };
  const forward = evaluate?.({ budgetGiB: 24, claims, incoming });
  const reversed = evaluate?.({ budgetGiB: 24, claims: [...claims].reverse(), incoming });
  expect(forward).toEqual(reversed);
  expect(forward).toMatchObject({ kind: "join-pending", claimId: "alpha" });
});
