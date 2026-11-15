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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { existsSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";

const BOOT_MODULE = "../../src/residency/boot-recovery.js" as string;

// ── runProfileSwitchBootRecovery contract (declared loose, RED) ────────

type BootRecoverySummary = {
  status: "absent" | "clean" | "recovered" | "failed";
  recovered: number;
  recordFailures: number;
  skipped: number;
  unrecognized: number;
};

type BootRecoveryStore = ReturnType<typeof openResidencyOperationStore>;

type BootRecoveryOpts = {
  path: string;
  ownerId: string;
  incarnation: string;
  nowMs?: () => number;
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
};

// Leaves the same pending `profile-switch:<node>` row a crashed switch
// would have begun: claim as agent/i1, begin, close — the leftover the
// next incarnation's boot pass must recover.
function seedCrashRow(row: SeedRow = {}): void {
  const store = openResidencyOperationStore({ path });
  try {
    const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i1" });
    const operationId = row.operationId ?? "op-crash";
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId,
      model: row.model ?? "profile-switch:n1",
      targetState: row.targetState ?? "profile:interactive",
      desiredRevision: row.desiredRevision ?? 1,
      reservationGiB: 0,
      nowMs: 1,
    });
    if (!begun.ok) {
      throw new Error(`seed beginOperation(${operationId}) refused: ${begun.reason}`);
    }
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
      ownerId: "agent",
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
      ownerId: "agent",
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
      ownerId: "agent",
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
      ownerId: "agent",
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
      ownerId: "agent",
      incarnation: "i2",
      write: (line) => {
        writes.push(line);
      },
    });

    expect(summary.unrecognized).toBe(1);
    expect(summary.status).toBe("recovered");
    expect(writes.some((line) => line.includes('"unrecognized":1'))).toBe(true);
    expect(nonterminalIds()).toEqual(["op-bad-target"]);
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
      ownerId: "agent",
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
});
