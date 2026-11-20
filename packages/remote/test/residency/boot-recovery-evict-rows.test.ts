/**
 * Part of #517: boot recovery of crashed `evict:` operation rows.
 *
 * RED tests for the eviction half of `runProfileSwitchBootRecovery`
 * (src/residency/boot-recovery.ts): when the store holds NO nonterminal
 * `profile-switch:` row, boot recovery must first finish stale, recognized
 * `evict:<victim>` operation rows — `targetState` reading
 * `evicted-by:<replacement>`, no progress for
 * PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS — as `unknown` /
 * `interrupted-unverified` under a claim of the apply-profile fence, log
 * `[residency] eviction boot recovery {"recovered":N,"recordFailures":M}`,
 * and only then run the outside-a-switch lifecycle sweep over the
 * POST-recovery nonterminal list. A younger `evict:` row defers the whole
 * pass, a malformed one is never finished, and a possibly-live
 * `profile-switch:` row defers everything. At base no eviction pass
 * exists: the orphan sweep's `nonterminal.length !== 0` gate returns
 * before the store is ever opened, so every case fails BY ASSERTION on the
 * untouched rows and missing log lines — never by an import, type or
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
import { beginEvictionOperations } from "../../src/residency/eviction-operation.js";
import { recoverEvictionOperationsUnverified } from "../../src/residency/recovery.js";
import {
  openResidencyOperationStore,
  type ResidencyOperationRecord,
  type ResidencyStateRecord,
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

const EVICT_LINE_1 = '[residency] eviction boot recovery {"recovered":1,"recordFailures":0}\n';
const LIFECYCLE_LINE_1 = '[residency] lifecycle boot recovery {"failed":1,"recordFailures":0}\n';

type Store = ReturnType<typeof openResidencyOperationStore>;
type RecoveryOpts = Parameters<typeof runProfileSwitchBootRecovery>[0];

type SeedSpec = {
  model: string;
  states: readonly ResidencyState[];
  group?: string;
  atMs: number;
};

type RawOpSeed = {
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  atMs: number;
};

let dir = "";
let path = "";
const trackedStores: { close: () => void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-boot-evict-"));
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

// One crashed writer's claim: every seeded row shares the agent/i1 fence,
// the residue a reboot inherits.
function withCrashedClaim<T>(fn: (store: Store, fenceToken: number) => T): T {
  return withStore((store) => {
    const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i1" });
    return fn(store, fence.fenceToken);
  });
}

// The crashed eviction writer's residue, seeded through the real writer so
// the classifier is pinned to its on-disk format: model `evict:<victim>`,
// targetState `evicted-by:<replacement>`, phase pending.
function seedEvictRow(
  store: Store,
  fenceToken: number,
  victim: string,
  atMs: number,
  desiredRevision = 1,
): void {
  const begun = beginEvictionOperations(
    {
      store,
      fenceToken,
      desiredRevision,
      nowMs: () => atMs,
      operationIdFor: (v) => `op-evict-${v}`,
    },
    "rep",
    [victim],
  );
  if (!begun.ok) {
    throw new Error(`seed beginEvictionOperations(${victim}) refused: ${begun.reason}`);
  }
}

// A row the real eviction writer would never produce — the classifier must
// leave it nonterminal.
function seedRawOperation(store: Store, fenceToken: number, seed: RawOpSeed): void {
  const begun = store.beginOperation({
    fenceToken,
    operationId: seed.operationId,
    model: seed.model,
    targetState: seed.targetState,
    desiredRevision: seed.desiredRevision,
    reservationGiB: 0,
    nowMs: seed.atMs,
  });
  if (!begun.ok) {
    throw new Error(`seed beginOperation(${seed.operationId}) refused: ${begun.reason}`);
  }
}

// The crashed direct writer's residue: residency_states rows parked at
// their final hop under the same agent/i1 claim. Copied from
// boot-recovery-orphan-lifecycle.test.ts.
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

const LOADING_SPEC = (model: string, atMs: number): SeedSpec => ({
  model,
  states: ["downloaded", "loading"],
  atMs,
});

// Optional fields ride through conditional spreads so an omitted one stays
// absent under exactOptionalPropertyTypes.
function recoveryOpts(input: {
  writes: string[];
  now?: number;
  isProvenDown?: (model: string) => boolean;
  openStore?: (storePath: string) => Store;
}): RecoveryOpts {
  const now = input.now ?? NOW;
  return {
    path,
    incarnation: "i2",
    nowMs: (): number => now,
    write: (line: string): void => {
      input.writes.push(line);
    },
    ...(input.isProvenDown === undefined ? {} : { isProvenDown: input.isProvenDown }),
    ...(input.openStore === undefined ? {} : { openStore: input.openStore }),
  };
}

function readOperation(operationId: string): ResidencyOperationRecord | null {
  return withStore((store) => store.getOperation(operationId));
}

function readState(model: string): ResidencyStateRecord | null {
  return withStore((store) => store.getResidencyState(model));
}

function currentFence(): { ownerId: string; incarnation: string; fenceToken: number } | null {
  return withStore((store) => store.currentFence());
}

describe("crashed evict: operation rows at boot (Part of #517)", () => {
  // kills: deleting the eviction pass — the stale evict: row stays pending,
  // the fence stays agent/i1 and no eviction line is ever written.
  test("ER1: a stale evict: row is finished unknown under the apply-profile fence", () => {
    withCrashedClaim((store, fenceToken) => {
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
    });
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(recoveryOpts({ writes }));

    expect(summary).toEqual(CLEAN_SUMMARY);
    expect(readOperation("op-evict-victim-a")).toMatchObject({
      phase: "terminal",
      outcome: "unknown",
      detail: "recovered: interrupted-unverified (was pending)",
    });
    expect(currentFence()).toMatchObject({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "i2",
    });
    expect(writes).toEqual([EVICT_LINE_1]);
  });

  // kills: handing the orphan sweep the pre-recovery snapshot.nonterminal
  // instead of the post-recovery nonterminal list — qwen-prod keeps holding
  // z13-large-gpu in 'loading', the lifecycle line never logs and the glm
  // loading hop stays refused.
  test("ER2: the orphan sweep runs on the post-recovery nonterminal list", () => {
    const seeded = withCrashedClaim((store, fenceToken) => {
      const rows = new Map<string, ResidencyStateRecord>();
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
      rows.set(
        "qwen-prod",
        walkSeedRow(store, fenceToken, {
          model: "qwen-prod",
          states: ["downloaded", "loading"],
          group: EXCLUSIVE_GROUP,
          atMs: STALE_AT,
        }),
      );
      rows.set(
        "glm",
        walkSeedRow(store, fenceToken, { model: "glm", states: ["downloaded"], atMs: STALE_AT }),
      );
      return rows;
    });
    const writes: string[] = [];

    runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));

    expect(readOperation("op-evict-victim-a")).toMatchObject({
      phase: "terminal",
      outcome: "unknown",
    });
    expect(readState("qwen-prod")).toMatchObject({
      state: "failed",
      version: seeded.get("qwen-prod")!.version + 1,
    });
    expect(writes).toEqual([EVICT_LINE_1, LIFECYCLE_LINE_1]);

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

  // kills: dropping the age gate (the young row would finish too) or making
  // the window edge exclusive (the exact-edge row would stay pending).
  test("ER3: only an evict: row stale for the full window is finished", () => {
    withCrashedClaim((store, fenceToken) => {
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT + 1);
    });
    let openStoreCalls = 0;
    const writes: string[] = [];
    const openStore = (storePath: string): Store => {
      openStoreCalls += 1;
      return openResidencyOperationStore({ path: storePath });
    };

    runProfileSwitchBootRecovery(recoveryOpts({ writes, openStore }));

    expect(readOperation("op-evict-victim-a")).toMatchObject({ phase: "pending" });
    expect(openStoreCalls).toBe(0);
    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });
    expect(writes).toEqual([]);

    runProfileSwitchBootRecovery(recoveryOpts({ writes, now: STALE_AT + 1 + MIN_AGE, openStore }));

    expect(readOperation("op-evict-victim-a")).toMatchObject({
      phase: "terminal",
      outcome: "unknown",
    });
    expect(writes).toEqual([EVICT_LINE_1]);
  });

  // kills: finishing unrecognized rows (both malformed rows would go
  // terminal) or dropping the `evicted-by:` target check (bad-target would
  // finish too) — either leaves the orphan sweep free to fail stale-a.
  test("ER4: malformed evict: rows are never finished and keep the sweep off", () => {
    const seeded = withCrashedClaim((store, fenceToken) => {
      const rows = new Map<string, ResidencyStateRecord>();
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
      seedRawOperation(store, fenceToken, {
        operationId: "op-evict-bad-target",
        model: "evict:bad-target",
        targetState: "evicted",
        desiredRevision: 1,
        atMs: 1,
      });
      seedRawOperation(store, fenceToken, {
        operationId: "op-evict-empty",
        model: "evict:",
        targetState: "evicted-by:rep",
        desiredRevision: 1,
        atMs: 1,
      });
      rows.set("stale-a", walkSeedRow(store, fenceToken, LOADING_SPEC("stale-a", STALE_AT)));
      return rows;
    });
    const writes: string[] = [];

    runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));

    expect(readOperation("op-evict-victim-a")).toMatchObject({
      phase: "terminal",
      outcome: "unknown",
    });
    expect(readOperation("op-evict-bad-target")).toMatchObject({ phase: "pending" });
    expect(readOperation("op-evict-empty")).toMatchObject({ phase: "pending" });
    expect(readState("stale-a")).toEqual(seeded.get("stale-a")!);
    expect(writes).toEqual([EVICT_LINE_1]);
  });

  // kills: running eviction recovery while a profile-switch row is
  // nonterminal (phase 1 would finish the evict row and log the eviction
  // line) and deleting the pass (phase 2 would leave the row pending).
  test("ER5: a possibly-live profile-switch row defers the eviction pass", () => {
    withCrashedClaim((store, fenceToken) => {
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
      seedRawOperation(store, fenceToken, {
        operationId: "op-switch-node-a",
        model: "profile-switch:node-a",
        targetState: "profile:p1",
        desiredRevision: 2,
        atMs: NOW,
      });
    });
    const writes: string[] = [];

    const first = runProfileSwitchBootRecovery(recoveryOpts({ writes }));

    expect(first.status).toBe("deferred");
    expect(first.possiblyLive).toBe(1);
    expect(readOperation("op-evict-victim-a")).toMatchObject({ phase: "pending" });
    expect(writes.join("")).not.toContain("eviction boot recovery");

    withStore((store) => {
      const fence = store.claimOwnership({ ownerId: "cli", incarnation: "i9" });
      const finished = store.finishOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-switch-node-a",
        expectedVersion: 1,
        nowMs: NOW,
        outcome: "cancelled",
      });
      if (!finished.ok) {
        throw new Error(`finishOperation(op-switch-node-a) refused: ${finished.reason}`);
      }
    });

    const writes2: string[] = [];
    runProfileSwitchBootRecovery(recoveryOpts({ writes: writes2 }));

    expect(readOperation("op-evict-victim-a")).toMatchObject({
      phase: "terminal",
      outcome: "unknown",
    });
    expect(writes2).toEqual([EVICT_LINE_1]);
  });

  // kills: an uncontained finish throw (the error would escape or abort the
  // pass) or running the orphan sweep beside a still-nonterminal evict row
  // (stale-a would fail and a lifecycle line would log).
  test("ER6: a throwing finishOperation is contained and counted", () => {
    const seeded = withCrashedClaim((store, fenceToken) => {
      const rows = new Map<string, ResidencyStateRecord>();
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
      rows.set("stale-a", walkSeedRow(store, fenceToken, LOADING_SPEC("stale-a", STALE_AT)));
      return rows;
    });
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        isProvenDown: down,
        openStore: (storePath) => {
          const real = openResidencyOperationStore({ path: storePath });
          trackedStores.push(real);
          real.finishOperation = (): never => {
            throw new Error("finish boom");
          };
          return real;
        },
      }),
    );

    expect(summary).toEqual(CLEAN_SUMMARY);
    expect(writes).toEqual([
      '[residency] eviction boot recovery {"recovered":0,"recordFailures":1}\n',
    ]);
    expect(readOperation("op-evict-victim-a")).toMatchObject({ phase: "pending" });
    expect(readState("stale-a")).toEqual(seeded.get("stale-a")!);
  });

  // kills: removing the catch around the eviction pass open (the error
  // would escape runProfileSwitchBootRecovery) or logging more than the
  // first message line.
  test("ER7: an openStore failure is contained and logged on the eviction line", () => {
    withCrashedClaim((store, fenceToken) => {
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
    });
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        openStore: () => {
          throw new Error("open boom\nsecond line");
        },
      }),
    );

    expect(summary).toEqual(CLEAN_SUMMARY);
    expect(writes).toEqual(["[residency] eviction boot recovery failed: open boom\n"]);
    expect(readOperation("op-evict-victim-a")).toMatchObject({ phase: "pending" });
  });

  // kills: dropping the in-transaction no-profile-switch re-check — a
  // switch begun between the read-only snapshot and the claim must refuse
  // the claim, so the evict row stays pending, the fence stays agent/i1 and
  // nothing is logged.
  test("ER8: a profile-switch begun before the claim refuses the eviction claim", () => {
    withCrashedClaim((store, fenceToken) => {
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
    });
    const writes: string[] = [];
    let openStoreCalls = 0;

    runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        openStore: (storePath) => {
          openStoreCalls += 1;
          const real = openResidencyOperationStore({ path: storePath });
          trackedStores.push(real);
          const realClaimWhen = real.claimOwnershipWhen;
          real.claimOwnershipWhen = (input, decide): ReturnType<Store["claimOwnershipWhen"]> => {
            const other = openResidencyOperationStore({ path: storePath });
            try {
              const fence = other.currentFence();
              if (fence === null) {
                throw new Error("seed guard: expected the agent/i1 fence");
              }
              const begun = other.beginOperation({
                fenceToken: fence.fenceToken,
                operationId: "op-switch-node-a",
                model: "profile-switch:node-a",
                targetState: "profile:p1",
                desiredRevision: 2,
                reservationGiB: 0,
                nowMs: NOW,
              });
              if (!begun.ok) {
                throw new Error(
                  `seed guard: beginOperation(profile-switch) refused: ${begun.reason}`,
                );
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
    expect(readOperation("op-evict-victim-a")).toMatchObject({ phase: "pending" });
    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });
    expect(writes).toEqual([]);
  });

  // kills: removing both possiblyLive gates (the `|| preview.possiblyLive > 0`
  // early return in recoverCrashedEvictionRows AND `&& live.possiblyLive === 0`
  // in shouldClaimEviction) — the store would be opened, the fence claimed by
  // apply-profile/i2, the stale row finished and the eviction line logged.
  test("ER9: a younger evict: row defers the whole eviction pass", () => {
    withCrashedClaim((store, fenceToken) => {
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
      seedEvictRow(store, fenceToken, "victim-b", STALE_AT + 1);
    });
    let openStoreCalls = 0;
    const writes: string[] = [];
    const openStore = (storePath: string): Store => {
      openStoreCalls += 1;
      const real = openResidencyOperationStore({ path: storePath });
      trackedStores.push(real);
      return real;
    };

    runProfileSwitchBootRecovery(recoveryOpts({ writes, openStore }));

    expect(readOperation("op-evict-victim-a")).toMatchObject({ phase: "pending" });
    expect(readOperation("op-evict-victim-b")).toMatchObject({ phase: "pending" });
    expect(openStoreCalls).toBe(0);
    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });
    expect(writes).toEqual([]);
  });

  // kills: removing `&& live.possiblyLive === 0` from shouldClaimEviction —
  // a young evict: row begun between the read-only snapshot and the claim
  // must refuse the claim, so the stale row stays pending, the fence stays
  // agent/i1 and nothing is logged.
  test("ER10: an evict: row begun before the claim refuses the eviction claim", () => {
    withCrashedClaim((store, fenceToken) => {
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
    });
    const writes: string[] = [];
    let openStoreCalls = 0;

    runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        openStore: (storePath) => {
          openStoreCalls += 1;
          const real = openResidencyOperationStore({ path: storePath });
          trackedStores.push(real);
          const realClaimWhen = real.claimOwnershipWhen;
          real.claimOwnershipWhen = (input, decide): ReturnType<Store["claimOwnershipWhen"]> => {
            const other = openResidencyOperationStore({ path: storePath });
            try {
              const fence = other.currentFence();
              if (fence === null) {
                throw new Error("seed guard: expected the agent/i1 fence");
              }
              seedEvictRow(other, fence.fenceToken, "victim-b", NOW);
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
    expect(readOperation("op-evict-victim-a")).toMatchObject({ phase: "pending" });
    expect(readOperation("op-evict-victim-b")).toMatchObject({ phase: "pending" });
    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });
    expect(writes).toEqual([]);
  });

  // kills: dropping `live.stale > 0 &&` from shouldClaimEviction — if another
  // writer finishes the last stale evict: row between the read-only snapshot
  // and the in-transaction claim, the claim must be refused: the fence stays
  // agent/i1 (no bump to the apply-profile owner) and no zero-count eviction
  // line is logged.
  test("ER11: a stale evict: row finished before the claim refuses the eviction claim", () => {
    withCrashedClaim((store, fenceToken) => {
      seedEvictRow(store, fenceToken, "victim-a", STALE_AT);
    });
    const writes: string[] = [];

    runProfileSwitchBootRecovery(
      recoveryOpts({
        writes,
        openStore: (storePath) => {
          const real = openResidencyOperationStore({ path: storePath });
          trackedStores.push(real);
          const realClaimWhen = real.claimOwnershipWhen;
          real.claimOwnershipWhen = (input, decide): ReturnType<Store["claimOwnershipWhen"]> => {
            const other = openResidencyOperationStore({ path: storePath });
            try {
              const fence = other.currentFence();
              const op = other.getOperation("op-evict-victim-a");
              if (fence === null || op === null) {
                throw new Error("seed guard: expected the agent/i1 fence and the stale row");
              }
              const finished = other.finishOperation({
                fenceToken: fence.fenceToken,
                operationId: op.operationId,
                expectedVersion: op.version,
                nowMs: NOW,
                outcome: "succeeded",
              });
              if (!finished.ok) {
                throw new Error(`seed guard: finishing the stale row failed: ${finished.reason}`);
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

    expect(currentFence()).toMatchObject({ ownerId: "agent", incarnation: "i1" });
    expect(writes).toEqual([]);
  });
});

describe("recoverEvictionOperationsUnverified (Part of #517)", () => {
  // kills: removing the per-row isPossiblyLive skip in
  // recoverEvictionOperationsUnverified — the young row would be finished
  // unknown too and `recovered` would read 2.
  test("EU1: a mixed-age store finishes only the stale evict: row", () => {
    const fenceToken = withCrashedClaim((store, crashedFence) => {
      seedEvictRow(store, crashedFence, "victim-a", STALE_AT);
      seedEvictRow(store, crashedFence, "victim-b", STALE_AT + 1);
      return store.claimOwnership({ ownerId: "test", incarnation: "t1" }).fenceToken;
    });

    const result = withStore((store) =>
      recoverEvictionOperationsUnverified({
        store,
        fenceToken,
        nowMs: (): number => NOW,
        minStaleAgeMs: MIN_AGE,
      }),
    );

    expect(result).toEqual({ recovered: 1, recordFailures: 0 });
    expect(readOperation("op-evict-victim-a")).toMatchObject({
      phase: "terminal",
      outcome: "unknown",
      detail: "recovered: interrupted-unverified (was pending)",
    });
    expect(readOperation("op-evict-victim-b")).toMatchObject({ phase: "pending" });
  });
});
