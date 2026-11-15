/**
 * #276 (DF-03) — node-budget admission in the fenced residency store.
 * beginOperation takes an optional nodeBudgetGiB; when present the store sums
 * reservationGiB over every nonterminal operation — pending and committed,
 * never terminal — and refuses the insert as
 * { ok: false, reason: "reservation-exceeds-budget" } once the running total
 * would exceed the budget. Ordering is pinned: fence, then the
 * same-operationId replay, then desiredRevision, then the per-model
 * reservation-conflict, then the budget check. nodeBudgetGiB is validated
 * like reservationGiB, stays out of the immutable identity, and an absent
 * budget keeps the unbudgeted behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResidencyOperationStore,
  type ResidencyOperationRecord,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

type BeginInput = Parameters<ResidencyOperationStore["beginOperation"]>[0];
type BeginOverrides = Partial<BeginInput> &
  Pick<BeginInput, "operationId" | "model" | "reservationGiB">;

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "residency-budget-"));
  dbPath = join(dir, "residency.sqlite");
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function open(path: string): ResidencyOperationStore {
  return openResidencyOperationStore({ path });
}

function requireOkRecord(
  result: ReturnType<ResidencyOperationStore["beginOperation"]>,
): ResidencyOperationRecord {
  if (!result.ok) {
    throw new Error(`expected ok beginOperation result, got ${result.reason}`);
  }
  return result.record;
}

function begin(overrides: BeginOverrides): BeginInput {
  return {
    fenceToken: 1,
    targetState: "ready",
    desiredRevision: 1,
    nowMs: 1_000,
    ...overrides,
  };
}

describe("residency reservation budget admission (#276)", () => {
  // kills: dropping the budget check; using >= instead of > (refuses the
  // equal-sum op-b); summing pending-only, which ignores the committed op-a
  // and wrongly admits op-c, since 14 + 0.5 <= 24; inserting before checking
  test("admits reservations that fit and refuses one that exceeds the node budget, leaving rows unchanged", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      expect(
        store.beginOperation(
          begin({
            operationId: "op-a",
            model: "model-a",
            reservationGiB: 10,
            nodeBudgetGiB: 24,
            nowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.commitReservation({
          fenceToken: 1,
          operationId: "op-a",
          expectedVersion: 1,
          nowMs: 2_000,
        }),
      ).toEqual({ ok: true });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-b",
            model: "model-b",
            reservationGiB: 14,
            nodeBudgetGiB: 24,
            nowMs: 3_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      const snapshot = store.listNonterminal();
      expect(
        store.beginOperation(
          begin({
            operationId: "op-c",
            model: "model-c",
            reservationGiB: 0.5,
            nodeBudgetGiB: 24,
            nowMs: 4_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "reservation-exceeds-budget" });
      expect(store.getOperation("op-c")).toBeNull();
      expect(store.listNonterminal()).toEqual(snapshot);
    } finally {
      store.close();
    }
  });

  // kills: summing over all phases including terminal (refuses op-b); not
  // summing at all (admits op-c)
  test("terminal operations do not count against the budget", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      expect(
        store.beginOperation(
          begin({
            operationId: "op-a",
            model: "model-a",
            reservationGiB: 20,
            nodeBudgetGiB: 24,
            nowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.finishOperation({
          fenceToken: 1,
          operationId: "op-a",
          expectedVersion: 1,
          outcome: "succeeded",
          nowMs: 2_000,
        }),
      ).toEqual({ ok: true });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-f",
            model: "model-f",
            reservationGiB: 20,
            nodeBudgetGiB: 24,
            nowMs: 3_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.finishOperation({
          fenceToken: 1,
          operationId: "op-f",
          expectedVersion: 1,
          outcome: "failed",
          nowMs: 4_000,
        }),
      ).toEqual({ ok: true });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-b",
            model: "model-b",
            reservationGiB: 10,
            nodeBudgetGiB: 24,
            nowMs: 5_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-c",
            model: "model-c",
            reservationGiB: 15,
            nodeBudgetGiB: 24,
            nowMs: 6_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "reservation-exceeds-budget" });
      expect(store.getOperation("op-c")).toBeNull();
    } finally {
      store.close();
    }
  });

  // kills: running the budget check before the same-operationId replay
  // lookup (the replay would see 10 + 10 > 16 and be refused); treating
  // nodeBudgetGiB as an immutable field, which turns the replay into
  // duplicate-conflict
  test("an idempotent replay of the same operationId is not double-counted", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      const opA = begin({
        operationId: "op-a",
        model: "model-a",
        reservationGiB: 10,
        nodeBudgetGiB: 16,
        nowMs: 1_000,
      });
      expect(store.beginOperation(opA)).toMatchObject({ ok: true, created: true });
      const replay = store.beginOperation(opA);
      expect(replay).toMatchObject({ ok: true, created: false });
      expect(requireOkRecord(replay).reservationGiB).toBe(10);
      expect(
        store.beginOperation(
          begin({
            operationId: "op-b",
            model: "model-b",
            reservationGiB: 6,
            nodeBudgetGiB: 16,
            nowMs: 2_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-c",
            model: "model-c",
            reservationGiB: 1,
            nodeBudgetGiB: 16,
            nowMs: 3_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "reservation-exceeds-budget" });
      expect(store.getOperation("op-c")).toBeNull();
    } finally {
      store.close();
    }
  });

  // kills: treating an absent budget as 0 or as a refusal; persisting the
  // last budget and applying it to later unbudgeted calls
  test("absent nodeBudgetGiB keeps today's unbudgeted behaviour", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      expect(
        store.beginOperation(
          begin({
            operationId: "op-a",
            model: "model-a",
            reservationGiB: 10,
            nodeBudgetGiB: 12,
            nowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-b",
            model: "model-b",
            reservationGiB: 5,
            nodeBudgetGiB: 12,
            nowMs: 2_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "reservation-exceeds-budget" });
      const unbudgeted = store.beginOperation(
        begin({
          operationId: "op-b",
          model: "model-b",
          reservationGiB: 5,
          nowMs: 3_000,
        }),
      );
      expect(unbudgeted).toMatchObject({ ok: true, created: true });
      expect(requireOkRecord(unbudgeted).reservationGiB).toBe(5);
      expect(
        store.beginOperation(
          begin({
            operationId: "op-c",
            model: "model-c",
            reservationGiB: 1000,
            nowMs: 4_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
    } finally {
      store.close();
    }
  });

  // kills: moving the budget check ahead of the fence check, the revision
  // check or the per-model conflict check
  test("check ordering is fence, then revision, then reservation", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      expect(
        store.beginOperation(
          begin({
            operationId: "op-a",
            model: "model-a",
            desiredRevision: 5,
            reservationGiB: 10,
            nodeBudgetGiB: 12,
            nowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.beginOperation(
          begin({
            fenceToken: 99,
            operationId: "op-x",
            model: "model-x",
            desiredRevision: 5,
            reservationGiB: 50,
            nodeBudgetGiB: 12,
            nowMs: 2_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-fence" });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-y",
            model: "model-y",
            desiredRevision: 4,
            reservationGiB: 50,
            nodeBudgetGiB: 12,
            nowMs: 3_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-z",
            model: "model-a",
            desiredRevision: 5,
            reservationGiB: 50,
            nodeBudgetGiB: 12,
            nowMs: 4_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "reservation-conflict" });
      expect(
        store.beginOperation(
          begin({
            operationId: "op-w",
            model: "model-w",
            desiredRevision: 5,
            reservationGiB: 50,
            nodeBudgetGiB: 12,
            nowMs: 5_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "reservation-exceeds-budget" });
      for (const operationId of ["op-x", "op-y", "op-z", "op-w"]) {
        expect(store.getOperation(operationId)).toBeNull();
      }
    } finally {
      store.close();
    }
  });

  // kills: removing the nodeBudgetGiB validation in validateBeginInput
  test("malformed nodeBudgetGiB is invalid-input", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      const badBudgets = [Number.NaN, -1, Number.POSITIVE_INFINITY];
      for (const [index, nodeBudgetGiB] of badBudgets.entries()) {
        expect(
          store.beginOperation(
            begin({
              operationId: `op-${String(index)}`,
              model: `model-${String(index)}`,
              reservationGiB: 1,
              nodeBudgetGiB,
              nowMs: 1_000,
            }),
          ),
        ).toEqual({ ok: false, reason: "invalid-input" });
      }
      expect(store.listNonterminal()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
