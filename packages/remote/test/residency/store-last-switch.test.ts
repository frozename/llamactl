// #519: the snapshot reader reports, per model, the updated_at_ms of the
// newest terminal operation that finished `succeeded`, so the
// switchCooldownSeconds knob can measure the last profile switch from the
// node-local store. At the pinned base readResidencyStoreSnapshot returns no
// lastSucceededAtMs, so the map assertions fail by assertion — never by
// import, type or missing-export error.
import { Database } from "bun:sqlite";
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

type LifecycleErrorSnapshot = ReadableStoreSnapshot & {
  lifecycle?: unknown;
  lifecycleError?: string;
};

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

  test("S4: a lifecycle read failure still carries lastSucceededAtMs", () => {
    // kills: dropping lastSucceededAtMs from the lifecycleError branch.
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
    } finally {
      store.close();
    }
    // An unknown lifecycle state makes the lifecycle-row read throw.
    const raw = new Database(dbPath);
    try {
      raw.run("PRAGMA ignore_check_constraints = ON");
      raw.run(
        "INSERT INTO residency_states (model, residency_group, state, owner_id, incarnation, fence_token, version, updated_at_ms, desired_revision) VALUES ('m-new', NULL, 'hibernating', 'o', 'i', 1, 1, 5, NULL)",
      );
    } finally {
      raw.close();
    }

    const snapshot = readableSnapshot(dbPath) as LifecycleErrorSnapshot;
    expect(snapshot).not.toHaveProperty("lifecycle");
    expect(snapshot.lifecycleError).toContain("unknown state hibernating");
    expect(snapshot.lastSucceededAtMs).toEqual({ "profile-switch:n1": 1000 });
  });

  test("S5: a failing last-succeeded read makes the whole snapshot an error", () => {
    // kills: swallowing a lastSucceededAtMs / operations read failure into an
    // empty map or into lifecycleError instead of the whole-store error.
    // `operations` is a view whose outcome column raises only when evaluated
    // for a terminal row, so the nonterminal read (which filters terminal rows
    // out first) succeeds and only the succeeded-finish read fails.
    const raw = new Database(dbPath);
    try {
      raw.run(
        "CREATE TABLE ops_raw (operation_id TEXT PRIMARY KEY, model TEXT NOT NULL, target_state TEXT NOT NULL, desired_revision INTEGER NOT NULL, reservation_gib REAL NOT NULL, phase TEXT NOT NULL, outcome TEXT, detail TEXT, owner_id TEXT NOT NULL, incarnation TEXT NOT NULL, fence_token INTEGER NOT NULL, version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)",
      );
      raw.run(
        "INSERT INTO ops_raw VALUES ('op-n1-a', 'profile-switch:n1', 'ready', 0, 0, 'terminal', 'succeeded', NULL, 'o', 'i', 1, 2, 900, 1000)",
      );
      raw.run(
        "CREATE VIEW operations AS SELECT operation_id, model, target_state, desired_revision, reservation_gib, phase, CASE WHEN phase = 'terminal' THEN abs(-9223372036854775807 - 1) ELSE outcome END AS outcome, detail, owner_id, incarnation, fence_token, version, created_at_ms, updated_at_ms FROM ops_raw",
      );
    } finally {
      raw.close();
    }

    const snapshot: StoreSnapshot = readResidencyStoreSnapshot(dbPath);
    expect(snapshot.present).toBe(true);
    expect("error" in snapshot).toBe(true);
    expect(snapshot).not.toHaveProperty("nonterminal");
    expect(snapshot).not.toHaveProperty("lastSucceededAtMs");
    if (snapshot.present && "error" in snapshot) {
      expect(snapshot.error).toContain("integer overflow");
    }
  });
});
