/**
 * Part of #517: lifecycle-row boot recovery.
 *
 * RED tests for the lifecycle half of `runProfileSwitchBootRecovery`
 * (src/residency/boot-recovery.ts): once the stale `profile-switch:<node>`
 * operation rows are terminalized under the boot fence, the same claimed
 * pass must walk every residency_states row stuck in an interrupted
 * transient state (loading / warming / draining / unloading) to 'failed' —
 * releasing the exclusive-group occupancy a crashed switch left behind —
 * and log one counts-only `[residency] lifecycle boot recovery` line. A
 * per-row write failure or refusal is contained and counted without
 * stopping the sweep. At base the sweep does not exist, so every case
 * fails BY ASSERTION on the untouched rows — never by an import, type or
 * module-resolution error. All state lives in mkdtemp dirs; no engines,
 * no live inference.
 */
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
  runProfileSwitchBootRecovery,
} from "../../src/residency/boot-recovery.js";
import {
  openResidencyOperationStore,
  type ResidencyStateRecord,
  type TransitionResidencyStateResult,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const NOW = 10 * PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS;
const EXCLUSIVE_GROUP = "z13-large-gpu";

// The transient states a crashed switch can die inside; 'ready',
// 'downloaded', 'failed' and 'unavailable' are stable and must be left
// alone. listResidencyStates visits rows ORDER BY model ASC, so the sweep
// order is glm, qwen-prod, w-downloaded, w-draining, w-failed, w-ready,
// w-unloading, w-warming.
const INTERRUPTED_MODELS = ["qwen-prod", "w-warming", "w-draining", "w-unloading"] as const;
const UNTOUCHED_MODELS = ["w-ready", "w-downloaded", "w-failed", "glm"] as const;

type Store = ReturnType<typeof openResidencyOperationStore>;

let dir = "";
let path = "";
const trackedStores: { close: () => void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-boot-lifecycle-"));
  path = join(dir, "operations.sqlite");
});

afterEach(() => {
  for (const store of trackedStores.splice(0)) {
    store.close();
  }
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function withStore<T>(fn: (store: Store) => T): T {
  const store = openResidencyOperationStore({ path });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// The crashed switch's residue: one stale `profile-switch:n1` operation row
// plus a residency_states row parked in every lifecycle position a switch
// can die in. `states` is the hop sequence from the implicit 'unavailable'
// start — the first hop creates the row at 'downloaded'. qwen-prod joins
// the exclusive group on its loading hop, the way the executor's
// groupOnLoading does; every other row stays groupless.
const SEED_ROWS: readonly {
  model: string;
  states: readonly ResidencyState[];
  group?: string;
}[] = [
  { model: "qwen-prod", states: ["downloaded", "loading"], group: EXCLUSIVE_GROUP },
  { model: "w-warming", states: ["downloaded", "loading", "warming"] },
  { model: "w-draining", states: ["downloaded", "loading", "warming", "ready", "draining"] },
  { model: "w-unloading", states: ["downloaded", "loading", "unloading"] },
  { model: "w-ready", states: ["downloaded", "loading", "warming", "ready"] },
  { model: "w-downloaded", states: ["downloaded"] },
  { model: "w-failed", states: ["downloaded", "loading", "failed"] },
  { model: "glm", states: ["downloaded"] },
];

// Leaves the same pending `profile-switch:n1` row a crashed switch would
// have begun, then parks the lifecycle rows under the same agent/i1 fence.
// Returns the final seeded record per model.
function seedCrashedSwitch(opts: { opNowMs?: number } = {}): Map<string, ResidencyStateRecord> {
  const store = openResidencyOperationStore({ path });
  try {
    const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i1" });
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId: "op-crash",
      model: "profile-switch:n1",
      targetState: "profile:interactive",
      desiredRevision: 1,
      reservationGiB: 0,
      nowMs: opts.opNowMs ?? 1,
    });
    if (!begun.ok) {
      throw new Error(`seed beginOperation(op-crash) refused: ${begun.reason}`);
    }
    const seeded = new Map<string, ResidencyStateRecord>();
    for (const spec of SEED_ROWS) {
      seeded.set(spec.model, walkSeedRow(store, fence.fenceToken, spec));
    }
    return seeded;
  } finally {
    store.close();
  }
}

// Walks one seed row through its hop sequence and returns the final record.
function walkSeedRow(
  store: Store,
  fenceToken: number,
  spec: (typeof SEED_ROWS)[number],
): ResidencyStateRecord {
  let expectedVersion = 0;
  let record: ResidencyStateRecord | null = null;
  for (const to of spec.states) {
    const result = store.transitionResidencyState({
      fenceToken,
      model: spec.model,
      to,
      expectedVersion,
      nowMs: 1,
      ...(to === "loading" && spec.group !== undefined ? { group: spec.group } : {}),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`seed ${spec.model} -> ${to} refused: ${result.reason}`);
    }
    record = result.record;
    expectedVersion = result.record.version;
  }
  if (record === null) {
    throw new Error(`seed ${spec.model} walked zero hops`);
  }
  return record;
}

const PROFILE_SWITCH_LINE_CLEAN =
  '[residency] profile-switch boot recovery {"recovered":1,"recordFailures":0,"skipped":0,"unrecognized":0,"possiblyLive":0}\n';

function readRows(): Map<string, ResidencyStateRecord | null> {
  return withStore((store) => {
    const rows = new Map<string, ResidencyStateRecord | null>();
    for (const spec of SEED_ROWS) {
      rows.set(spec.model, store.getResidencyState(spec.model));
    }
    return rows;
  });
}

describe("runProfileSwitchBootRecovery lifecycle-row sweep (Part of #517)", () => {
  // kills: the sweep call removed from scanWithStore; any one of
  // loading/warming/draining/unloading dropped from the interrupted set;
  // 'ready' added to it; the sweep writing under the stale seed fence
  // instead of claim.fence.
  test("interrupted transient rows are failed under the boot fence", () => {
    const seeded = seedCrashedSwitch();
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery({
      path,
      incarnation: "i2",
      nowMs: () => NOW,
      write: (line) => {
        writes.push(line);
      },
    });

    expect(summary.status).toBe("recovered");

    const rows = readRows();
    for (const model of INTERRUPTED_MODELS) {
      expect(rows.get(model)).toMatchObject({
        state: "failed",
        version: seeded.get(model)!.version + 1,
        updatedAtMs: NOW,
        ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
        incarnation: "i2",
      });
    }
    expect(rows.get("qwen-prod")).toMatchObject({ group: EXCLUSIVE_GROUP });
    for (const model of UNTOUCHED_MODELS) {
      expect(rows.get(model)).toEqual(seeded.get(model));
    }
  });

  // kills: the sweep removed, or 'loading' missing from the interrupted
  // set — qwen-prod would keep holding z13-large-gpu in 'loading' and the
  // glm loading hop would refuse ExclusiveGroupOccupied.
  test("the exclusive group is released after boot recovery", () => {
    seedCrashedSwitch();

    const summary = runProfileSwitchBootRecovery({
      path,
      incarnation: "i2",
      nowMs: () => NOW,
      write: () => undefined,
    });
    expect(summary.status).toBe("recovered");

    const result = withStore((store) => {
      const fence = store.claimOwnership({ ownerId: "test", incarnation: "t1" });
      return store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model: "glm",
        group: EXCLUSIVE_GROUP,
        to: "loading",
        expectedVersion: store.getResidencyState("glm")?.version ?? 0,
        nowMs: NOW,
      });
    });

    expect(result).toMatchObject({ ok: true, record: { state: "loading" } });
  });

  // kills: the lifecycle log line missing, or model or group names in it.
  test("the lifecycle log line carries counts only", () => {
    seedCrashedSwitch();
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery({
      path,
      incarnation: "i2",
      nowMs: () => NOW,
      write: (line) => {
        writes.push(line);
      },
    });

    expect(summary.status).toBe("recovered");
    expect(writes).toEqual([
      '[residency] profile-switch boot recovery {"recovered":1,"recordFailures":0,"skipped":0,"unrecognized":0,"possiblyLive":0}\n',
      '[residency] lifecycle boot recovery {"failed":4,"recordFailures":0}\n',
    ]);
    const all = writes.join("");
    for (const name of ["qwen-prod", "w-warming", "glm", "z13"]) {
      expect(all).not.toContain(name);
    }
  });

  // kills: the sweep running on the deferred or unclaimed path (the first
  // half), and the sweep missing (the second half).
  test("a deferred pass leaves the rows alone and a later stale pass recovers them", () => {
    const seeded = seedCrashedSwitch({ opNowMs: NOW - 1000 });
    const writes: string[] = [];

    const first = runProfileSwitchBootRecovery({
      path,
      incarnation: "i2",
      nowMs: () => NOW,
      write: (line) => {
        writes.push(line);
      },
    });

    expect(first.status).toBe("deferred");
    const before = readRows();
    for (const [model, expected] of seeded) {
      expect(before.get(model)).toEqual(expected);
    }
    expect(writes.join("")).not.toContain("lifecycle boot recovery");

    const second = runProfileSwitchBootRecovery({
      path,
      incarnation: "i3",
      nowMs: () => NOW + PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS + 1,
      write: (line) => {
        writes.push(line);
      },
    });

    expect(second.status).toBe("recovered");
    expect(readRows().get("qwen-prod")).toMatchObject({ state: "failed", incarnation: "i3" });
  });

  // kills: no per-row try/catch (a loop-level catch stops at w-draining and
  // emits {"failed":1,"recordFailures":1} with w-unloading left
  // 'unloading'; an uncaught throw fails the pass or emits no line); a
  // refusal counted as failed; a refusal that aborts the loop.
  test("per-row write failures are contained and counted, and the loop continues past a throw", () => {
    const seeded = seedCrashedSwitch();
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery({
      path,
      incarnation: "i2",
      nowMs: () => NOW,
      write: (line) => {
        writes.push(line);
      },
      openStore: (storePath) => {
        const real = openResidencyOperationStore({ path: storePath });
        trackedStores.push(real);
        const realTransition = real.transitionResidencyState;
        real.transitionResidencyState = (input): TransitionResidencyStateResult => {
          if (input.model === "w-draining") {
            throw new Error("SQLITE_BUSY");
          }
          if (input.model === "w-warming") {
            return { ok: false, reason: "version-conflict" };
          }
          return realTransition(input);
        };
        return real;
      },
    });

    expect(summary).toMatchObject({ status: "recovered", recovered: 1, recordFailures: 0 });
    // kills: lifecycle record failures folded into the profile-switch line.
    expect(writes[0]).toBe(PROFILE_SWITCH_LINE_CLEAN);
    expect(writes[1]).toBe('[residency] lifecycle boot recovery {"failed":2,"recordFailures":2}\n');

    const rows = readRows();
    expect(rows.get("qwen-prod")).toMatchObject({ state: "failed" });
    // listResidencyStates is ORDER BY model ASC: glm, qwen-prod,
    // w-downloaded, w-draining, w-failed, w-ready, w-unloading, w-warming.
    // w-unloading sorts after the throwing w-draining, so its 'failed' row
    // proves the sweep continued past the per-row throw.
    expect(rows.get("w-unloading")).toMatchObject({ state: "failed" });
    expect(rows.get("w-draining")).toEqual(seeded.get("w-draining"));
    expect(rows.get("w-warming")).toEqual(seeded.get("w-warming"));
  });
  // kills: the lifecycle line gated on failed > 0 (every transition refusing
  // or throwing would log nothing), and lifecycle record failures folded into
  // the profile-switch line's recordFailures.
  test("a sweep where every row refuses or throws still logs the lifecycle line", () => {
    const seeded = seedCrashedSwitch();
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery({
      path,
      incarnation: "i2",
      nowMs: () => NOW,
      write: (line) => {
        writes.push(line);
      },
      openStore: (storePath) => {
        const real = openResidencyOperationStore({ path: storePath });
        trackedStores.push(real);
        real.transitionResidencyState = (input): TransitionResidencyStateResult => {
          if (input.model === "w-draining" || input.model === "qwen-prod") {
            throw new Error("SQLITE_BUSY");
          }
          return { ok: false, reason: "version-conflict" };
        };
        return real;
      },
    });

    expect(summary).toMatchObject({ status: "recovered", recovered: 1, recordFailures: 0 });
    expect(writes).toEqual([
      PROFILE_SWITCH_LINE_CLEAN,
      '[residency] lifecycle boot recovery {"failed":0,"recordFailures":4}\n',
    ]);
    const rows = readRows();
    for (const [model, expected] of seeded) {
      expect(rows.get(model)).toEqual(expected);
    }
  });

  // kills: a row-listing throw swallowed silently (no lifecycle line), or
  // escaping and failing the already-recovered profile-switch pass.
  test("a failure to list the rows is contained and logged as one record failure", () => {
    seedCrashedSwitch();
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery({
      path,
      incarnation: "i2",
      nowMs: () => NOW,
      write: (line) => {
        writes.push(line);
      },
      openStore: (storePath) => {
        const real = openResidencyOperationStore({ path: storePath });
        trackedStores.push(real);
        real.listResidencyStates = (): ResidencyStateRecord[] => {
          throw new Error("SQLITE_BUSY");
        };
        return real;
      },
    });

    expect(summary).toMatchObject({ status: "recovered", recovered: 1, recordFailures: 0 });
    expect(writes).toEqual([
      PROFILE_SWITCH_LINE_CLEAN,
      '[residency] lifecycle boot recovery {"failed":0,"recordFailures":1}\n',
    ]);
    expect(readRows().get("qwen-prod")).toMatchObject({ state: "loading" });
  });
});
