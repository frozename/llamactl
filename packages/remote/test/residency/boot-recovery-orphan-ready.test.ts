/**
 * Part of #517: orphan sweep of proven-down `ready` rows.
 *
 * RED tests for the ready-row half of `sweepOrphanedLifecycleRows`
 * (src/residency/boot-recovery.ts): when the store holds NO nonterminal
 * operation row, boot recovery must also move a `ready` residency_states
 * row to `failed` once the row has made no progress for the staleness
 * window AND its workload is proven down — a crashed engine or a
 * rebooted host leaves `ready` behind exactly like an interrupted
 * transient state, still holding its exclusive group. The claimed
 * profile-switch pass must keep ignoring `ready` rows: only the
 * outside-a-switch orphan pass sweeps them. At base the orphan pass's
 * staleness check reads INTERRUPTED_LIFECYCLE_STATES, which excludes
 * `ready`, so every case fails BY ASSERTION on the untouched rows and
 * missing log lines — never by an import, type or module-resolution
 * error. All state lives in mkdtemp dirs; no engines, no live
 * inference.
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
  dir = mkdtempSync(join(tmpdir(), "llamactl-boot-orphan-ready-"));
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
// `ready`, claimed under agent/i1, with NO operation row — the store
// looks like an agent that died after the walk finished (or a host
// that rebooted with the engine gone). Every hop is stamped atMs; only
// the last hop's stamp survives as the row's updatedAtMs, which is the
// progress clock the age gate reads.
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

const READY_SPEC = (model: string, atMs: number): SeedSpec => ({
  model,
  states: ["downloaded", "loading", "warming", "ready"],
  atMs,
});

describe("orphan sweep of proven-down ready rows (Part of #517)", () => {
  // kills: the orphan pass excluding `ready` (both rows stay ready, no
  // lifecycle line, fence stays agent/i1) and the in-transaction claim
  // re-check in claimAndFailOrphans not admitting ready rows — with only
  // ready rows the decide would refuse and the claim never land.
  test("RR1: stale proven-down ready rows are swept under the apply-profile fence", () => {
    const seeded = seedOrphanRows([
      {
        model: "qwen-prod",
        states: ["downloaded", "loading", "warming", "ready"],
        group: EXCLUSIVE_GROUP,
        atMs: STALE_AT,
      },
      READY_SPEC("w-ready-b", STALE_AT),
    ]);
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));

    expect(summary).toEqual(CLEAN_SUMMARY);
    const rows = readRows(["qwen-prod", "w-ready-b"]);
    for (const model of ["qwen-prod", "w-ready-b"] as const) {
      expect(rows.get(model)).toMatchObject({
        state: "failed",
        version: seeded.get(model)!.version + 1,
        updatedAtMs: NOW,
        ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
        incarnation: "i2",
      });
    }
    expect(writes).toEqual([
      '[residency] lifecycle boot recovery {"failed":2,"recordFailures":0}\n',
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

  // kills: ready rows bypassing the proven-down filter (alive-b and
  // throws-c would fail too) and treating a predicate throw as proven
  // down (throws-c would fail); the once-per-model call count also pins
  // the predicate running outside the claim transaction.
  test("RR2: only proven-down ready rows are swept and the predicate runs once per row", () => {
    const seeded = seedOrphanRows([
      READY_SPEC("down-a", STALE_AT),
      READY_SPEC("alive-b", STALE_AT),
      READY_SPEC("throws-c", STALE_AT),
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
    expect([...calls].sort()).toEqual(["alive-b", "down-a", "throws-c"]);
  });

  // kills: ready rows skipping the staleness window — fresh-r made
  // progress inside MIN_AGE and must stay ready.
  test("RR3: only ready rows stale for the full window are swept", () => {
    const seeded = seedOrphanRows([
      READY_SPEC("stale-r", STALE_AT),
      READY_SPEC("fresh-r", NOW - MIN_AGE + 1),
    ]);
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));

    expect(summary).toEqual(CLEAN_SUMMARY);
    const rows = readRows(["stale-r", "fresh-r"]);
    expect(rows.get("stale-r")).toMatchObject({
      state: "failed",
      version: seeded.get("stale-r")!.version + 1,
      updatedAtMs: NOW,
    });
    expect(rows.get("fresh-r")).toEqual(seeded.get("fresh-r"));
    expect(writes).toEqual([LIFECYCLE_LINE_1]);
  });

  // kills: not sweeping occupying ready rows — qwen-prod keeps holding
  // z13-large-gpu in `ready` and the glm loading hop stays refused.
  test("RR4: sweeping a proven-down ready row releases its exclusive group", () => {
    const seeded = seedOrphanRows([
      {
        model: "qwen-prod",
        states: ["downloaded", "loading", "warming", "ready"],
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
      peer: { id: "qwen-prod", state: "ready" },
    });

    const writes: string[] = [];
    const summary = runProfileSwitchBootRecovery(recoveryOpts({ writes, isProvenDown: down }));
    expect(summary).toEqual(CLEAN_SUMMARY);
    expect(readState("qwen-prod")).toMatchObject({ state: "failed" });

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

  // kills: adding `ready` to INTERRUPTED_LIFECYCLE_STATES (the claimed
  // pass would fail the row on the first run) and dropping the ready
  // sweep from the orphan pass (the second run would leave it ready).
  test("RR5: the claimed switch pass never touches ready; the next boot's orphan sweep does", () => {
    const seeded = seedOrphanRows([READY_SPEC("stale-ready", STALE_AT)]);
    withStore((store) => {
      const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i1" });
      const begun = store.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-switch",
        model: "profile-switch:n1",
        targetState: "profile:p",
        desiredRevision: 1,
        reservationGiB: 0,
        nowMs: STALE_AT,
      });
      if (!begun.ok) {
        throw new Error(`seed beginOperation(profile-switch:n1) refused: ${begun.reason}`);
      }
    });

    const writes1: string[] = [];
    const first = runProfileSwitchBootRecovery(
      recoveryOpts({ writes: writes1, isProvenDown: down }),
    );
    expect(first).toEqual({
      status: "recovered",
      recovered: 1,
      recordFailures: 0,
      skipped: 0,
      unrecognized: 0,
      possiblyLive: 0,
    });
    expect(writes1).toEqual([
      '[residency] profile-switch boot recovery {"recovered":1,"recordFailures":0,"skipped":0,"unrecognized":0,"possiblyLive":0}\n',
    ]);
    expect(readState("stale-ready")).toEqual(seeded.get("stale-ready")!);

    const writes2: string[] = [];
    const second = runProfileSwitchBootRecovery(
      recoveryOpts({ writes: writes2, isProvenDown: down }),
    );
    expect(second).toEqual(CLEAN_SUMMARY);
    expect(readState("stale-ready")).toMatchObject({
      state: "failed",
      version: seeded.get("stale-ready")!.version + 1,
      updatedAtMs: NOW,
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "i2",
    });
    expect(writes2).toEqual([LIFECYCLE_LINE_1]);
  });
});
