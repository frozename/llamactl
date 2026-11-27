/**
 * #279 DF-06 follow-up — RED tests for `runProfileSwitchBootRecovery` in
 * `src/residency/boot-recovery`: the synchronous agent-startup pass that
 * terminalizes leftover `profile-switch:<node>` operation rows before the
 * agent serves, so the next switch on that node is not Busy. At base the
 * module does not exist: the guarded dynamic import resolves to null and
 * every case fails BY ASSERTION — never by an import, type or
 * module-resolution error. All state lives in mkdtemp dirs; the `openStore`
 * fakes keep the writable-handle boundary observable.
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type { OkPlan, PlannerWorkload } from "@llamactl/core/residency/planner";

import { createResidencyLeases } from "@llamactl/core/residency/leases";
import { planProfileSwitch } from "@llamactl/core/residency/planner";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import { PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS } from "../../src/residency/boot-recovery.js";
import {
  executeProfileSwitch,
  type ProfileSwitchOperationOpts,
} from "../../src/residency/profile-transition.js";
import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { existsSync, mkdtempSync, readlinkSync, rmSync } from "../../src/safe-fs.js";

const BOOT_MODULE = "../../src/residency/boot-recovery.js" as string;

// ── runProfileSwitchBootRecovery contract (declared loose, RED) ────────

type BootRecoverySummary = {
  status: "absent" | "clean" | "deferred" | "recovered" | "failed";
  recovered: number;
  recordFailures: number;
  skipped: number;
  unrecognized: number;
  possiblyLive: number;
};

type BootRecoveryStore = ReturnType<typeof openResidencyOperationStore>;

type BootRecoveryOpts = {
  path: string;
  incarnation: string;
  nowMs?: () => number;
  minStaleAgeMs?: number;
  write?: (line: string) => void;
  openStore?: (storePath: string) => BootRecoveryStore;
};

type BootRecoveryFn = (opts: BootRecoveryOpts) => BootRecoverySummary;

// A variable specifier keeps tsc from resolving the not-yet-existing
// module — a literal specifier would be a resolution error, not an
// assertion failure.
async function loadBootRecovery(): Promise<BootRecoveryFn> {
  const mod = (await import(BOOT_MODULE).catch(() => null)) as Record<string, unknown> | null;
  expect(mod).not.toBeNull();
  const fn = mod?.["runProfileSwitchBootRecovery"];
  expect(typeof fn).toBe("function");
  return fn as BootRecoveryFn;
}

let dir = "";
let path = "";
const trackedStores: { close: () => void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-boot-recovery-"));
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

type SeedRow = {
  operationId?: string;
  model?: string;
  targetState?: string;
  desiredRevision?: number;
  nowMs?: number;
  owner?: { ownerId: string; incarnation: string };
  committed?: boolean;
};

// Leaves the same pending `profile-switch:<node>` row a crashed switch
// would have begun: claim as agent/i1, begin, close — the leftover the
// next incarnation's boot pass must recover.
function seedCrashRow(row: SeedRow = {}): void {
  const store = openResidencyOperationStore({ path });
  try {
    const fence = store.claimOwnership(row.owner ?? { ownerId: "agent", incarnation: "i1" });
    const operationId = row.operationId ?? "op-crash";
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId,
      model: row.model ?? "profile-switch:n1",
      targetState: row.targetState ?? "profile:interactive",
      desiredRevision: row.desiredRevision ?? 1,
      reservationGiB: 0,
      nowMs: row.nowMs ?? 1,
    });
    if (!begun.ok) {
      throw new Error(`seed beginOperation(${operationId}) refused: ${begun.reason}`);
    }
    if (row.committed === true) {
      expect(
        store.commitReservation({
          operationId,
          fenceToken: fence.fenceToken,
          nowMs: row.nowMs ?? 1,
          expectedVersion: begun.record.version,
        }),
      ).toEqual({ ok: true });
    }
  } finally {
    store.close();
  }
}

function currentFence(): { ownerId: string; incarnation: string; fenceToken: number } | null {
  const store = openResidencyOperationStore({ path });
  try {
    return store.currentFence();
  } finally {
    store.close();
  }
}

function nonterminalIds(): string[] {
  const snap = readResidencyStoreSnapshot(path);
  expect(snap.present).toBe(true);
  if (!snap.present || !("nonterminal" in snap)) {
    throw new Error(`expected a readable snapshot, got ${JSON.stringify(snap)}`);
  }
  return snap.nonterminal.map((record) => record.operationId);
}

function recordedProfileOwner(pid: number): NonNullable<SeedRow["owner"]> {
  const namespace = process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : "darwin";
  const host = createHash("sha256").update(`${hostname()}\0${namespace}`).digest("base64url");
  return {
    ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
    incarnation: `profile-owner-v1:${host}:${String(pid)}:${randomUUID()}`,
  };
}

describe("runProfileSwitchBootRecovery (#279 DF-06)", () => {
  // Kills M3: a boot path that never runs the recovery scan or never
  // claims a fence leaves op-crash nonterminal — the follow-up switch is
  // refused reservation-conflict, which executeProfileSwitch reports as
  // Busy. desiredRevision 2 clears the watermark the terminal row keeps.
  test("leftover row is terminalized and the next switch is not Busy", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow();

    const writes: string[] = [];
    const ret = recover({
      path,
      incarnation: "i2",
      write: (line) => {
        writes.push(line);
      },
    });

    expect(ret instanceof Promise).toBe(false);
    expect(ret).toEqual({
      status: "recovered",
      recovered: 1,
      recordFailures: 0,
      skipped: 0,
      unrecognized: 0,
      possiblyLive: 0,
    });

    const store = openResidencyOperationStore({ path });
    try {
      const rec = store.getOperation("op-crash");
      expect(rec).not.toBeNull();
      expect(rec?.phase).toBe("terminal");
      expect(rec?.outcome).toBe("unknown");
      expect(rec?.detail).toBe("recovered: interrupted-unverified (was pending)");

      const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i3" });
      const begun = store.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-next",
        model: "profile-switch:n1",
        targetState: "profile:batch",
        desiredRevision: 2,
        reservationGiB: 0,
        nowMs: 2,
      });
      expect(begun.ok).toBe(true);
    } finally {
      store.close();
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\[residency\] profile-switch boot recovery /);
    expect(writes[0]).toContain('"recovered":1');
  });

  // Kills M6: opening the writable store unconditionally mkdirs the parent
  // and creates the SQLite file, so existsSync(path) flips true.
  test("absent store stays absent", async () => {
    const recover = await loadBootRecovery();
    const writes: string[] = [];
    let openStoreCalls = 0;

    const summary = recover({
      path,
      incarnation: "i2",
      write: (line) => {
        writes.push(line);
      },
      openStore: () => {
        openStoreCalls += 1;
        throw new Error("openStore must not run for an absent store");
      },
    });

    expect(summary.status).toBe("absent");
    expect(existsSync(path)).toBe(false);
    expect(writes).toHaveLength(0);
    expect(openStoreCalls).toBe(0);
  });

  // Kills M5: without the outer try/catch — or with a rethrow — the
  // SQLITE_BUSY escapes runProfileSwitchBootRecovery instead of landing
  // in the summary as a record failure.
  test("a finishOperation failure is contained in the summary", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow();

    const summary = recover({
      path,
      incarnation: "i2",
      write: () => undefined,
      openStore: (storePath) => {
        const real = openResidencyOperationStore({ path: storePath });
        let closed = false;
        const realClose = real.close;
        real.close = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          realClose();
        };
        real.finishOperation = (): never => {
          throw new Error("SQLITE_BUSY");
        };
        trackedStores.push(real);
        return real;
      },
    });

    expect(summary.status).toBe("recovered");
    expect(summary.recordFailures).toBe(1);
  });

  // Kills M5: same outer try/catch — the openStore throw must become
  // status "failed" plus one summary line, never an escape. The seeded
  // row proves the snapshot gate let the call through.
  test("an openStore failure is reported as failed and never escapes", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow();

    const writes: string[] = [];
    const summary = recover({
      path,
      incarnation: "i2",
      write: (line) => {
        writes.push(line);
      },
      openStore: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    });

    expect(summary.status).toBe("failed");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\[residency\] profile-switch boot recovery failed: /);
    expect(nonterminalIds()).toEqual(["op-crash"]);
  });

  // Kills M1-family: a malformed profile-switch row must land in
  // `unrecognized` on the summary — silently skipping it (or
  // terminalizing it) fails here.
  test("corrupt rows are reported", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow({ operationId: "op-bad-target", targetState: "bogus" });

    const writes: string[] = [];
    const summary = recover({
      path,
      incarnation: "i2",
      write: (line) => {
        writes.push(line);
      },
    });

    expect(summary.unrecognized).toBe(1);
    // Nothing recognized needs finishing, so the fence is never claimed.
    expect(summary.status).toBe("deferred");
    expect(writes.some((line) => line.includes('"unrecognized":1'))).toBe(true);
    expect(nonterminalIds()).toEqual(["op-bad-target"]);
    expect(currentFence()).toEqual({ ownerId: "agent", incarnation: "i1", fenceToken: 1 });
  });

  // Pins the snapshot gate's negative: openStore runs ONLY when a
  // nonterminal row's model starts with "profile-switch:" — a plain
  // model row leaves the store clean without ever opening a writable
  // handle.
  test("a store with only non-switch rows is clean and never opens the writable store", async () => {
    const recover = await loadBootRecovery();
    const store = openResidencyOperationStore({ path });
    try {
      const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i1" });
      const begun = store.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-model",
        model: "llama-x",
        targetState: "ready",
        desiredRevision: 1,
        reservationGiB: 0,
        nowMs: 1,
      });
      if (!begun.ok) {
        throw new Error(`seed beginOperation(op-model) refused: ${begun.reason}`);
      }
    } finally {
      store.close();
    }

    let openStoreCalls = 0;
    const summary = recover({
      path,
      incarnation: "i2",
      write: () => undefined,
      openStore: (storePath) => {
        openStoreCalls += 1;
        return openResidencyOperationStore({ path: storePath });
      },
    });

    expect(summary.status).toBe("clean");
    expect(openStoreCalls).toBe(0);
    expect(nonterminalIds()).toEqual(["op-model"]);
  });

  // Kills O1: a boot claim under any owner but the apply-profile owner turns
  // every later wet apply-profile into a foreign-owner Busy.
  test("the recovery claim uses the apply-profile fence owner", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow();

    const summary = recover({ path, incarnation: "i2", write: () => undefined });

    expect(summary.status).toBe("recovered");
    expect(currentFence()?.ownerId).toBe(RESIDENCY_APPLY_PROFILE_FENCE_OWNER);
    expect(currentFence()?.incarnation).toBe("i2");
  });

  // Kills W1: without the live-switch guard a row a CLI switch is still
  // running is terminalized. One ms inside the window is possibly live and
  // nothing is claimed; at the window edge the same row is recovered.
  test("a row younger than the staleness window is possibly live and left alone", async () => {
    const recover = await loadBootRecovery();
    const started = 1_000_000;
    seedCrashRow({ nowMs: started });
    let openStoreCalls = 0;
    const writes: string[] = [];

    const fresh = recover({
      path,
      incarnation: "i2",
      nowMs: () => started + PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS - 1,
      write: (line) => {
        writes.push(line);
      },
      openStore: (storePath) => {
        openStoreCalls += 1;
        return openResidencyOperationStore({ path: storePath });
      },
    });

    expect(fresh).toEqual({
      status: "deferred",
      recovered: 0,
      recordFailures: 0,
      skipped: 0,
      unrecognized: 0,
      possiblyLive: 1,
    });
    expect(openStoreCalls).toBe(0);
    expect(nonterminalIds()).toEqual(["op-crash"]);
    expect(currentFence()).toEqual({ ownerId: "agent", incarnation: "i1", fenceToken: 1 });
    expect(writes).toEqual([
      '[residency] profile-switch boot recovery {"recovered":0,"recordFailures":0,"skipped":0,"unrecognized":0,"possiblyLive":1}\n',
    ]);

    const old = recover({
      path,
      incarnation: "i3",
      nowMs: () => started + PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
      write: () => undefined,
    });

    expect(old.status).toBe("recovered");
    expect(old.recovered).toBe(1);
    expect(old.possiblyLive).toBe(0);
    expect(nonterminalIds()).toEqual([]);
  });

  test("a young pending reservation owned by an exited process is recovered without replacing the fence", async () => {
    const recover = await loadBootRecovery();
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    seedCrashRow({ owner: recordedProfileOwner(child.pid), nowMs: 50_000 });
    const before = currentFence();

    const result = recover({
      path,
      incarnation: "boot",
      nowMs: () => 50_001,
      write: () => undefined,
    });

    expect(result.status).toBe("recovered");
    expect(result.recovered).toBe(1);
    expect(nonterminalIds()).toEqual([]);
    expect(currentFence()).toEqual(before);
  });

  test("a young committed switch survives owner exit recovery", async () => {
    const recover = await loadBootRecovery();
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    seedCrashRow({ owner: recordedProfileOwner(child.pid), nowMs: 50_000, committed: true });
    const before = currentFence();

    const result = recover({
      path,
      incarnation: "boot",
      nowMs: () => 50_001,
      write: () => undefined,
    });

    expect(result.status).toBe("deferred");
    expect(nonterminalIds()).toEqual(["op-crash"]);
    expect(currentFence()).toEqual(before);
  });

  test("a dispatch commit wins over early recovery's stale pending snapshot", async () => {
    const recover = await loadBootRecovery();
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    seedCrashRow({ owner: recordedProfileOwner(child.pid), nowMs: 50_000 });
    const before = currentFence();
    let opened = 0;

    const result = recover({
      path,
      incarnation: "boot",
      nowMs: () => 50_001,
      write: () => undefined,
      openStore: (storePath) => {
        opened += 1;
        const store = openResidencyOperationStore({ path: storePath });
        const row = store.getOperation("op-crash");
        if (row === null) throw new Error("missing pending operation");
        expect(
          store.commitReservation({
            operationId: row.operationId,
            fenceToken: row.fenceToken,
            expectedVersion: row.version,
            nowMs: 50_001,
          }),
        ).toEqual({ ok: true });
        return store;
      },
    });

    expect(opened).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.recordFailures).toBe(1);
    expect(nonterminalIds()).toEqual(["op-crash"]);
    expect(currentFence()).toEqual(before);
  });

  test("a recognized live profile owner is not fenced out after the staleness window", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow({ owner: recordedProfileOwner(process.pid), nowMs: 1, committed: true });
    const before = currentFence();

    const result = recover({
      path,
      incarnation: "boot",
      nowMs: () => 1 + PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
      write: () => undefined,
    });

    expect(result.status).toBe("deferred");
    expect(nonterminalIds()).toEqual(["op-crash"]);
    expect(currentFence()).toEqual(before);
  });

  // The window defaults on: a row stamped now is possibly live under the
  // real clock.
  test("the default staleness window leaves a just-started row alone", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow({ nowMs: Date.now() });

    const summary = recover({ path, incarnation: "i2", write: () => undefined });

    expect(summary.status).toBe("deferred");
    expect(summary.possiblyLive).toBe(1);
    expect(nonterminalIds()).toEqual(["op-crash"]);
  });

  // Kills M10: the log line carries counts only — never an operation id,
  // a model, a node or a profile name.
  test("the boot log line carries counts only", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow({ operationId: "op-secret-id", model: "profile-switch:node-secret" });
    seedCrashRow({
      operationId: "op-secret-bad",
      model: "profile-switch:node-other",
      targetState: "bogus-target",
    });

    const writes: string[] = [];
    const summary = recover({
      path,
      incarnation: "i2",
      write: (line) => {
        writes.push(line);
      },
    });

    expect(summary.status).toBe("recovered");
    expect(writes).toEqual([
      '[residency] profile-switch boot recovery {"recovered":1,"recordFailures":0,"skipped":0,"unrecognized":1,"possiblyLive":0}\n',
    ]);
    for (const secret of ["op-secret", "node-secret", "node-other", "interactive", "bogus"]) {
      expect(writes.join("")).not.toContain(secret);
    }
  });

  // Kills M11: a write sink that throws must never escape boot, on the
  // recovered path or the failure path.
  test("a throwing write sink does not crash boot", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow();
    const throwingWrite = (): never => {
      throw new Error("EPIPE");
    };

    const summary = recover({ path, incarnation: "i2", write: throwingWrite });

    expect(summary.status).toBe("recovered");
    expect(summary.recovered).toBe(1);
    expect(nonterminalIds()).toEqual([]);

    seedCrashRow({ operationId: "op-crash-2", desiredRevision: 2 });
    const failed = recover({
      path,
      incarnation: "i3",
      write: throwingWrite,
      openStore: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    });
    expect(failed.status).toBe("failed");
  });

  // Kills M12: once the rows are written, a store.close throw is not a
  // recovery failure.
  test("a store.close throw after a successful recovery still reports recovered", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow();

    const writes: string[] = [];
    const summary = recover({
      path,
      incarnation: "i2",
      write: (line) => {
        writes.push(line);
      },
      openStore: (storePath) => {
        const real = openResidencyOperationStore({ path: storePath });
        const realClose = real.close;
        real.close = (): void => {
          realClose();
          throw new Error("close failed");
        };
        return real;
      },
    });

    expect(summary.status).toBe("recovered");
    expect(summary.recovered).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("failed");
    expect(nonterminalIds()).toEqual([]);
  });
});

// ── step-boundary heartbeat and the atomic boot claim (#279 DF-06) ──────

const WINDOW_MS = PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS;
const SWITCH_START_MS = 10 * WINDOW_MS;

function plannerWorkload(
  id: string,
  profiles: string[],
  state: PlannerWorkload["state"],
): PlannerWorkload {
  return { id, profiles, state, expectedMemoryGiB: 16 };
}

// Three victims and two replacements: five stop/start steps, plus three
// fences and three drains when a lease registry is in play.
function multiStepPlan(): OkPlan {
  const plan = planProfileSwitch({
    node: "n1",
    to: "interactive",
    budgetGiB: 64,
    groups: [],
    workloads: [
      plannerWorkload("v-a", ["maintenance"], "ready"),
      plannerWorkload("v-b", ["maintenance"], "ready"),
      plannerWorkload("v-c", ["maintenance"], "ready"),
      plannerWorkload("r-x", ["interactive"], "downloaded"),
      plannerWorkload("r-y", ["interactive"], "downloaded"),
    ],
    nowMs: SWITCH_START_MS,
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok || plan.noop) {
    throw new Error("expected an ok, non-noop plan");
  }
  expect(plan.victims).toHaveLength(3);
  expect(plan.replacements).toHaveLength(2);
  return plan;
}

type LiveSwitch = {
  store: BootRecoveryStore;
  operation: ProfileSwitchOperationOpts;
  logs: string[];
};

// A switch as a CLI apply-profile runs it: its own handle, claimed under the
// apply-profile owner, with a fake clock.
function liveSwitch(clock: { now: number }): LiveSwitch {
  const store = openResidencyOperationStore({ path });
  trackedStores.push(store);
  const fence = store.claimOwnership({
    ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
    incarnation: "cli",
  });
  const logs: string[] = [];
  return {
    store,
    logs,
    operation: {
      store,
      fenceToken: fence.fenceToken,
      operationId: "op-live",
      desiredRevision: 1,
      nowMs: () => clock.now,
      log: (line): void => {
        logs.push(line);
      },
    },
  };
}

const REGISTRY_CASES: [string, () => ResidencyLeases | null][] = [
  ["stop/start only", (): ResidencyLeases | null => null],
  ["fenced with a lease registry", (): ResidencyLeases | null => createResidencyLeases()],
];

describe("profile-switch step heartbeat against boot recovery (#279 DF-06)", () => {
  // Kills H1: without a heartbeat the row keeps its begin stamp, so the boot
  // run inside the second step (40 minutes after begin) sees no progress for
  // longer than the window and terminalizes the live switch.
  for (const [label, makeRegistry] of REGISTRY_CASES) {
    test(`a long switch of short steps is never recovered by a boot between steps (${label})`, async () => {
      const recover = await loadBootRecovery();
      const clock = { now: SWITCH_START_MS };
      const live = liveSwitch(clock);
      const stepMs = Math.floor((WINDOW_MS * 2) / 3);
      const boots: BootRecoverySummary[] = [];
      const step = (): Promise<{ ok: true }> => {
        clock.now += stepMs;
        boots.push(
          recover({
            path,
            incarnation: `boot-${String(boots.length)}`,
            nowMs: () => clock.now,
            write: () => undefined,
          }),
        );
        return Promise.resolve({ ok: true });
      };

      const report = await executeProfileSwitch(
        multiStepPlan(),
        { stop: step, start: step },
        { dryRun: false, registry: makeRegistry(), operation: live.operation },
      );

      expect(clock.now - SWITCH_START_MS).toBeGreaterThan(3 * WINDOW_MS);
      expect(boots.map((boot) => boot.status)).toEqual(
        Array<BootRecoverySummary["status"]>(5).fill("deferred"),
      );
      expect(boots.map((boot) => boot.possiblyLive)).toEqual(Array<number>(5).fill(1));
      expect(report.outcome).toBe("stops-and-starts-ran");
      expect(report.operation).toEqual({ id: "op-live", outcome: "succeeded", recorded: true });
      expect(currentFence()?.incarnation).toBe("cli");
      expect(live.logs).toEqual([]);
    });
  }

  // The remaining limit, pinned: one step longer than the window leaves no
  // boundary to heartbeat at, so a boot inside it recovers the row.
  test("a row with no step progress past the window is recovered", async () => {
    const recover = await loadBootRecovery();
    const clock = { now: SWITCH_START_MS };
    const live = liveSwitch(clock);
    const boots: BootRecoverySummary[] = [];
    let first = true;
    const step = (): Promise<{ ok: true }> => {
      if (first) {
        first = false;
        clock.now += WINDOW_MS + 60_000;
        boots.push(
          recover({ path, incarnation: "boot", nowMs: () => clock.now, write: () => undefined }),
        );
      }
      return Promise.resolve({ ok: true });
    };

    const report = await executeProfileSwitch(
      multiStepPlan(),
      { stop: step, start: step },
      { dryRun: false, registry: null, operation: live.operation },
    );

    expect(boots).toEqual([
      {
        status: "recovered",
        recovered: 1,
        recordFailures: 0,
        skipped: 0,
        unrecognized: 0,
        possiblyLive: 0,
      },
    ]);
    expect(currentFence()).toMatchObject({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "boot",
    });
    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.operation).toEqual({
      id: "op-live",
      outcome: "succeeded",
      recorded: false,
      recordFailure: "stale-fence",
    });
    expect(live.store.getOperation("op-live")?.detail).toBe(
      "recovered: interrupted-unverified (was pending)",
    );
  });

  // Kills H2: a heartbeat that ignores the fence refreshes the row after a
  // newer owner claimed, and reports nothing.
  test("a heartbeat under a stale fence fails quietly and the switch carries on", async () => {
    const clock = { now: SWITCH_START_MS };
    const live = liveSwitch(clock);
    const calls: string[] = [];
    let claimed = false;
    const step =
      (label: string) =>
      (workload: string): Promise<{ ok: true }> => {
        calls.push(`${label}:${workload}`);
        clock.now += 1_000;
        if (!claimed) {
          claimed = true;
          const other = openResidencyOperationStore({ path });
          try {
            other.claimOwnership({ ownerId: "someone-else", incarnation: "x" });
          } finally {
            other.close();
          }
        }
        return Promise.resolve({ ok: true });
      };

    const report = await executeProfileSwitch(
      multiStepPlan(),
      { stop: step("stop"), start: step("start") },
      { dryRun: false, registry: null, operation: live.operation },
    );

    expect(calls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x", "start:r-y"]);
    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(report.operation).toEqual({
      id: "op-live",
      outcome: "succeeded",
      recorded: false,
      recordFailure: "stale-fence",
    });
    expect(live.logs).toEqual(
      Array<string>(5).fill("[residency] profile-switch heartbeat failed: stale-fence\n"),
    );
    const row = live.store.getOperation("op-live");
    expect(row?.phase).toBe("pending");
    expect(row?.updatedAtMs).toBe(SWITCH_START_MS);
  });

  test("a throwing heartbeat is logged and never aborts the switch", async () => {
    const clock = { now: SWITCH_START_MS };
    const live = liveSwitch(clock);
    const operation: ProfileSwitchOperationOpts = {
      ...live.operation,
      store: {
        beginOperation: (input) => live.store.beginOperation(input),
        finishOperation: (input) => live.store.finishOperation(input),
        listNonterminal: () => live.store.listNonterminal(),
        touchOperation: () => {
          throw new Error("SQLITE_BUSY: database is locked\nsecond line");
        },
      },
      log: (line) => {
        live.logs.push(line);
        throw new Error("log sink down");
      },
    };
    const step = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });

    const report = await executeProfileSwitch(
      multiStepPlan(),
      { stop: step, start: step },
      { dryRun: false, registry: null, operation },
    );

    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.operation).toEqual({ id: "op-live", outcome: "succeeded", recorded: true });
    expect(live.logs).toEqual(
      Array<string>(5).fill(
        "[residency] profile-switch heartbeat failed: threw: SQLITE_BUSY: database is locked\n",
      ),
    );
  });
});

describe("boot recovery claim atomicity (#279 DF-06)", () => {
  // Kills T1: with the re-check and the claim as separate statements, a CLI
  // can claim and begin a switch between them. Boot then claims over it and
  // stale-fences the live switch. Inside one IMMEDIATE transaction the CLI's
  // write is held off until boot is done.
  test("a CLI claim cannot slip in between the boot re-check and its claim", async () => {
    const recover = await loadBootRecovery();
    seedCrashRow();

    const cli: { attempted: boolean; fence: number | null; error: string } = {
      attempted: false,
      fence: null,
      error: "",
    };
    const cliClaimsAndBegins = (storePath: string): void => {
      if (cli.attempted) {
        return;
      }
      cli.attempted = true;
      try {
        const cliStore = openResidencyOperationStore({ path: storePath, busyTimeoutMs: 20 });
        try {
          const fence = cliStore.claimOwnership({ ownerId: "cli", incarnation: "c1" });
          const begun = cliStore.beginOperation({
            fenceToken: fence.fenceToken,
            operationId: "op-cli",
            model: "profile-switch:n2",
            targetState: "profile:interactive",
            desiredRevision: 1,
            reservationGiB: 0,
            nowMs: Date.now(),
          });
          expect(begun.ok).toBe(true);
          cli.fence = fence.fenceToken;
        } finally {
          cliStore.close();
        }
      } catch (error: unknown) {
        cli.error = error instanceof Error ? error.message : String(error);
      }
    };

    const summary = recover({
      path,
      incarnation: "i2",
      write: () => undefined,
      openStore: (storePath) => {
        const real = openResidencyOperationStore({ path: storePath });
        const realClaim = real.claimOwnership;
        real.claimOwnership = (input): ReturnType<typeof realClaim> => {
          cliClaimsAndBegins(storePath);
          return realClaim(input);
        };
        const realClaimWhen = real.claimOwnershipWhen;
        real.claimOwnershipWhen = (input, decide): ReturnType<typeof realClaimWhen> =>
          realClaimWhen(input, (rows) => {
            const yes = decide(rows);
            cliClaimsAndBegins(storePath);
            return yes;
          });
        return real;
      },
    });

    expect(cli.attempted).toBe(true);
    // Either the CLI was held off, or (had it got in first) boot must have
    // seen its fresh row and left its fence alone.
    if (cli.fence !== null) {
      expect(currentFence()?.fenceToken).toBe(cli.fence);
    } else {
      expect(cli.error).toMatch(/locked|busy/i);
    }
    expect(summary.status).toBe("recovered");
    expect(nonterminalIds()).toEqual([]);
  });
});
