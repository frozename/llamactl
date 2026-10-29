import { expect, test } from "bun:test";

import {
  type AdmissionReservation,
  admitAgainstFiniteBudget,
  capacityBudgetGiB,
  type FiniteBudgetAdmissionInput,
  isFiniteBudgetGiB,
  MEMORY_BUDGET_HEADROOM_RATIO,
  sumReservationGiB,
} from "../src/residency/admission.js";

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
