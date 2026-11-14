/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- RED contract tests for #517: the lifecycle persistence methods do not exist on the residency store at the pinned base, so every case reaches them through the optional LifecycleStore shim and fails on its typeof guard — never by an import or type error. */
/**
 * #517 (DF-03 amendment) — RED tests for the 8-state residency lifecycle
 * persisted inside the fenced operation store. transitionResidencyState
 * runs the edge + exclusive-group decision inside the same immediate
 * transaction as the fence and CAS checks; getResidencyState and
 * listResidencyStates read the rows back. None of the three exist on
 * openResidencyOperationStore's return at base. Group declarations
 * default to core's RESIDENCY_GROUPS; only the cases that say so pass a
 * `groups` override.
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

type LifecycleStore = ResidencyOperationStore & {
  transitionResidencyState?: (i: {
    fenceToken: number;
    model: string;
    group?: string;
    to: string;
    expectedVersion: number;
    nowMs: number;
    groups?: { name: string; exclusive: boolean }[];
  }) => any;
  getResidencyState?: (model: string) => any;
  listResidencyStates?: () => any[];
};

type TransitionInput = Parameters<NonNullable<LifecycleStore["transitionResidencyState"]>>[0];

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "residency-lifecycle-"));
  dbPath = join(dir, "residency.sqlite");
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function open(path: string): LifecycleStore {
  return openResidencyOperationStore({ path }) as LifecycleStore;
}

function walk(
  store: LifecycleStore,
  fenceToken: number,
  model: string,
  group: string | undefined,
  states: string[],
  startVersion = 0,
): any {
  let last: any = null;
  for (const [index, to] of states.entries()) {
    const result = store.transitionResidencyState!({
      fenceToken,
      model,
      ...(group === undefined ? {} : { group }),
      to,
      expectedVersion: startVersion + index,
      nowMs: 1000 + index,
    });
    expect(result.ok).toBe(true);
    expect(result.record.version).toBe(startVersion + index + 1);
    last = result.record;
  }
  return last;
}

describe("residency lifecycle state store (#517)", () => {
  // kills: not persisting the row, or not bumping the version
  test("L1 transitionResidencyState persists the row and getResidencyState reads it", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      expect(typeof store.getResidencyState).toBe("function");
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      const created = store.transitionResidencyState!({
        fenceToken: 1,
        model: "qwen-prod",
        group: G,
        to: "downloaded",
        expectedVersion: 0,
        nowMs: 1000,
      });
      const record = {
        model: "qwen-prod",
        group: G,
        state: "downloaded",
        version: 1,
        fenceToken: 1,
        ownerId: "o1",
        incarnation: "i1",
        updatedAtMs: 1000,
      };
      expect(created).toEqual({ ok: true, record });
      expect(store.getResidencyState!("qwen-prod")).toEqual(record);
      expect(store.getResidencyState!("missing")).toBeNull();
    } finally {
      store.close();
    }
  });

  // kills: skipping the edge check in evaluateResidencyTransition
  test("L2 an illegal edge is refused and the row is unchanged", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      expect(typeof store.getResidencyState).toBe("function");
      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(store, 1, "qwen-prod", G, ["downloaded"]);
      const refused = store.transitionResidencyState!({
        fenceToken: 1,
        model: "qwen-prod",
        group: G,
        to: "ready",
        expectedVersion: 1,
        nowMs: 2000,
      });
      expect(refused).toMatchObject({
        ok: false,
        reason: "lifecycle-refused",
        decision: { reason: "IllegalTransition", from: "downloaded", to: "ready" },
      });
      expect(store.getResidencyState!("qwen-prod")).toMatchObject({
        state: "downloaded",
        version: 1,
      });
    } finally {
      store.close();
    }
  });

  // kills: building members from the target row only, instead of from all persisted rows
  test("L3 an occupying exclusive-group peer refuses entry until it drains", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(store, 1, "glm", G, ["downloaded", "loading", "warming", "ready"]);
      walk(store, 1, "deepseek", G, ["downloaded"]);
      const refused = store.transitionResidencyState!({
        fenceToken: 1,
        model: "deepseek",
        group: G,
        to: "loading",
        expectedVersion: 1,
        nowMs: 2000,
      });
      expect(refused).toMatchObject({
        ok: false,
        reason: "lifecycle-refused",
        decision: {
          reason: "ExclusiveGroupOccupied",
          group: G,
          peer: { id: "glm", state: "ready" },
        },
      });
      expect(refused.decision.peer).toEqual({ id: "glm", state: "ready" });
      expect(refused.decision.detail).toContain("held by glm in state ready");
      const drained = store.transitionResidencyState!({
        fenceToken: 1,
        model: "glm",
        group: G,
        to: "draining",
        expectedVersion: 4,
        nowMs: 3000,
      });
      expect(drained.ok).toBe(true);
      expect(drained.record.version).toBe(5);
      const admitted = store.transitionResidencyState!({
        fenceToken: 1,
        model: "deepseek",
        group: G,
        to: "loading",
        expectedVersion: 1,
        nowMs: 4000,
      });
      expect(admitted.ok).toBe(true);
      expect(admitted.record.version).toBe(2);
      expect(admitted.record.state).toBe("loading");
    } finally {
      store.close();
    }
  });

  // kills: caching members in memory per handle instead of reading them inside the immediate transaction
  test("L4 a second handle sees occupancy written through the first", () => {
    const storeA = open(dbPath);
    const storeB = open(dbPath);
    try {
      expect(typeof storeA.transitionResidencyState).toBe("function");
      expect(typeof storeB.transitionResidencyState).toBe("function");
      storeA.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(storeA, 1, "glm", G, ["downloaded"]);
      walk(storeA, 1, "mimo", G, ["downloaded"]);
      const loaded = storeB.transitionResidencyState!({
        fenceToken: 1,
        model: "glm",
        group: G,
        to: "loading",
        expectedVersion: 1,
        nowMs: 2000,
      });
      expect(loaded.ok).toBe(true);
      expect(loaded.record.version).toBe(2);
      const refused = storeA.transitionResidencyState!({
        fenceToken: 1,
        model: "mimo",
        group: G,
        to: "loading",
        expectedVersion: 1,
        nowMs: 3000,
      });
      expect(refused).toMatchObject({
        ok: false,
        reason: "lifecycle-refused",
        decision: { reason: "ExclusiveGroupOccupied", peer: { id: "glm", state: "loading" } },
      });
      expect(refused.decision.peer).toEqual({ id: "glm", state: "loading" });
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  // kills: dropping the fence check
  test("L5 a stale fence is rejected before any row is written", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      expect(typeof store.listResidencyStates).toBe("function");
      expect(store.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
      expect(store.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      const stale = store.transitionResidencyState!({
        fenceToken: 1,
        model: "glm",
        group: G,
        to: "downloaded",
        expectedVersion: 0,
        nowMs: 1000,
      });
      expect(stale).toEqual({ ok: false, reason: "stale-fence" });
      expect(store.listResidencyStates!()).toEqual([]);
    } finally {
      store.close();
    }
  });

  // kills: dropping the CAS
  test("L6 expectedVersion guards create and update", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      expect(typeof store.getResidencyState).toBe("function");
      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      const wrongCreate = store.transitionResidencyState!({
        fenceToken: 1,
        model: "glm",
        group: G,
        to: "downloaded",
        expectedVersion: 1,
        nowMs: 1000,
      });
      expect(wrongCreate).toEqual({ ok: false, reason: "version-conflict" });
      expect(store.getResidencyState!("glm")).toBeNull();
      const created = store.transitionResidencyState!({
        fenceToken: 1,
        model: "glm",
        group: G,
        to: "downloaded",
        expectedVersion: 0,
        nowMs: 1000,
      });
      expect(created.ok).toBe(true);
      expect(created.record.version).toBe(1);
      const wrongUpdate = store.transitionResidencyState!({
        fenceToken: 1,
        model: "glm",
        group: G,
        to: "loading",
        expectedVersion: 0,
        nowMs: 2000,
      });
      expect(wrongUpdate).toEqual({ ok: false, reason: "version-conflict" });
      expect(store.getResidencyState!("glm")).toMatchObject({ state: "downloaded", version: 1 });
    } finally {
      store.close();
    }
  });

  // kills: a TEMP table, or a table not created on reopen
  test("L7 residency rows survive close and reopen", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(store, 1, "glm", G, ["downloaded", "loading", "warming"]);
    } finally {
      store.close();
    }

    const reopened = open(dbPath);
    try {
      expect(typeof reopened.transitionResidencyState).toBe("function");
      expect(typeof reopened.listResidencyStates).toBe("function");
      expect(reopened.listResidencyStates!()).toEqual([
        {
          model: "glm",
          group: G,
          state: "warming",
          version: 3,
          fenceToken: 1,
          ownerId: "o1",
          incarnation: "i1",
          updatedAtMs: 1002,
        },
      ]);
      expect(reopened.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      const ready = reopened.transitionResidencyState!({
        fenceToken: 2,
        model: "glm",
        group: G,
        to: "ready",
        expectedVersion: 3,
        nowMs: 5000,
      });
      expect(ready).toEqual({
        ok: true,
        record: {
          model: "glm",
          group: G,
          state: "ready",
          version: 4,
          fenceToken: 2,
          ownerId: "o2",
          incarnation: "i2",
          updatedAtMs: 5000,
        },
      });
    } finally {
      reopened.close();
    }
  });

  // kills: dropping input validation
  test("L8 invalid inputs are rejected without writing rows", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      expect(typeof store.listResidencyStates).toBe("function");
      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      const valid: TransitionInput = {
        fenceToken: 1,
        model: "glm",
        group: G,
        to: "downloaded",
        expectedVersion: 0,
        nowMs: 1000,
      };
      const invalid: TransitionInput[] = [
        { ...valid, to: "bogus" },
        { ...valid, model: "" },
        { ...valid, expectedVersion: -1 },
        { ...valid, expectedVersion: 0.5 },
        { ...valid, fenceToken: 0 },
        { ...valid, group: "" },
      ];
      for (const input of invalid) {
        expect(store.transitionResidencyState!(input)).toEqual({
          ok: false,
          reason: "invalid-input",
        });
      }
      expect(store.listResidencyStates!()).toEqual([]);
    } finally {
      store.close();
    }
  });

  // kills: treating undeclared groups as non-exclusive, or not defaulting groups to RESIDENCY_GROUPS
  test("L9 an undeclared group fails closed until the caller declares it", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(store, 1, "x", "undeclared-group", ["downloaded"]);
      const refused = store.transitionResidencyState!({
        fenceToken: 1,
        model: "x",
        group: "undeclared-group",
        to: "loading",
        expectedVersion: 1,
        nowMs: 2000,
      });
      expect(refused).toMatchObject({
        ok: false,
        reason: "lifecycle-refused",
        decision: { reason: "UnknownGroup", group: "undeclared-group" },
      });
      const admitted = store.transitionResidencyState!({
        fenceToken: 1,
        model: "x",
        group: "undeclared-group",
        to: "loading",
        expectedVersion: 1,
        nowMs: 3000,
        groups: [{ name: "undeclared-group", exclusive: false }],
      });
      expect(admitted.ok).toBe(true);
      expect(admitted.record.version).toBe(2);
    } finally {
      store.close();
    }
  });

  // kills: creating the new table only on a fresh schema
  test("L10 a v1 file missing residency_states is migrated on open", () => {
    const first = open(dbPath);
    try {
      first.claimOwnership({ ownerId: "o1", incarnation: "i1" });
    } finally {
      first.close();
    }

    const rawDrop = new Database(dbPath);
    try {
      rawDrop.run("DROP TABLE IF EXISTS residency_states");
    } finally {
      rawDrop.close();
    }

    const reopened = open(dbPath);
    try {
      expect(typeof reopened.transitionResidencyState).toBe("function");
      expect(reopened.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      const created = reopened.transitionResidencyState!({
        fenceToken: 2,
        model: "glm",
        group: G,
        to: "downloaded",
        expectedVersion: 0,
        nowMs: 1000,
      });
      expect(created.ok).toBe(true);
    } finally {
      reopened.close();
    }

    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw.query("SELECT version FROM schema_version").get() as {
        version: number;
      } | null;
      expect(row?.version).toBe(1);
    } finally {
      raw.close();
    }
  });

  // kills: unsorted listing, or a stored group that is not null
  test("L11 listResidencyStates sorts by model and stores a null group", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      expect(typeof store.listResidencyStates).toBe("function");
      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(store, 1, "zeta", undefined, ["downloaded"]);
      walk(store, 1, "alpha", undefined, ["downloaded"]);
      walk(store, 1, "mid", undefined, ["downloaded"]);
      const rows = store.listResidencyStates!() as { model: string; group: string | null }[];
      expect(rows.map((row) => row.model)).toEqual(["alpha", "mid", "zeta"]);
      for (const row of rows) {
        expect(row.group).toBeNull();
      }
    } finally {
      store.close();
    }
  });

  // pins the documented limit and kills: ignoring the groups override
  test("L12 the groups override is the only exclusivity declaration enforced", () => {
    const store = open(dbPath);
    try {
      expect(typeof store.transitionResidencyState).toBe("function");
      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(store, 1, "glm", G, ["downloaded", "loading"]);
      walk(store, 1, "mimo", G, ["downloaded"]);
      const admitted = store.transitionResidencyState!({
        fenceToken: 1,
        model: "mimo",
        group: G,
        to: "loading",
        expectedVersion: 1,
        nowMs: 2000,
        groups: [{ name: G, exclusive: false }],
      });
      expect(admitted.ok).toBe(true);
      expect(admitted.record.version).toBe(2);
    } finally {
      store.close();
    }
  });
});
