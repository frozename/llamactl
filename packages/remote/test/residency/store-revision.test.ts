/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- RED contract tests for #276: desiredRevision is not on the transition input or the residency record, and "stale-revision" is not in the store's failure union, at the pinned base — so those methods are reached through the RevStore shim and every case fails on a reason assertion, never by an import or type error. */
/**
 * #276 (DF-03) — RED tests for stale desiredRevision rejection in the fenced
 * residency store. The store keeps one monotonic desired-revision watermark
 * shared by the operations and residency_states tables: beginOperation and
 * the #662 transitionResidencyState writer must refuse any desiredRevision
 * below the stored maximum with { ok: false, reason: "stale-revision" }.
 * Ordering is pinned too: the fence check runs first, beginOperation then
 * runs the same-operationId replay check before the revision check and the
 * revision check before the reservation check, and the transition writer
 * runs revision before the version CAS and the lifecycle evaluation.
 * desiredRevision does not exist on the transition input or the residency
 * record at the pinned base, so those methods are reached through RevStore.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResidencyOperationStore,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const G = "z13-large-gpu";

type RevStore = Omit<
  ResidencyOperationStore,
  "beginOperation" | "transitionResidencyState" | "getResidencyState" | "listResidencyStates"
> & {
  beginOperation: (input: {
    fenceToken: number;
    operationId: string;
    model: string;
    targetState: string;
    desiredRevision: number;
    reservationGiB: number;
    nowMs: number;
  }) => any;
  transitionResidencyState: (input: {
    fenceToken: number;
    model: string;
    group?: string;
    to: string;
    expectedVersion: number;
    nowMs: number;
    desiredRevision?: number;
  }) => any;
  getResidencyState: (model: string) => any;
  listResidencyStates: () => any[];
};

type BeginInput = Parameters<RevStore["beginOperation"]>[0];

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "residency-revision-"));
  dbPath = join(dir, "residency.sqlite");
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function open(path: string): RevStore {
  return openResidencyOperationStore({ path }) as unknown as RevStore;
}

function beginOp(input: Omit<BeginInput, "targetState" | "reservationGiB">): BeginInput {
  return { targetState: "ready", reservationGiB: 4, ...input };
}

describe("residency desiredRevision fencing (#276)", () => {
  // kills: dropping the revision check in beginOperationTx; computing the
  // stored revision over nonterminal ops only (op-1 is terminal); keying the
  // stored revision per owner or fence
  test("beginOperation refuses a stale desiredRevision across owners and leaves rows unchanged", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-1",
            model: "model-a",
            desiredRevision: 3,
            nowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.finishOperation({
          fenceToken: 1,
          operationId: "op-1",
          expectedVersion: 1,
          outcome: "succeeded",
          nowMs: 2_000,
        }),
      ).toEqual({ ok: true });
      const snapshot = store.getOperation("op-1");

      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-2",
            model: "model-b",
            desiredRevision: 2,
            nowMs: 3_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(store.getOperation("op-2")).toBeNull();
      expect(store.getOperation("op-1")).toEqual(snapshot);
      expect(store.listNonterminal()).toEqual([]);

      expect(store.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 2,
            operationId: "op-3",
            model: "model-c",
            desiredRevision: 2,
            nowMs: 4_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 2,
            operationId: "op-4",
            model: "model-d",
            desiredRevision: 4,
            nowMs: 5_000,
          }),
        ),
      ).toMatchObject({
        ok: true,
        created: true,
        record: { desiredRevision: 4, phase: "pending" },
      });
    } finally {
      store.close();
    }
  });

  // kills: using <= instead of < (refuses the equal rev); running the revision
  // check before the same-operationId replay check
  test("equal desiredRevision stays idempotent; a replay of an older operationId is not refused", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      const op1 = beginOp({
        fenceToken: 1,
        operationId: "op-1",
        model: "model-a",
        desiredRevision: 5,
        nowMs: 1_000,
      });
      expect(store.beginOperation(op1)).toMatchObject({ ok: true, created: true });
      expect(store.getOperation("op-1")).toMatchObject({ version: 1, phase: "pending" });
      expect(store.beginOperation(op1)).toEqual({
        ok: true,
        created: false,
        record: store.getOperation("op-1"),
      });
      expect(
        store.finishOperation({
          fenceToken: 1,
          operationId: "op-1",
          expectedVersion: 1,
          outcome: "succeeded",
          nowMs: 2_000,
        }),
      ).toEqual({ ok: true });

      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-2",
            model: "model-b",
            desiredRevision: 5,
            nowMs: 3_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.finishOperation({
          fenceToken: 1,
          operationId: "op-2",
          expectedVersion: 1,
          outcome: "succeeded",
          nowMs: 4_000,
        }),
      ).toEqual({ ok: true });
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-3",
            model: "model-c",
            desiredRevision: 6,
            nowMs: 5_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.finishOperation({
          fenceToken: 1,
          operationId: "op-3",
          expectedVersion: 1,
          outcome: "succeeded",
          nowMs: 6_000,
        }),
      ).toEqual({ ok: true });

      expect(store.beginOperation(op1)).toEqual({
        ok: true,
        created: false,
        record: store.getOperation("op-1"),
      });
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-4",
            model: "model-d",
            desiredRevision: 5,
            nowMs: 7_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(store.getOperation("op-4")).toBeNull();
    } finally {
      store.close();
    }
  });

  // kills: no revision check in transitionResidencyStateTx; an upsert that
  // nulls desired_revision when the input omits it (no COALESCE); the revision
  // check placed after the version CAS; after the lifecycle evaluation; or
  // before the fence check
  test("the #662 transitionResidencyState writer refuses a stale desiredRevision before CAS and lifecycle, and leaves the row unchanged", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      const created = store.transitionResidencyState({
        fenceToken: 1,
        model: "qwen",
        group: G,
        to: "downloaded",
        expectedVersion: 0,
        desiredRevision: 3,
        nowMs: 1_000,
      });
      expect(created).toMatchObject({
        ok: true,
        record: { state: "downloaded", version: 1, desiredRevision: 3 },
      });
      const r1 = created.record as Record<string, unknown>;

      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          group: G,
          to: "loading",
          expectedVersion: 1,
          desiredRevision: 2,
          nowMs: 2_000,
        }),
      ).toEqual({ ok: false, reason: "stale-revision" });
      // stale revision must be refused before the version CAS
      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          group: G,
          to: "loading",
          expectedVersion: 0,
          desiredRevision: 2,
          nowMs: 2_000,
        }),
      ).toEqual({ ok: false, reason: "stale-revision" });
      // stale revision must be refused before the lifecycle evaluation
      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          group: G,
          to: "ready",
          expectedVersion: 1,
          desiredRevision: 2,
          nowMs: 2_000,
        }),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(store.getResidencyState("qwen")).toEqual(r1);

      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          group: G,
          to: "loading",
          expectedVersion: 1,
          desiredRevision: 3,
          nowMs: 2_000,
        }),
      ).toMatchObject({
        ok: true,
        record: { state: "loading", version: 2, desiredRevision: 3 },
      });
      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          group: G,
          to: "warming",
          expectedVersion: 2,
          nowMs: 3_000,
        }),
      ).toMatchObject({
        ok: true,
        record: { state: "warming", version: 3, desiredRevision: 3 },
      });
      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          group: G,
          to: "ready",
          expectedVersion: 3,
          desiredRevision: 2,
          nowMs: 4_000,
        }),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(store.getResidencyState("qwen")).toMatchObject({
        state: "warming",
        version: 3,
        desiredRevision: 3,
      });

      expect(store.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          group: G,
          to: "ready",
          expectedVersion: 3,
          desiredRevision: 2,
          nowMs: 5_000,
        }),
      ).toEqual({ ok: false, reason: "stale-fence" });
      expect(store.getResidencyState("qwen")).toMatchObject({
        state: "warming",
        version: 3,
        desiredRevision: 3,
      });
    } finally {
      store.close();
    }
  });

  // kills: a stored-revision helper that reads only one of the two tables
  test("revision is shared between operations and residency rows", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-1",
            model: "qwen",
            desiredRevision: 7,
            nowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });
      expect(
        store.finishOperation({
          fenceToken: 1,
          operationId: "op-1",
          expectedVersion: 1,
          outcome: "succeeded",
          nowMs: 2_000,
        }),
      ).toEqual({ ok: true });
      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          to: "downloaded",
          expectedVersion: 0,
          desiredRevision: 6,
          nowMs: 3_000,
        }),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(store.getResidencyState("qwen")).toBeNull();
      expect(
        store.transitionResidencyState({
          fenceToken: 1,
          model: "qwen",
          to: "downloaded",
          expectedVersion: 0,
          desiredRevision: 9,
          nowMs: 4_000,
        }),
      ).toMatchObject({
        ok: true,
        record: { state: "downloaded", version: 1, desiredRevision: 9 },
      });
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-2",
            model: "qwen",
            desiredRevision: 8,
            nowMs: 5_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-revision" });
    } finally {
      store.close();
    }
  });

  // kills: a missing additive ALTER; exposing desiredRevision:null on records;
  // bumping SCHEMA_VERSION
  test("a #662-era residency_states table without desired_revision is migrated in place", () => {
    const first = open(dbPath);
    try {
      expect(first.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
    } finally {
      first.close();
    }

    const raw = new Database(dbPath);
    try {
      raw.run("DROP TABLE residency_states");
      raw.run(`
        CREATE TABLE residency_states (
          model TEXT PRIMARY KEY,
          residency_group TEXT,
          state TEXT NOT NULL CHECK (state IN ('unavailable','downloaded','loading','warming','ready','draining','unloading','failed')),
          owner_id TEXT NOT NULL,
          incarnation TEXT NOT NULL,
          fence_token INTEGER NOT NULL,
          version INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        )
      `);
      raw.run(
        "INSERT INTO residency_states (model, residency_group, state, owner_id, incarnation, fence_token, version, updated_at_ms) VALUES (?, ?, 'downloaded', 'o1', 'i1', 1, 1, 500)",
        ["glm", G],
      );
    } finally {
      raw.close();
    }

    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      expect(store.getResidencyState("glm")).toEqual({
        model: "glm",
        group: G,
        state: "downloaded",
        ownerId: "o1",
        incarnation: "i1",
        fenceToken: 1,
        version: 1,
        updatedAtMs: 500,
      });
      expect(
        store.transitionResidencyState({
          fenceToken: 2,
          model: "glm",
          group: G,
          to: "loading",
          expectedVersion: 1,
          desiredRevision: 1,
          nowMs: 1_000,
        }),
      ).toMatchObject({
        ok: true,
        record: { state: "loading", version: 2, desiredRevision: 1 },
      });
      expect(
        store.transitionResidencyState({
          fenceToken: 2,
          model: "glm",
          group: G,
          to: "warming",
          expectedVersion: 2,
          desiredRevision: 0,
          nowMs: 2_000,
        }),
      ).toEqual({ ok: false, reason: "stale-revision" });
    } finally {
      store.close();
    }

    const check = new Database(dbPath, { readonly: true });
    try {
      const row = check.query("SELECT version FROM schema_version").get() as {
        version: number;
      } | null;
      expect(row?.version).toBe(1);
    } finally {
      check.close();
    }
  });

  // kills: missing validation in validateTransitionInput
  test("a malformed desiredRevision on the writer is invalid-input", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      for (const desiredRevision of [-1, 1.5, Number.NaN]) {
        expect(
          store.transitionResidencyState({
            fenceToken: 1,
            model: "glm",
            group: G,
            to: "downloaded",
            expectedVersion: 0,
            desiredRevision,
            nowMs: 1_000,
          }),
        ).toEqual({ ok: false, reason: "invalid-input" });
      }
      expect(store.listResidencyStates()).toEqual([]);
    } finally {
      store.close();
    }
  });

  // kills: the reservation-conflict check placed before the revision check;
  // the revision check placed before the fence check; equal revision refused
  test("beginOperation checks fence, then revision, then reservation", () => {
    const store = open(dbPath);
    try {
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-1",
            model: "qwen",
            desiredRevision: 3,
            nowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: true, created: true });

      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-2",
            model: "qwen",
            desiredRevision: 2,
            nowMs: 2_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(store.getOperation("op-2")).toBeNull();
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-3",
            model: "qwen",
            desiredRevision: 3,
            nowMs: 3_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "reservation-conflict" });

      expect(store.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 1,
            operationId: "op-4",
            model: "qwen",
            desiredRevision: 2,
            nowMs: 4_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-fence" });
      expect(
        store.beginOperation(
          beginOp({
            fenceToken: 2,
            operationId: "op-5",
            model: "qwen",
            desiredRevision: 2,
            nowMs: 5_000,
          }),
        ),
      ).toEqual({ ok: false, reason: "stale-revision" });
      expect(store.getOperation("op-1")).toMatchObject({
        phase: "pending",
        desiredRevision: 3,
        version: 1,
      });
    } finally {
      store.close();
    }
  });
});
