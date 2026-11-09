import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

// #276 (DF-03): fenced residency operation storage lands with the fix. The
// module does not exist at the pinned base.
const STORE_MODULE = "../../src/residency/store.js";

type OperationPhase = "pending" | "committed" | "terminal";
type OperationOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
type FailureReason =
  | "stale-fence"
  | "version-conflict"
  | "not-found"
  | "duplicate-conflict"
  | "reservation-conflict"
  | "illegal-phase"
  | "invalid-input";

type Fence = {
  ownerId: string;
  incarnation: string;
  fenceToken: number;
};

type OperationRecord = {
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  reservationGiB: number;
  phase: OperationPhase;
  outcome: OperationOutcome | null;
  detail: string | null;
  ownerId: string;
  incarnation: string;
  fenceToken: number;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
};

type BeginOperationInput = {
  fenceToken: number;
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  reservationGiB: number;
  nowMs: number;
};

type MutationInput = {
  fenceToken: number;
  operationId: string;
  expectedVersion: number;
  nowMs: number;
};

type FinishOperationInput = MutationInput & {
  outcome: OperationOutcome;
  detail?: string;
};

type BeginOperationResult =
  | { ok: true; created: boolean; record: OperationRecord }
  | { ok: false; reason: FailureReason };

type MutationResult = { ok: true } | { ok: false; reason: FailureReason };

type ResidencyOperationStore = {
  claimOwnership: (input: { ownerId: string; incarnation: string }) => Fence;
  currentFence: () => Fence | null;
  beginOperation: (input: BeginOperationInput) => BeginOperationResult;
  commitReservation: (input: MutationInput) => MutationResult;
  finishOperation: (input: FinishOperationInput) => MutationResult;
  getOperation: (operationId: string) => OperationRecord | null;
  listNonterminal: () => OperationRecord[];
  close: () => void;
};

type StoreModule = {
  openResidencyOperationStore: (input: { path: string }) => ResidencyOperationStore;
};

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "residency-store-"));
  dbPath = join(dir, "residency.db");
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

// The dynamic-import loader exists only so RED fails by assertion: at the
// pinned base the module is absent, load() returns null, and the
// openResidencyOperationStore typeof check in each test fails. A variable
// specifier keeps tsc from resolving the not-yet-existing module — a literal
// specifier would be a resolution error, not an assertion failure.
async function load(): Promise<StoreModule | null> {
  try {
    return (await import(STORE_MODULE)) as StoreModule;
  } catch {
    return null;
  }
}

function openStore(mod: StoreModule): ResidencyOperationStore {
  return mod.openResidencyOperationStore({ path: dbPath });
}

function beginInput(overrides: Partial<BeginOperationInput> = {}): BeginOperationInput {
  return {
    fenceToken: 1,
    operationId: "op-1",
    model: "model-a",
    targetState: "ready",
    desiredRevision: 1,
    reservationGiB: 4,
    nowMs: 1_000,
    ...overrides,
  };
}

function expectedRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    operationId: "op-1",
    model: "model-a",
    targetState: "ready",
    desiredRevision: 1,
    reservationGiB: 4,
    phase: "pending",
    outcome: null,
    detail: null,
    ownerId: "owner-a",
    incarnation: "inc-a",
    fenceToken: 1,
    version: 1,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

function requireOkRecord(result: BeginOperationResult): OperationRecord {
  if (!result.ok) {
    throw new Error(`expected ok beginOperation result, got ${result.reason}`);
  }
  return result.record;
}

describe("fence ownership", () => {
  test("S1 fence tokens increase monotonically and survive reopen", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    try {
      expect(store.currentFence()).toBeNull();
      expect(store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a1" })).toEqual({
        ownerId: "owner-a",
        incarnation: "inc-a1",
        fenceToken: 1,
      });
      expect(store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a2" })).toEqual({
        ownerId: "owner-a",
        incarnation: "inc-a2",
        fenceToken: 2,
      });
      expect(store.currentFence()).toEqual({
        ownerId: "owner-a",
        incarnation: "inc-a2",
        fenceToken: 2,
      });
    } finally {
      store.close();
    }

    const reopened = openStore(mod!);
    try {
      expect(reopened.currentFence()).toEqual({
        ownerId: "owner-a",
        incarnation: "inc-a2",
        fenceToken: 2,
      });
      expect(reopened.claimOwnership({ ownerId: "owner-b", incarnation: "inc-b1" })).toEqual({
        ownerId: "owner-b",
        incarnation: "inc-b1",
        fenceToken: 3,
      });
    } finally {
      reopened.close();
    }
  });

  test("S2 a stale fence is rejected across two handles on one file", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const storeA = openStore(mod!);
    const storeB = openStore(mod!);
    try {
      const fenceA = storeA.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a" });
      const fenceB = storeB.claimOwnership({ ownerId: "owner-b", incarnation: "inc-b" });
      expect(fenceA.fenceToken).toBe(1);
      expect(fenceB.fenceToken).toBe(2);

      const staleBegin = storeA.beginOperation(
        beginInput({ fenceToken: fenceA.fenceToken, operationId: "op-1" }),
      );
      expect(staleBegin).toEqual({ ok: false, reason: "stale-fence" });
      expect(storeB.getOperation("op-1")).toBeNull();

      const unissued = storeB.beginOperation(beginInput({ fenceToken: 99, operationId: "op-2" }));
      expect(unissued).toEqual({ ok: false, reason: "stale-fence" });

      const currentBegin = storeB.beginOperation(
        beginInput({ fenceToken: fenceB.fenceToken, operationId: "op-ok" }),
      );
      expect(currentBegin).toMatchObject({ ok: true, created: true });
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});

describe("beginOperation", () => {
  test("S3 beginOperation is idempotent on identical input and conflicts on divergence", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    try {
      const fence = store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a" });
      const input = beginInput({ fenceToken: fence.fenceToken, operationId: "op-1", nowMs: 2_000 });
      const first = store.beginOperation(input);
      expect(first).toMatchObject({ ok: true, created: true });
      const firstRecord = requireOkRecord(first);
      expect(firstRecord).toEqual(expectedRecord({ createdAtMs: 2_000, updatedAtMs: 2_000 }));

      const second = store.beginOperation(input);
      expect(second).toEqual({ ok: true, created: false, record: firstRecord });
      expect(requireOkRecord(second).version).toBe(1);

      const diverged: BeginOperationInput[] = [
        { ...input, model: "model-b" },
        { ...input, targetState: "draining" },
        { ...input, desiredRevision: 2 },
        { ...input, reservationGiB: 8 },
      ];
      for (const conflictInput of diverged) {
        expect(store.beginOperation(conflictInput)).toEqual({
          ok: false,
          reason: "duplicate-conflict",
        });
      }
      expect(store.getOperation("op-1")).toEqual(firstRecord);
    } finally {
      store.close();
    }
  });

  test("S4 a second nonterminal op for the same model gets reservation-conflict", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    try {
      const fenceA = store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a" });
      const first = store.beginOperation(
        beginInput({ fenceToken: fenceA.fenceToken, operationId: "op-1", model: "model-a" }),
      );
      expect(first).toMatchObject({ ok: true, created: true });
      const otherModel = store.beginOperation(
        beginInput({ fenceToken: fenceA.fenceToken, operationId: "op-m2", model: "model-b" }),
      );
      expect(otherModel).toMatchObject({ ok: true, created: true });

      const sameModel = store.beginOperation(
        beginInput({ fenceToken: fenceA.fenceToken, operationId: "op-2", model: "model-a" }),
      );
      expect(sameModel).toEqual({ ok: false, reason: "reservation-conflict" });

      const fenceB = store.claimOwnership({ ownerId: "owner-b", incarnation: "inc-b" });
      const crossOwner = store.beginOperation(
        beginInput({ fenceToken: fenceB.fenceToken, operationId: "op-3", model: "model-a" }),
      );
      expect(crossOwner).toEqual({ ok: false, reason: "reservation-conflict" });

      const finish = store.finishOperation({
        fenceToken: fenceB.fenceToken,
        operationId: "op-1",
        expectedVersion: 1,
        outcome: "succeeded",
        nowMs: 3_000,
      });
      expect(finish.ok).toBe(true);

      const afterFinish = store.beginOperation(
        beginInput({ fenceToken: fenceB.fenceToken, operationId: "op-4", model: "model-a" }),
      );
      expect(afterFinish).toMatchObject({ ok: true, created: true });
    } finally {
      store.close();
    }
  });

  test("S9 invalid inputs are rejected without writing rows", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    try {
      const fence = store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a" });
      const valid = beginInput({ fenceToken: fence.fenceToken, operationId: "op-1" });
      const invalid: BeginOperationInput[] = [
        { ...valid, operationId: "" },
        { ...valid, model: "" },
        { ...valid, targetState: "" },
        { ...valid, reservationGiB: Number.NaN },
        { ...valid, reservationGiB: Number.POSITIVE_INFINITY },
        { ...valid, reservationGiB: -1 },
        { ...valid, desiredRevision: 1.5 },
        { ...valid, desiredRevision: -1 },
        { ...valid, fenceToken: 0 },
        { ...valid, fenceToken: -2 },
        { ...valid, fenceToken: 1.5 },
        { ...valid, fenceToken: Number.NaN },
        { ...valid, fenceToken: Number.POSITIVE_INFINITY },
      ];
      for (const input of invalid) {
        expect(store.beginOperation(input)).toEqual({ ok: false, reason: "invalid-input" });
        expect(store.listNonterminal()).toEqual([]);
      }

      const zeroReservation = store.beginOperation({
        ...valid,
        operationId: "op-zero",
        reservationGiB: 0,
      });
      expect(zeroReservation).toMatchObject({ ok: true, created: true });

      expect(store.currentFence()).toEqual({
        ownerId: "owner-a",
        incarnation: "inc-a",
        fenceToken: fence.fenceToken,
      });
      expect(() => store.claimOwnership({ ownerId: "", incarnation: "inc-x" })).toThrow();
      expect(() => store.claimOwnership({ ownerId: "owner-x", incarnation: "" })).toThrow();
      expect(store.currentFence()).toEqual({
        ownerId: "owner-a",
        incarnation: "inc-a",
        fenceToken: fence.fenceToken,
      });
    } finally {
      store.close();
    }
  });
});

describe("commitReservation and finishOperation", () => {
  test("S5 commitReservation is compare-and-set on expectedVersion", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    try {
      const fenceA = store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a" });
      const begun = store.beginOperation(
        beginInput({ fenceToken: fenceA.fenceToken, operationId: "op-1" }),
      );
      const before = requireOkRecord(begun);
      expect(before.version).toBe(1);

      const fenceB = store.claimOwnership({ ownerId: "owner-b", incarnation: "inc-b" });
      const conflict = store.commitReservation({
        fenceToken: fenceB.fenceToken,
        operationId: "op-1",
        expectedVersion: 99,
        nowMs: 2_000,
      });
      expect(conflict).toEqual({ ok: false, reason: "version-conflict" });
      expect(store.getOperation("op-1")).toEqual(before);

      const committed = store.commitReservation({
        fenceToken: fenceB.fenceToken,
        operationId: "op-1",
        expectedVersion: 1,
        nowMs: 2_000,
      });
      expect(committed.ok).toBe(true);
      expect(store.getOperation("op-1")).toEqual(
        expectedRecord({
          phase: "committed",
          ownerId: "owner-b",
          incarnation: "inc-b",
          fenceToken: fenceB.fenceToken,
          version: 2,
          updatedAtMs: 2_000,
        }),
      );

      const missing = store.commitReservation({
        fenceToken: fenceB.fenceToken,
        operationId: "op-missing",
        expectedVersion: 1,
        nowMs: 2_500,
      });
      expect(missing).toEqual({ ok: false, reason: "not-found" });
    } finally {
      store.close();
    }
  });

  test("S6 terminal and committed ops reject further mutation", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    try {
      const fence = store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a" });
      store.beginOperation(beginInput({ fenceToken: fence.fenceToken, operationId: "op-1" }));
      store.commitReservation({
        fenceToken: fence.fenceToken,
        operationId: "op-1",
        expectedVersion: 1,
        nowMs: 1_100,
      });
      const finished = store.finishOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-1",
        expectedVersion: 2,
        outcome: "succeeded",
        nowMs: 1_200,
      });
      expect(finished.ok).toBe(true);
      expect(store.getOperation("op-1")).toEqual(
        expectedRecord({
          phase: "terminal",
          outcome: "succeeded",
          version: 3,
          updatedAtMs: 1_200,
        }),
      );

      const recommit = store.commitReservation({
        fenceToken: fence.fenceToken,
        operationId: "op-1",
        expectedVersion: 3,
        nowMs: 1_300,
      });
      expect(recommit).toEqual({ ok: false, reason: "illegal-phase" });
      const refinish = store.finishOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-1",
        expectedVersion: 3,
        outcome: "failed",
        nowMs: 1_300,
      });
      expect(refinish).toEqual({ ok: false, reason: "illegal-phase" });

      store.beginOperation(
        beginInput({
          fenceToken: fence.fenceToken,
          operationId: "op-2",
          model: "model-b",
          nowMs: 1_400,
        }),
      );
      store.commitReservation({
        fenceToken: fence.fenceToken,
        operationId: "op-2",
        expectedVersion: 1,
        nowMs: 1_500,
      });
      const recommitCommitted = store.commitReservation({
        fenceToken: fence.fenceToken,
        operationId: "op-2",
        expectedVersion: 2,
        nowMs: 1_600,
      });
      expect(recommitCommitted).toEqual({ ok: false, reason: "illegal-phase" });
    } finally {
      store.close();
    }
  });
});

describe("reopen persistence and schema", () => {
  test("S7 nonterminal ops survive reopen and a new owner can finish them", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    let pendingBefore: OperationRecord | null = null;
    let committedBefore: OperationRecord | null = null;
    try {
      store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a" });
      const pending = store.beginOperation(
        beginInput({ fenceToken: 1, operationId: "op-p", model: "model-a", nowMs: 1_000 }),
      );
      const committedOp = store.beginOperation(
        beginInput({ fenceToken: 1, operationId: "op-c", model: "model-b", nowMs: 2_000 }),
      );
      expect(pending).toMatchObject({ ok: true, created: true });
      expect(committedOp).toMatchObject({ ok: true, created: true });
      store.commitReservation({
        fenceToken: 1,
        operationId: "op-c",
        expectedVersion: 1,
        nowMs: 2_100,
      });
      pendingBefore = store.getOperation("op-p");
      committedBefore = store.getOperation("op-c");
      expect(pendingBefore).not.toBeNull();
      expect(committedBefore).not.toBeNull();
    } finally {
      store.close();
    }

    const reopened = openStore(mod!);
    try {
      expect(reopened.listNonterminal()).toEqual([pendingBefore!, committedBefore!]);
      const fenceB = reopened.claimOwnership({ ownerId: "owner-b", incarnation: "inc-b" });
      const staleFinish = reopened.finishOperation({
        fenceToken: 1,
        operationId: "op-p",
        expectedVersion: 1,
        outcome: "succeeded",
        nowMs: 3_000,
      });
      expect(staleFinish).toEqual({ ok: false, reason: "stale-fence" });
      const finished = reopened.finishOperation({
        fenceToken: fenceB.fenceToken,
        operationId: "op-p",
        expectedVersion: 1,
        outcome: "unknown",
        detail: "interrupted",
        nowMs: 3_000,
      });
      expect(finished.ok).toBe(true);
    } finally {
      reopened.close();
    }

    const third = openStore(mod!);
    try {
      expect(third.getOperation("op-p")).toEqual(
        expectedRecord({
          operationId: "op-p",
          phase: "terminal",
          outcome: "unknown",
          detail: "interrupted",
          ownerId: "owner-b",
          incarnation: "inc-b",
          fenceToken: 2,
          version: 2,
          updatedAtMs: 3_000,
        }),
      );
      expect(third.listNonterminal()).toEqual([committedBefore!]);
    } finally {
      third.close();
    }
  });

  test("S8 a newer schema_version fails closed on open", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    store.close();
    const raw = new Database(dbPath);
    try {
      raw.run("UPDATE schema_version SET version = 999");
    } finally {
      raw.close();
    }
    expect(() => {
      const leaked = openStore(mod!);
      leaked.close();
    }).toThrow(/schema/i);
  });

  test("S10 ambiguous phase/outcome rows are rejected by the schema", async () => {
    const mod = await load();
    expect(typeof mod?.openResidencyOperationStore).toBe("function");
    const store = openStore(mod!);
    let record: OperationRecord | null = null;
    try {
      store.claimOwnership({ ownerId: "owner-a", incarnation: "inc-a" });
      const begun = store.beginOperation(
        beginInput({ fenceToken: 1, operationId: "op-1", nowMs: 1_000 }),
      );
      record = requireOkRecord(begun);
    } finally {
      store.close();
    }

    const raw = new Database(dbPath);
    try {
      expect(() => raw.run("UPDATE operations SET phase='terminal', outcome=NULL")).toThrow(
        /constraint/i,
      );
      expect(() => raw.run("UPDATE operations SET outcome='succeeded'")).toThrow(/constraint/i);
    } finally {
      raw.close();
    }

    const reopened = openStore(mod!);
    try {
      expect(reopened.getOperation("op-1")).toEqual(record);
    } finally {
      reopened.close();
    }
  });
});
