// #519: the snapshot reader reports, per model, the updated_at_ms of the
// newest terminal operation that finished `succeeded`, so the
// switchCooldownSeconds knob can measure the last profile switch from the
// node-local store. At the pinned base readResidencyStoreSnapshot returns no
// lastSucceededAtMs, so the map assertions fail by assertion — never by
// import, type or missing-export error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
  type ResidencyOperationOutcome,
  type ResidencyOperationRecord,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

type ReadableStoreSnapshot = {
  path: string;
  present: true;
  nonterminal: ResidencyOperationRecord[];
  lastSucceededAtMs?: Record<string, number>;
};

type StoreSnapshot =
  | { path: string; present: false }
  | { path: string; present: true; error: string }
  | ReadableStoreSnapshot;

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "residency-last-switch-"));
  dbPath = join(dir, "residency.sqlite");
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

type SeedOperation = {
  operationId: string;
  model: string;
  beginMs: number;
  finishMs?: number;
  outcome?: ResidencyOperationOutcome;
};

function seedOperation(
  store: ResidencyOperationStore,
  fenceToken: number,
  op: SeedOperation,
): void {
  const begun = store.beginOperation({
    fenceToken,
    operationId: op.operationId,
    model: op.model,
    targetState: "ready",
    desiredRevision: 0,
    reservationGiB: 0,
    nowMs: op.beginMs,
  });
  expect(begun.ok).toBe(true);
  if (!begun.ok || op.finishMs === undefined || op.outcome === undefined) {
    return;
  }
  const finished = store.finishOperation({
    fenceToken,
    operationId: op.operationId,
    expectedVersion: begun.record.version,
    nowMs: op.finishMs,
    outcome: op.outcome,
  });
  expect(finished).toEqual({ ok: true });
}

function readableSnapshot(path: string): ReadableStoreSnapshot {
  const snapshot: StoreSnapshot = readResidencyStoreSnapshot(path);
  expect(snapshot.present).toBe(true);
  if (!snapshot.present || "error" in snapshot) {
    throw new Error(`expected a readable snapshot, got ${JSON.stringify(snapshot)}`);
  }
  return snapshot;
}

describe("readResidencyStoreSnapshot lastSucceededAtMs (#519)", () => {
  test("S1: reports the newest succeeded finish per model, ignoring failed/cancelled/nonterminal rows", () => {
    // kills: omitting the field, MIN instead of MAX, counting
    // failed/cancelled/unknown outcomes, or counting nonterminal rows.
    const store = openResidencyOperationStore({ path: dbPath });
    try {
      const fence = store.claimOwnership({ ownerId: "seed", incarnation: "seed" });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-n1-a",
        model: "profile-switch:n1",
        beginMs: 900,
        finishMs: 1000,
        outcome: "succeeded",
      });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-n1-b",
        model: "profile-switch:n1",
        beginMs: 4900,
        finishMs: 5000,
        outcome: "succeeded",
      });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-n1-c",
        model: "profile-switch:n1",
        beginMs: 8900,
        finishMs: 9000,
        outcome: "failed",
      });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-n2-a",
        model: "profile-switch:n2",
        beginMs: 6900,
        finishMs: 7000,
        outcome: "cancelled",
      });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-n3-a",
        model: "profile-switch:n3",
        beginMs: 2900,
        finishMs: 3000,
        outcome: "succeeded",
      });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-x-a",
        model: "x",
        beginMs: 8000,
      });
    } finally {
      store.close();
    }

    const snapshot = readableSnapshot(dbPath);
    expect(snapshot.lastSucceededAtMs).toEqual({
      "profile-switch:n1": 5000,
      "profile-switch:n3": 3000,
    });
  });

  test("S2: nonterminal still lists exactly the pending op", () => {
    // kills: the new field displacing or filtering the nonterminal list.
    const store = openResidencyOperationStore({ path: dbPath });
    try {
      const fence = store.claimOwnership({ ownerId: "seed", incarnation: "seed" });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-n1-a",
        model: "profile-switch:n1",
        beginMs: 900,
        finishMs: 1000,
        outcome: "succeeded",
      });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-x-a",
        model: "x",
        beginMs: 8000,
      });
    } finally {
      store.close();
    }

    const snapshot = readableSnapshot(dbPath);
    expect(snapshot.nonterminal.map((record) => record.operationId)).toEqual(["op-x-a"]);
    expect(snapshot.nonterminal[0]?.model).toBe("x");
    expect(snapshot.nonterminal[0]?.phase).toBe("pending");
  });

  test("S3: a store with only nonterminal rows reports an empty lastSucceededAtMs", () => {
    // kills: returning undefined instead of an empty map.
    const store = openResidencyOperationStore({ path: dbPath });
    try {
      const fence = store.claimOwnership({ ownerId: "seed", incarnation: "seed" });
      seedOperation(store, fence.fenceToken, {
        operationId: "op-x-a",
        model: "x",
        beginMs: 8000,
      });
    } finally {
      store.close();
    }

    const snapshot = readableSnapshot(dbPath);
    expect(snapshot.lastSucceededAtMs).toEqual({});
  });
});
