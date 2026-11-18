/**
 * Part of #517: lifecycle rows interrupted outside a switch.
 *
 * RED tests for the orphan half of `runProfileSwitchBootRecovery`
 * (src/residency/boot-recovery.ts): when the store holds NO nonterminal
 * operation row — the residue of a crashed direct start or stop, not a
 * profile switch — boot recovery must still sweep residency_states rows
 * stuck in an interrupted transient state (loading / warming / draining /
 * unloading) to 'failed', but only once the row has made no progress for
 * the staleness window AND its workload is proven down, under its own
 * claim of the apply-profile fence. At base the pass returns 'clean'
 * before ever opening the writable store, so every case fails BY
 * ASSERTION on the untouched rows and missing log lines — never by an
 * import, type or module-resolution error. The not-yet-existing
 * `isProvenDown` option rides through a loosely-typed object literal so
 * the base still type-checks. All state lives in mkdtemp dirs; no
 * engines, no live inference.
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

const MIN_AGE = PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS;
const NOW = 10 * MIN_AGE;
const STALE_AT = NOW - MIN_AGE;
const EXCLUSIVE_GROUP = "z13-large-gpu";
const down = (): boolean => true;

const CLEAN_SUMMARY = {
  status: "clean",
  recovered: 0,
  recordFailures: 0,
  skipped: 0,
  unrecognized: 0,
  possiblyLive: 0,
} as const;

const LIFECYCLE_LINE_1 = '[residency] lifecycle boot recovery {"failed":1,"recordFailures":0}\n';

type Store = ReturnType<typeof openResidencyOperationStore>;
type RecoveryOpts = Parameters<typeof runProfileSwitchBootRecovery>[0];

type SeedSpec = {
  model: string;
  states: readonly ResidencyState[];
  group?: string;
  atMs: number;
};

let dir = "";
let path = "";
const trackedStores: { close: () => void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-boot-orphan-"));
  path = join(dir, "operations.sqlite");
});

afterEach(() => {
  for (const store of trackedStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* the recovery pass may already have closed a wrapped store */
    }
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

// The crashed direct writer's residue: residency_states rows parked at
// their final hop, claimed under agent/i1, with NO operation row — the
// store looks like a direct start or stop whose agent died mid-walk.
// Every hop is stamped atMs; only the last hop's stamp survives as the
// row's updatedAtMs, which is the progress clock the age gate reads.
function seedOrphanRows(specs: readonly SeedSpec[]): Map<string, ResidencyStateRecord> {
  return withStore((store) => {
    const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i1" });
    const seeded = new Map<string, ResidencyStateRecord>();
    for (const spec of specs) {
      seeded.set(spec.model, walkSeedRow(store, fence.fenceToken, spec));
    }
    return seeded;
  });
}

function walkSeedRow(store: Store, fenceToken: number, spec: SeedSpec): ResidencyStateRecord {
  let expectedVersion = 0;
  let record: ResidencyStateRecord | null = null;
  for (const to of spec.states) {
    const result = store.transitionResidencyState({
      fenceToken,
      model: spec.model,
      to,
      expectedVersion,
      nowMs: spec.atMs,
      ...(to === "loading" && spec.group !== undefined ? { group: spec.group } : {}),
    });
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

// Optional fields ride through conditional spreads so an omitted one stays
// absent under exactOptionalPropertyTypes.
function recoveryOpts(input: {
  writes: string[];
  isProvenDown?: (model: string) => boolean;
  openStore?: (storePath: string) => Store;
}): RecoveryOpts {
  return {
    path,
    incarnation: "i2",
    nowMs: (): number => NOW,
    write: (line: string): void => {
      input.writes.push(line);
    },
    ...(input.isProvenDown === undefined ? {} : { isProvenDown: input.isProvenDown }),
    ...(input.openStore === undefined ? {} : { openStore: input.openStore }),
  };
}

function readRows(models: readonly string[]): Map<string, ResidencyStateRecord | null> {
  return withStore((store) => {
    const rows = new Map<string, ResidencyStateRecord | null>();
    for (const model of models) {
      rows.set(model, store.getResidencyState(model));
    }
    return rows;
  });
}

function readState(model: string): ResidencyStateRecord | null {
  return withStore((store) => store.getResidencyState(model));
}

function currentFence(): { ownerId: string; incarnation: string; fenceToken: number } | null {
  return withStore((store) => store.currentFence());
}

const LOADING_SPEC = (model: string, atMs: number): SeedSpec => ({
  model,
  states: ["downloaded", "loading"],
  atMs,
});

describe("lifecycle rows interrupted outside a switch (Part of #517)", () => {
  // kills: deleting the orphan sweep — the base early 'clean' return when
  // no profile-switch row exists leaves every interrupted row parked and
  // the fence under agent/i1.
  test("OL1: stale interrupted rows are swept and the apply-profile fence is claimed", () => {
    const specs: readonly SeedSpec[] = [
      {
        model: "qwen-prod",
        states: ["downloaded", "loading"],
        group: EXCLUSIVE_GROUP,
        atMs: STALE_AT,
      },
      { model: "w-warming", states: ["downloaded", "loading", "warming"], atMs: STALE_AT },
      {
        model: "w-draining",
        states: ["downloaded", "loading", "warming", "ready", "draining"],
        atMs: STALE_AT,
      },
      { model: "w-unloading", states: ["downloaded", "loading", "unloading"], atMs: STALE_AT },
      { model: "w-ready", states: ["downloaded", "loading", "warming", "ready"], atMs: STALE_AT },
      { model: "w-downloaded", states: ["downloaded"], atMs: STALE_AT },
      { model: "w-failed", states: ["downloaded", "loading", "failed"], atMs: STALE_AT },
    ];
    const seeded = seedOrphanRows(specs);
    const interrupted = ["qwen-prod", "w-warming", "w-draining", "w-unloading"] as const;
    const stable = ["w-ready", "w-downloaded", "w-failed"] as const;
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));

    expect(summary).toEqual(CLEAN_SUMMARY);
    const rows = readRows([...interrupted, ...stable]);
    for (const model of interrupted) {
      expect(rows.get(model)).toMatchObject({
        state: "failed",
        version: seeded.get(model)!.version + 1,
        updatedAtMs: NOW,
        ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
        incarnation: "i2",
      });
    }
    for (const model of stable) {
      expect(rows.get(model)).toEqual(seeded.get(model));
    }
    expect(writes).toEqual([
      '[residency] lifecycle boot recovery {"failed":4,"recordFailures":0}\n',
    ]);
    const all = writes.join("");
    for (const name of ["qwen", "z13"]) {
      expect(all).not.toContain(name);
    }
    expect(currentFence()).toMatchObject({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "i2",
    });
  });

  // kills: a sweep that skips occupying states — qwen-prod keeps holding
  // z13-large-gpu in 'loading' and the glm loading hop stays refused.
  test("OL2: the exclusive group is released once the orphan is swept", () => {
    const seeded = seedOrphanRows([
      {
        model: "qwen-prod",
        states: ["downloaded", "loading"],
        group: EXCLUSIVE_GROUP,
        atMs: STALE_AT,
      },
      { model: "glm", states: ["downloaded"], atMs: STALE_AT },
    ]);

    const before = withStore((store) => {
      const fence = store.claimOwnership({ ownerId: "test", incarnation: "t1" });
      return store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model: "glm",
        group: EXCLUSIVE_GROUP,
        to: "loading",
        expectedVersion: seeded.get("glm")!.version,
        nowMs: NOW,
      });
    });
    expect(before.ok).toBe(false);
    if (before.ok || before.reason !== "lifecycle-refused") {
      throw new Error(`expected a lifecycle refusal, got ${JSON.stringify(before)}`);
    }
    expect(before.decision).toMatchObject({
      ok: false,
      reason: "ExclusiveGroupOccupied",
      group: EXCLUSIVE_GROUP,
      peer: { id: "qwen-prod", state: "loading" },
    });
    expect(before.decision.detail).toContain("qwen-prod");

    const writes: string[] = [];
    const summary = runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));
    expect(summary.status).toBe("clean");

    const after = withStore((store) => {
      const fence = store.claimOwnership({ ownerId: "test", incarnation: "t2" });
      const glm = store.getResidencyState("glm");
      return store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model: "glm",
        group: EXCLUSIVE_GROUP,
        to: "loading",
        expectedVersion: glm?.version ?? 0,
        nowMs: NOW,
      });
    });
    expect(after).toMatchObject({ ok: true, record: { state: "loading" } });
  });

  // kills: dropping the age gate (young-b would fail too) or treating a
  // future stamp as stale (future-c would fail too).
  test("OL3: only rows stale for the full window are swept", () => {
    const seeded = seedOrphanRows([
      LOADING_SPEC("stale-a", STALE_AT),
      LOADING_SPEC("young-b", STALE_AT + 1),
      LOADING_SPEC("future-c", NOW + 60_000),
    ]);
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));

    expect(summary).toEqual(CLEAN_SUMMARY);
    const rows = readRows(["stale-a", "young-b", "future-c"]);
    expect(rows.get("stale-a")).toMatchObject({
      state: "failed",
      version: seeded.get("stale-a")!.version + 1,
    });
    expect(rows.get("young-b")).toEqual(seeded.get("young-b"));
    expect(rows.get("future-c")).toEqual(seeded.get("future-c"));
    expect(writes).toEqual([LIFECYCLE_LINE_1]);
  });

  // kills: dropping the 'no nonterminal operation row' gate — the open
  // evict:x row must leave the sweep off entirely.
  test("OL4: any nonterminal operation row leaves the orphan sweep off", () => {
    const seeded = seedOrphanRows([LOADING_SPEC("stale-a", STALE_AT)]);
    const evictVersion = withStore((store) => {
      const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i1" });
      const begun = store.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-evict",
        model: "evict:x",
        targetState: "evicted",
        desiredRevision: 1,
        reservationGiB: 0,
        nowMs: 1,
      });
      if (!begun.ok) {
        throw new Error(`seed beginOperation(evict:x) refused: ${begun.reason}`);
      }
      return begun.record.version;
    });

    let openStoreCalls = 0;
    const writes: string[] = [];
    const first = runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        isProvenDown: down,
        openStore: (storePath) => {
          openStoreCalls += 1;
          return openResidencyOperationStore({ path: storePath });
        },
      }),
    );
    expect(first).toEqual(CLEAN_SUMMARY);
    expect(openStoreCalls).toBe(0);
    expect(readState("stale-a")).toEqual(seeded.get("stale-a")!);
    expect(writes).toEqual([]);
    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });

    withStore((store) => {
      const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i3" });
      const finished = store.finishOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-evict",
        expectedVersion: evictVersion,
        nowMs: NOW,
        outcome: "cancelled",
      });
      if (!finished.ok) {
        throw new Error(`finishOperation(evict:x) refused: ${finished.reason}`);
      }
    });

    const second = runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));
    expect(second).toEqual(CLEAN_SUMMARY);
    expect(readState("stale-a")).toMatchObject({
      state: "failed",
      version: seeded.get("stale-a")!.version + 1,
    });
    expect(writes).toEqual([LIFECYCLE_LINE_1]);
  });

  // kills: removing per-row containment (m3's throw would escape or stop
  // the loop) or miscounting (m2's refusal counted as failed, or the
  // record failures folded into the wrong bucket).
  test("OL5: per-row refusals and throws are contained and counted", () => {
    const seeded = seedOrphanRows([
      LOADING_SPEC("m1", STALE_AT),
      LOADING_SPEC("m2", STALE_AT),
      LOADING_SPEC("m3", STALE_AT),
      LOADING_SPEC("m4", STALE_AT),
    ]);
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        isProvenDown: down,
        openStore: (storePath) => {
          const real = openResidencyOperationStore({ path: storePath });
          trackedStores.push(real);
          const realTransition = real.transitionResidencyState;
          real.transitionResidencyState = (input): TransitionResidencyStateResult => {
            if (input.model === "m2") {
              return { ok: false, reason: "version-conflict" };
            }
            if (input.model === "m3") {
              throw new Error("boom");
            }
            return realTransition(input);
          };
          return real;
        },
      }),
    );

    expect(summary).toEqual(CLEAN_SUMMARY);
    const rows = readRows(["m1", "m2", "m3", "m4"]);
    expect(rows.get("m1")).toMatchObject({
      state: "failed",
      version: seeded.get("m1")!.version + 1,
    });
    expect(rows.get("m4")).toMatchObject({
      state: "failed",
      version: seeded.get("m4")!.version + 1,
    });
    expect(rows.get("m2")).toEqual(seeded.get("m2"));
    expect(rows.get("m3")).toEqual(seeded.get("m3"));
    expect(writes).toEqual([
      '[residency] lifecycle boot recovery {"failed":2,"recordFailures":2}\n',
    ]);
  });

  // kills: a sweep failure that escapes runProfileSwitchBootRecovery, or
  // goes unlogged — the open must surface as the lifecycle 'failed:' line
  // with only the first message line, and boot still reports clean.
  test("OL6: an openStore failure is contained and logged on the lifecycle line", () => {
    const seeded = seedOrphanRows([LOADING_SPEC("only-a", STALE_AT)]);
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        isProvenDown: down,
        openStore: () => {
          throw new Error("disk gone\nsecond line");
        },
      }),
    );

    expect(summary).toEqual(CLEAN_SUMMARY);
    expect(writes).toEqual(["[residency] lifecycle boot recovery failed: disk gone\n"]);
    expect(readState("only-a")).toEqual(seeded.get("only-a")!);
  });

  // kills: claiming from the stale snapshot without the in-transaction
  // re-check — stale-a is failed underneath the claim, so the decide must
  // see it and refuse; the fence stays agent/i1 and nothing is logged.
  test("OL7: the claim re-checks the rows inside the transaction", () => {
    seedOrphanRows([LOADING_SPEC("stale-a", STALE_AT)]);
    const writes: string[] = [];
    let openStoreCalls = 0;

    runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        isProvenDown: down,
        openStore: (storePath) => {
          openStoreCalls += 1;
          const real = openResidencyOperationStore({ path: storePath });
          trackedStores.push(real);
          const realClaimWhen = real.claimOwnershipWhen;
          real.claimOwnershipWhen = (input, decide): ReturnType<Store["claimOwnershipWhen"]> => {
            const other = openResidencyOperationStore({ path: storePath });
            try {
              const fence = other.currentFence();
              const row = other.getResidencyState("stale-a");
              if (fence === null || row === null) {
                throw new Error("seed guard: expected the agent/i1 fence and stale-a");
              }
              const moved = other.transitionResidencyState({
                fenceToken: fence.fenceToken,
                model: "stale-a",
                to: "failed",
                expectedVersion: row.version,
                nowMs: NOW,
              });
              if (!moved.ok) {
                throw new Error(`seed guard: stale-a move refused: ${moved.reason}`);
              }
            } finally {
              other.close();
            }
            return realClaimWhen(input, decide);
          };
          return real;
        },
      }),
    );

    expect(openStoreCalls).toBe(1);
    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });
    expect(writes).toEqual([]);
    expect(readState("stale-a")).toMatchObject({ state: "failed" });
  });

  // kills: dropping the proven-down filter (alive-b and throws-c would
  // fail too), treating a predicate throw as proven down (throws-c would
  // fail), or evaluating the predicate inside the claim transaction
  // (the spy would see more than one call per model).
  test("OL8: only proven-down orphans are swept and the predicate runs once per row", () => {
    const seeded = seedOrphanRows([
      LOADING_SPEC("down-a", STALE_AT),
      LOADING_SPEC("alive-b", STALE_AT),
      LOADING_SPEC("throws-c", STALE_AT),
    ]);
    const calls: string[] = [];
    const isProvenDown = (model: string): boolean => {
      calls.push(model);
      if (model === "down-a") {
        return true;
      }
      if (model === "alive-b") {
        return false;
      }
      throw new Error("ps failed");
    };
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown }));

    expect(summary).toEqual(CLEAN_SUMMARY);
    const rows = readRows(["down-a", "alive-b", "throws-c"]);
    expect(rows.get("down-a")).toMatchObject({
      state: "failed",
      version: seeded.get("down-a")!.version + 1,
    });
    expect(rows.get("alive-b")).toEqual(seeded.get("alive-b"));
    expect(rows.get("throws-c")).toEqual(seeded.get("throws-c"));
    expect(writes).toEqual([LIFECYCLE_LINE_1]);
    const all = writes.join("");
    for (const secret of ["ps failed", "down-a", "alive-b", "throws-c"]) {
      expect(all).not.toContain(secret);
    }
    expect([...calls].sort()).toEqual(["alive-b", "down-a", "throws-c"]);
  });

  // kills: a fail-open default — isProvenDown absent or answering false
  // must leave the store completely untouched, fence included.
  test("OL9: the orphan sweep fails closed without a proven-down predicate", () => {
    const seeded = seedOrphanRows([LOADING_SPEC("only-a", STALE_AT)]);
    const writes: string[] = [];
    let openStoreCalls = 0;
    const openStore = (storePath: string): Store => {
      openStoreCalls += 1;
      return openResidencyOperationStore({ path: storePath });
    };

    const refused = runProfileSwitchBootRecovery(
      recoveryOpts({ writes, isProvenDown: () => false, openStore }),
    );
    expect(refused).toEqual(CLEAN_SUMMARY);
    expect(openStoreCalls).toBe(0);
    expect(readState("only-a")).toEqual(seeded.get("only-a")!);
    expect(writes).toEqual([]);
    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });

    const absent = runProfileSwitchBootRecovery(recoveryOpts({ writes, openStore }));
    expect(absent).toEqual(CLEAN_SUMMARY);
    expect(openStoreCalls).toBe(0);
    expect(readState("only-a")).toEqual(seeded.get("only-a")!);
    expect(writes).toEqual([]);
    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });

    const swept = runProfileSwitchBootRecovery(
      recoveryOpts({ writes, isProvenDown: down, openStore }),
    );
    expect(swept).toEqual(CLEAN_SUMMARY);
    expect(openStoreCalls).toBe(1);
    expect(readState("only-a")).toMatchObject({
      state: "failed",
      version: seeded.get("only-a")!.version + 1,
    });
    expect(writes).toEqual([LIFECYCLE_LINE_1]);
  });
});
