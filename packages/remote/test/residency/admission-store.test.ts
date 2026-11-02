/**
 * RED contract tests for the target-owned admission store (plan v3 —
 * "Ordered RED/GREEN work packages", "Store" item).
 *
 * Naming vs plan/dispatch:
 * - `claim` is the plan's `claimIfFits`; `commitResident` is `commitReady`
 *   (pending→resident only, matching the v3 "uncertain is absorbing" edit).
 *   `recordLaunch` belongs to the authority lifecycle package
 *   (admission-authority.test.ts), not this store contract.
 * - Race-case numbers follow the plan's "budget24 with12+16 incoming": two
 *   incoming claims of 12 and 16 GiB race. The dispatch memo's "existing
 *   claim 12, both claim 16" can never admit a 16 GiB claim under a 24 GiB
 *   budget, which would make "exactly one admitted" unreachable for a
 *   correct implementation.
 * - claim() reports a busy/locked store as {kind:"refuse",
 *   reason:"AuthorityUnavailable"} — refused before effects; only open()
 *   throws AuthorityUnavailableError for a corrupt/unreadable file.
 * - fenceToken is a CAS credential bound to (claimId, ownerEpoch,
 *   generationVersion); every successful transition rotates it, so a stale
 *   token is rejected without mutation.
 * - Ownership (plan v3 "Atomic claim and lifecycle contract"): a plain
 *   open — with or without an owner — never rotates the epoch and never
 *   sweeps pending rows; an owning open only stakes a vacant ledger.
 *   recoverOwnership is the sole epoch rotation and orphan sweep, and it
 *   runs only when the caller has verified the previous owner gone or the
 *   ledger has no recorded owner; a recorded owner not proven gone
 *   refuses OwnerLive/OwnerUnknown and changes nothing.
 * - Generations persist keyed by claim_id: recordGeneration appends under
 *   the fence check without rotating the token, generationsOf reads them
 *   back oldest-first, releaseVerified deletes them with the claim, and a
 *   plain reopen or owner recovery keeps them. A ledger file created
 *   before the generations table existed migrates on open.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaimJob } from "./claim-worker.js";

import {
  type AdmissionStore,
  AuthorityUnavailableError,
  type ClaimResult,
  type ClaimRow,
  type GenerationRecord,
  openAdmissionStore,
  type OwnerIdentity,
  type RecoverOwnershipResult,
  type ReleaseEvidence,
} from "../../src/residency/admission-store.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const workerUrl = new URL("./claim-worker.ts", import.meta.url);

const evidence: ReleaseEvidence = { verification: "runtime-absent" };

interface TempDb {
  dir: string;
  path: string;
  cleanup: () => void;
}

const tempDb = (): TempDb => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-admission-store-"));
  return {
    dir,
    path: join(dir, "admission.db"),
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

// open() itself must not throw for a healthy path; asserting here keeps a
// not-implemented or broken open as an assertion failure, not a crash.
const openStore = (path: string, busyTimeoutMs?: number, owner?: OwnerIdentity): AdmissionStore => {
  let store: AdmissionStore | undefined;
  let threw: unknown;
  try {
    store = openAdmissionStore({ path, busyTimeoutMs, owner });
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeUndefined();
  if (store === undefined) {
    throw new Error("openAdmissionStore returned no store");
  }
  return store;
};

// Same not-implemented-to-assertion wrapping as openStore.
const recover = (
  store: AdmissionStore,
  owner: OwnerIdentity,
  previousOwnerGone: boolean,
): RecoverOwnershipResult => {
  let result: RecoverOwnershipResult | undefined;
  let threw: unknown;
  try {
    result = store.recoverOwnership(owner, previousOwnerGone);
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeUndefined();
  if (result === undefined) {
    throw new Error("recoverOwnership returned no result");
  }
  return result;
};

const ownerOf = (store: AdmissionStore): OwnerIdentity | undefined => {
  let result: OwnerIdentity | undefined;
  let threw: unknown;
  try {
    result = store.recordedOwner();
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeUndefined();
  return result;
};

const row = (store: AdmissionStore, claimId: string): ClaimRow | undefined =>
  store.snapshot().find((r) => r.claimId === claimId);

// Same not-implemented-to-assertion wrapping as openStore.
const recordGen = (
  store: AdmissionStore,
  claimId: string,
  fenceToken: string,
  generation: GenerationRecord,
): boolean => {
  let result: boolean | undefined;
  let threw: unknown;
  try {
    result = store.recordGeneration(claimId, fenceToken, generation);
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeUndefined();
  return result === true;
};

// Same not-implemented-to-assertion wrapping as openStore.
const generationsOf = (store: AdmissionStore, claimId: string): readonly GenerationRecord[] => {
  let result: readonly GenerationRecord[] | undefined;
  let threw: unknown;
  try {
    result = store.generationsOf(claimId);
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeUndefined();
  return result ?? [];
};

interface ClaimOutcome {
  tag: string;
  message?: string;
  result?: { kind: string; claimId?: string; reason?: string; committedGiB?: number };
}

// One-shot message pump. Terminal replies ("done"/"failed") replay for every
// later recv so a worker that died early fails the assertions instead of
// hanging the test.
const workerChannel = (worker: Worker): { recv: (timeoutMs: number) => Promise<ClaimOutcome> } => {
  const queue: ClaimOutcome[] = [];
  const waiters: ((m: ClaimOutcome) => void)[] = [];
  let terminal: ClaimOutcome | null = null;
  const push = (msg: ClaimOutcome): void => {
    if (msg.tag === "done" || msg.tag === "failed") {
      terminal = msg;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      queue.push(msg);
    }
  };
  worker.onmessage = (ev): void => {
    push(ev.data as ClaimOutcome);
  };
  worker.onerror = (ev): void => {
    const detail = (ev as { message?: unknown }).message;
    push({
      tag: "failed",
      message: `worker error: ${typeof detail === "string" ? detail : "unknown"}`,
    });
  };
  const recv = (timeoutMs: number): Promise<ClaimOutcome> => {
    if (terminal !== null) {
      return Promise.resolve(terminal);
    }
    const queued = queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ tag: "failed", message: `timed out after ${String(timeoutMs)} ms` });
      }, timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  return { recv };
};

describe("admission-store", () => {
  test("two connections racing 12GiB and 16GiB claims against budget 24 admit exactly one", async () => {
    const t = tempDb();
    const workers: Worker[] = [];
    let lockDb: Database | null = null;
    try {
      openStore(t.path).close();
      const jobs: ClaimJob[] = [
        {
          path: t.path,
          busyTimeoutMs: 3000,
          input: {
            runtimeKey: "race-a",
            specDigest: "d-a",
            kind: "ModelRun",
            allocationGiB: 12,
            budgetGiB: 24,
          },
        },
        {
          path: t.path,
          busyTimeoutMs: 3000,
          input: {
            runtimeKey: "race-b",
            specDigest: "d-b",
            kind: "ModelHost",
            allocationGiB: 16,
            budgetGiB: 24,
          },
        },
      ];
      const channels = jobs.map((job) => {
        const w = new Worker(workerUrl);
        workers.push(w);
        w.postMessage(job);
        return workerChannel(w);
      });
      // Both connections must be live before the write lock is taken so
      // the two claim transactions genuinely contend on the same file.
      for (const ch of channels) {
        await ch.recv(10_000);
      }
      lockDb = new Database(t.path);
      lockDb.run("BEGIN IMMEDIATE");
      for (const w of workers) {
        w.postMessage("go");
      }
      for (const ch of channels) {
        await ch.recv(10_000);
      }
      // Both claims are now parked inside their transaction boundary (or,
      // under a read/insert-split implementation, have already read); the
      // release point is shared.
      await Bun.sleep(150);
      lockDb.run("COMMIT");
      lockDb.close();
      lockDb = null;
      const outcomes: ClaimOutcome[] = [];
      for (const ch of channels) {
        outcomes.push(await ch.recv(10_000));
      }
      const admitted = outcomes.filter((o) => o.tag === "done" && o.result?.kind === "admitted");
      const refused = outcomes.filter((o) => o.tag === "done" && o.result?.kind === "refuse");
      expect(admitted.length).toBe(1);
      expect(refused.length).toBe(1);
      expect(refused[0]?.result?.reason).toBe("BudgetExceeded");
      expect(admitted[0]?.result?.committedGiB).toBeLessThanOrEqual(24);
      const verify = openStore(t.path);
      try {
        const rows = verify.snapshot();
        expect(rows.length).toBe(1);
        expect(rows.reduce((s, r) => s + r.allocationGiB, 0)).toBeLessThanOrEqual(24);
      } finally {
        verify.close();
      }
    } finally {
      for (const w of workers) {
        w.terminate();
      }
      lockDb?.close();
      t.cleanup();
    }
  }, 30_000);

  test("CAS with a stale fence token fails and does not change the row", () => {
    const t = tempDb();
    const store = openStore(t.path);
    try {
      const claim = store.claim({
        runtimeKey: "w-a",
        specDigest: "d1",
        kind: "ModelRun",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      expect(claim.kind).toBe("admitted");
      if (claim.kind !== "admitted") {
        throw new Error("claim was not admitted");
      }
      const stale = claim.fenceToken;
      expect(store.commitResident(claim.claimId, "bogus-fence-token")).toBe(false);
      expect(row(store, claim.claimId)?.state).toBe("pending");
      expect(store.commitResident(claim.claimId, stale)).toBe(true);
      const rotated = row(store, claim.claimId)?.fenceToken;
      expect(row(store, claim.claimId)?.state).toBe("resident");
      expect(rotated).not.toBe(stale);
      expect(store.commitResident(claim.claimId, stale)).toBe(false);
      expect(store.markUncertain(claim.claimId, stale)).toBe(false);
      expect(store.releaseVerified(claim.claimId, stale, evidence)).toBe(false);
      expect(row(store, claim.claimId)?.state).toBe("resident");
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("same key+digest across connections joins pending and does not double-charge", () => {
    const t = tempDb();
    const a = openStore(t.path);
    const b = openStore(t.path);
    try {
      const first = a.claim({
        runtimeKey: "w-join",
        specDigest: "dg",
        kind: "ModelRun",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      expect(first.kind).toBe("admitted");
      const second = b.claim({
        runtimeKey: "w-join",
        specDigest: "dg",
        kind: "ModelRun",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      expect(second.kind).toBe("join-pending");
      if (first.kind === "admitted" && second.kind === "join-pending") {
        expect(second.claimId).toBe(first.claimId);
      }
      const rows = b.snapshot().filter((r) => r.runtimeKey === "w-join");
      expect(rows.length).toBe(1);
      expect(rows.reduce((s, r) => s + r.allocationGiB, 0)).toBe(8);
    } finally {
      a.close();
      b.close();
      t.cleanup();
    }
  });

  test("a plain reopen keeps the epoch, the authorityId and pending rows pending", () => {
    const t = tempDb();
    const first = openStore(t.path);
    const resident = first.claim({
      runtimeKey: "w-res",
      specDigest: "d1",
      kind: "ModelRun",
      allocationGiB: 4,
      budgetGiB: 24,
    });
    if (resident.kind !== "admitted") {
      throw new Error("resident claim not admitted");
    }
    expect(first.commitResident(resident.claimId, resident.fenceToken)).toBe(true);
    const pending = first.claim({
      runtimeKey: "w-pend",
      specDigest: "d2",
      kind: "ModelHost",
      allocationGiB: 4,
      budgetGiB: 24,
    });
    if (pending.kind !== "admitted") {
      throw new Error("pending claim not admitted");
    }
    const id1 = first.authorityId();
    const epoch1 = first.epoch();
    first.close();
    const second = openStore(t.path);
    try {
      expect(second.authorityId()).toBe(id1);
      expect(second.epoch()).toBe(epoch1);
      const rows = second.snapshot();
      expect(rows.find((r) => r.runtimeKey === "w-pend")?.state).toBe("pending");
      expect(rows.find((r) => r.runtimeKey === "w-res")?.state).toBe("resident");
      // A still-pending row remains joinable from a third connection.
      const third = openStore(t.path);
      try {
        const joined = third.claim({
          runtimeKey: "w-pend",
          specDigest: "d2",
          kind: "ModelHost",
          allocationGiB: 4,
          budgetGiB: 24,
        });
        expect(joined.kind).toBe("join-pending");
        if (joined.kind === "join-pending") {
          expect(joined.claimId).toBe(pending.claimId);
        }
      } finally {
        third.close();
      }
    } finally {
      second.close();
      t.cleanup();
    }
  });

  test("recoverOwnership on a store with no recorded owner records it, rotates the epoch once and sweeps pending", () => {
    const t = tempDb();
    const owner = { pid: 6101, startTimeMs: 5000 };
    const first = openStore(t.path);
    const pending = first.claim({
      runtimeKey: "w-pend",
      specDigest: "d2",
      kind: "ModelHost",
      allocationGiB: 4,
      budgetGiB: 24,
    });
    if (pending.kind !== "admitted") {
      throw new Error("pending claim not admitted");
    }
    const epoch1 = first.epoch();
    first.close();
    const store = openStore(t.path);
    try {
      expect(store.epoch()).toBe(epoch1);
      expect(ownerOf(store)).toBeUndefined();
      expect(row(store, pending.claimId)?.state).toBe("pending");
      const result = recover(store, owner, false);
      expect(result.kind).toBe("recovered");
      if (result.kind === "recovered") {
        expect(result.epoch).toBe(epoch1 + 1);
      }
      expect(store.epoch()).toBe(epoch1 + 1);
      const recorded = ownerOf(store);
      expect(recorded?.pid).toBe(owner.pid);
      expect(recorded?.startTimeMs).toBe(owner.startTimeMs);
      const swept = row(store, pending.claimId);
      expect(swept?.state).toBe("uncertain");
      expect(swept?.fenceToken).not.toBe(pending.fenceToken);
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("recoverOwnership against a recorded owner without previousOwnerGone refuses OwnerLive and changes nothing", () => {
    const t = tempDb();
    const ownerA = { pid: 6201, startTimeMs: 100 };
    const ownerB = { pid: 6202, startTimeMs: 200 };
    // An owning open stakes the vacant ledger — without rotating or
    // sweeping: the pending row stays pending under ownerA's epoch.
    const owning = openStore(t.path, undefined, ownerA);
    const epoch1 = owning.epoch();
    const pending = owning.claim({
      runtimeKey: "w-pend",
      specDigest: "d2",
      kind: "ModelHost",
      allocationGiB: 4,
      budgetGiB: 24,
    });
    if (pending.kind !== "admitted") {
      throw new Error("pending claim not admitted");
    }
    expect(ownerOf(owning)?.pid).toBe(ownerA.pid);
    expect(row(owning, pending.claimId)?.state).toBe("pending");
    const second = openStore(t.path);
    try {
      expect(second.epoch()).toBe(epoch1);
      const result = recover(second, ownerB, false);
      expect(result.kind).toBe("refused");
      if (result.kind === "refused") {
        expect(result.reason).toBe("OwnerLive");
      }
      expect(second.epoch()).toBe(epoch1);
      expect(ownerOf(second)?.pid).toBe(ownerA.pid);
      const still = row(second, pending.claimId);
      expect(still?.state).toBe("pending");
      expect(still?.fenceToken).toBe(pending.fenceToken);
    } finally {
      second.close();
      owning.close();
      t.cleanup();
    }
  });

  test("recoverOwnership with previousOwnerGone takes over: records the new owner, rotates the epoch and sweeps", () => {
    const t = tempDb();
    const ownerA = { pid: 6301, startTimeMs: 100 };
    const ownerB = { pid: 6302, startTimeMs: 200 };
    const owning = openStore(t.path, undefined, ownerA);
    const epoch1 = owning.epoch();
    const pending = owning.claim({
      runtimeKey: "w-pend",
      specDigest: "d2",
      kind: "ModelHost",
      allocationGiB: 4,
      budgetGiB: 24,
    });
    if (pending.kind !== "admitted") {
      throw new Error("pending claim not admitted");
    }
    owning.close();
    const store = openStore(t.path);
    try {
      expect(store.epoch()).toBe(epoch1);
      expect(ownerOf(store)?.pid).toBe(ownerA.pid);
      expect(row(store, pending.claimId)?.state).toBe("pending");
      const result = recover(store, ownerB, true);
      expect(result.kind).toBe("recovered");
      if (result.kind === "recovered") {
        expect(result.epoch).toBe(epoch1 + 1);
      }
      expect(store.epoch()).toBe(epoch1 + 1);
      expect(ownerOf(store)?.pid).toBe(ownerB.pid);
      const swept = row(store, pending.claimId);
      expect(swept?.state).toBe("uncertain");
      expect(swept?.fenceToken).not.toBe(pending.fenceToken);
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("uncertain rows remain charged after recovery", () => {
    const t = tempDb();
    const first = openStore(t.path);
    const orphan = first.claim({
      runtimeKey: "w-u",
      specDigest: "d",
      kind: "ModelRun",
      allocationGiB: 8,
      budgetGiB: 24,
    });
    if (orphan.kind !== "admitted") {
      throw new Error("orphan claim not admitted");
    }
    first.close();
    const store = openStore(t.path);
    try {
      // A plain open leaves the orphan pending; recovery converts it.
      expect(row(store, orphan.claimId)?.state).toBe("pending");
      expect(recover(store, { pid: 6501 }, true).kind).toBe("recovered");
      expect(row(store, orphan.claimId)?.state).toBe("uncertain");
      const over = store.claim({
        runtimeKey: "w-2",
        specDigest: "d2",
        kind: "ModelHost",
        allocationGiB: 20,
        budgetGiB: 24,
      });
      expect(over.kind).toBe("refuse");
      if (over.kind === "refuse") {
        expect(over.reason).toBe("BudgetExceeded");
      }
      const fit = store.claim({
        runtimeKey: "w-3",
        specDigest: "d3",
        kind: "ModelHost",
        allocationGiB: 16,
        budgetGiB: 24,
      });
      expect(fit.kind).toBe("admitted");
      expect(store.snapshot().reduce((s, r) => s + r.allocationGiB, 0)).toBe(24);
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("mutating a snapshot does not change stored rows", () => {
    const t = tempDb();
    const store = openStore(t.path);
    try {
      const c = store.claim({
        runtimeKey: "w-s",
        specDigest: "d",
        kind: "ModelRun",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      if (c.kind !== "admitted") {
        throw new Error("claim not admitted");
      }
      const snap = row(store, c.claimId);
      expect(snap?.state).toBe("pending");
      if (!snap) {
        throw new Error("row missing from snapshot");
      }
      snap.state = "resident";
      snap.allocationGiB = 0;
      snap.fenceToken = "forged";
      const after = row(store, c.claimId);
      expect(after?.state).toBe("pending");
      expect(after?.allocationGiB).toBe(8);
      expect(after?.fenceToken).toBe(c.fenceToken);
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("corrupt or unreadable database throws AuthorityUnavailableError on open", () => {
    const t = tempDb();
    try {
      writeFileSync(t.path, "this is not a sqlite database — it fails the header check");
      expect(() => openAdmissionStore({ path: t.path })).toThrow(AuthorityUnavailableError);
      expect(() => openAdmissionStore({ path: t.dir })).toThrow(AuthorityUnavailableError);
      expect(() => openAdmissionStore({ path: join(t.dir, "missing", "db.sqlite") })).toThrow(
        AuthorityUnavailableError,
      );
    } finally {
      t.cleanup();
    }
  });

  test("write lock contention surfaces as a typed refusal, not a crash", () => {
    const t = tempDb();
    const store = openStore(t.path, 75);
    const lock = new Database(t.path);
    lock.run("BEGIN IMMEDIATE");
    try {
      let result: ClaimResult | undefined;
      let threw: unknown;
      try {
        result = store.claim({
          runtimeKey: "w-busy",
          specDigest: "d-b",
          kind: "ModelRun",
          allocationGiB: 4,
          budgetGiB: 24,
        });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeUndefined();
      expect(result?.kind).toBe("refuse");
      if (result?.kind === "refuse") {
        expect(result.reason).toBe("AuthorityUnavailable");
      }
      expect(store.snapshot().length).toBe(0);
    } finally {
      lock.run("ROLLBACK");
      lock.close();
      store.close();
      t.cleanup();
    }
  });

  test("releaseVerified removes only the exact fenced claim", () => {
    const t = tempDb();
    const store = openStore(t.path);
    try {
      const a = store.claim({
        runtimeKey: "w-1",
        specDigest: "d1",
        kind: "ModelRun",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      const b = store.claim({
        runtimeKey: "w-2",
        specDigest: "d2",
        kind: "ModelHost",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      if (a.kind !== "admitted" || b.kind !== "admitted") {
        throw new Error("claims not admitted");
      }
      expect(store.releaseVerified(b.claimId, a.fenceToken, evidence)).toBe(false);
      expect(store.releaseVerified(a.claimId, "bogus-fence-token", evidence)).toBe(false);
      expect(store.snapshot().length).toBe(2);
      expect(store.releaseVerified(a.claimId, a.fenceToken, evidence)).toBe(true);
      expect(store.releaseVerified(a.claimId, a.fenceToken, evidence)).toBe(false);
      const rows = store.snapshot();
      expect(rows.length).toBe(1);
      expect(rows[0]?.claimId).toBe(b.claimId);
      expect(rows[0]?.state).toBe("pending");
      expect(rows.reduce((s, r) => s + r.allocationGiB, 0)).toBe(8);
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("recovery gives every swept claim its own fence token", () => {
    const t = tempDb();
    const store = openStore(t.path, undefined, { pid: 6401, startTimeMs: 40 });
    try {
      const w1 = store.claim({
        runtimeKey: "w1",
        specDigest: "d1",
        kind: "ModelRun",
        allocationGiB: 4,
        budgetGiB: 24,
      });
      const w2 = store.claim({
        runtimeKey: "w2",
        specDigest: "d2",
        kind: "ModelHost",
        allocationGiB: 4,
        budgetGiB: 24,
      });
      if (w1.kind !== "admitted" || w2.kind !== "admitted") {
        throw new Error("claims not admitted");
      }
      const rowA = row(store, w1.claimId);
      const rowB = row(store, w2.claimId);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      if (!rowA || !rowB) {
        throw new Error("rows missing from snapshot");
      }
      const preCloseA = rowA.fenceToken;
      const preCloseB = rowB.fenceToken;
      store.close();
      const reopened = openStore(t.path);
      try {
        // A plain open sweeps nothing — recovery is what converts them.
        expect(reopened.snapshot().every((r) => r.state === "pending")).toBe(true);
        recover(reopened, { pid: 6402, startTimeMs: 80 }, true);
        const snap = reopened.snapshot();
        const afterA = snap.find((r) => r.claimId === w1.claimId);
        const afterB = snap.find((r) => r.claimId === w2.claimId);
        expect(afterA).toBeDefined();
        expect(afterB).toBeDefined();
        if (!afterA || !afterB) {
          throw new Error("rows missing after reopen");
        }
        expect(afterA.state).toBe("uncertain");
        expect(afterB.state).toBe("uncertain");
        expect(afterA.fenceToken).not.toBe(preCloseA);
        expect(afterB.fenceToken).not.toBe(preCloseB);
        expect(afterA.fenceToken).not.toBe(afterB.fenceToken);
        const evidence: ReleaseEvidence = { verification: "runtime-absent" };
        const crossRelease = reopened.releaseVerified(afterB.claimId, afterA.fenceToken, evidence);
        expect(crossRelease).toBe(false);
        const stillThere = reopened.snapshot().find((r) => r.claimId === afterB.claimId);
        expect(stillThere).toBeDefined();
        expect(stillThere?.state).toBe("uncertain");
        const ownRelease = reopened.releaseVerified(afterB.claimId, afterB.fenceToken, evidence);
        expect(ownRelease).toBe(true);
        const afterOwnRelease = reopened.snapshot().find((r) => r.claimId === afterB.claimId);
        expect(afterOwnRelease).toBeUndefined();
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("a fresh store stamps application_id and user_version", () => {
    const t = tempDb();
    const store = openStore(t.path);
    store.close();
    const rawDb = new Database(t.path);
    try {
      const application_id =
        rawDb.query<{ application_id: number }, []>("PRAGMA application_id").get()
          ?.application_id ?? 0;
      const user_version =
        rawDb.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      expect(application_id).toBe(0x4c4d4144);
      expect(user_version).toBe(1);
    } finally {
      rawDb.close();
      t.cleanup();
    }
  });

  test("a foreign sqlite file is refused with AuthorityUnavailableError", () => {
    const t = tempDb();
    const rawDb = new Database(t.path);
    try {
      rawDb.run("CREATE TABLE other(x)");
      rawDb.close();
      expect(() => openAdmissionStore({ path: t.path })).toThrow(AuthorityUnavailableError);
      const verify = new Database(t.path);
      try {
        const row = verify.query<{ application_id: number }, []>("PRAGMA application_id").get();
        expect(row?.application_id ?? 0).toBe(0);
        const tables = verify
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all();
        expect(tables.some((t) => t.name === "other")).toBe(true);
      } finally {
        verify.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("a newer schema version is refused", () => {
    const t = tempDb();
    const store = openStore(t.path);
    store.close();
    const rawDb = new Database(t.path);
    try {
      rawDb.run("PRAGMA user_version = 2");
      rawDb.close();
      expect(() => openAdmissionStore({ path: t.path })).toThrow(AuthorityUnavailableError);
      const verify = new Database(t.path);
      try {
        const row = verify.query<{ user_version: number }, []>("PRAGMA user_version").get();
        expect(row?.user_version ?? 0).toBe(2);
      } finally {
        verify.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("recordGeneration appends persisted evidence under the fence token without rotating it", () => {
    const t = tempDb();
    const store = openStore(t.path);
    try {
      const c = store.claim({
        runtimeKey: "w-gen",
        specDigest: "d",
        kind: "ModelRun",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      if (c.kind !== "admitted") {
        throw new Error("claim not admitted");
      }
      // An unknown claim and a stale token both refuse and write nothing.
      expect(recordGen(store, "no-such-claim", c.fenceToken, { pid: 5100 })).toBe(false);
      expect(recordGen(store, c.claimId, "bogus-fence-token", { pid: 5100 })).toBe(false);
      expect(generationsOf(store, c.claimId)).toEqual([]);
      expect(recordGen(store, c.claimId, c.fenceToken, { pid: 5100, startTimeMs: 10 })).toBe(true);
      expect(
        recordGen(store, c.claimId, c.fenceToken, {
          pid: 5101,
          startTimeMs: 20,
          executable: "llama-server",
        }),
      ).toBe(true);
      expect(generationsOf(store, c.claimId)).toEqual([
        { pid: 5100, startTimeMs: 10 },
        { pid: 5101, startTimeMs: 20, executable: "llama-server" },
      ]);
      // A stale token after valid appends still writes nothing.
      expect(recordGen(store, c.claimId, "bogus-fence-token", { pid: 5199 })).toBe(false);
      expect(generationsOf(store, c.claimId)).toEqual([
        { pid: 5100, startTimeMs: 10 },
        { pid: 5101, startTimeMs: 20, executable: "llama-server" },
      ]);
      // Recording never rotates the token — it still drives the next CAS.
      expect(store.commitResident(c.claimId, c.fenceToken)).toBe(true);
      // The evidence is claim-keyed, not state-keyed: readable once resident.
      expect(generationsOf(store, c.claimId)).toEqual([
        { pid: 5100, startTimeMs: 10 },
        { pid: 5101, startTimeMs: 20, executable: "llama-server" },
      ]);
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("releaseVerified deletes the claim's generation rows with the claim", () => {
    const t = tempDb();
    const store = openStore(t.path);
    try {
      const a = store.claim({
        runtimeKey: "w-ga",
        specDigest: "d1",
        kind: "ModelRun",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      const b = store.claim({
        runtimeKey: "w-gb",
        specDigest: "d2",
        kind: "ModelHost",
        allocationGiB: 8,
        budgetGiB: 24,
      });
      if (a.kind !== "admitted" || b.kind !== "admitted") {
        throw new Error("claims not admitted");
      }
      expect(recordGen(store, a.claimId, a.fenceToken, { pid: 5200, startTimeMs: 5 })).toBe(true);
      expect(recordGen(store, b.claimId, b.fenceToken, { pid: 5201, startTimeMs: 6 })).toBe(true);
      expect(store.releaseVerified(a.claimId, a.fenceToken, evidence)).toBe(true);
      expect(generationsOf(store, a.claimId)).toEqual([]);
      // Deletion is scoped to the released claim only.
      expect(generationsOf(store, b.claimId)).toEqual([{ pid: 5201, startTimeMs: 6 }]);
      expect(row(store, b.claimId)?.state).toBe("pending");
    } finally {
      store.close();
      t.cleanup();
    }
  });

  test("recorded generations survive a plain reopen and an ownership recovery", () => {
    const t = tempDb();
    const first = openStore(t.path);
    const c = first.claim({
      runtimeKey: "w-gs",
      specDigest: "d",
      kind: "ModelRun",
      allocationGiB: 8,
      budgetGiB: 24,
    });
    if (c.kind !== "admitted") {
      throw new Error("claim not admitted");
    }
    expect(recordGen(first, c.claimId, c.fenceToken, { pid: 5300, startTimeMs: 42 })).toBe(true);
    first.close();
    const second = openStore(t.path);
    try {
      expect(generationsOf(second, c.claimId)).toEqual([{ pid: 5300, startTimeMs: 42 }]);
      // No owner is recorded, so recovery proceeds — the orphan pending
      // row sweeps to uncertain and keeps its captured evidence.
      expect(recover(second, { pid: 6601, startTimeMs: 9 }, false).kind).toBe("recovered");
      expect(row(second, c.claimId)?.state).toBe("uncertain");
      expect(generationsOf(second, c.claimId)).toEqual([{ pid: 5300, startTimeMs: 42 }]);
    } finally {
      second.close();
    }
    const third = openStore(t.path);
    try {
      expect(generationsOf(third, c.claimId)).toEqual([{ pid: 5300, startTimeMs: 42 }]);
    } finally {
      third.close();
      t.cleanup();
    }
  });

  test("a ledger created before the generations table still opens and migrates", () => {
    const t = tempDb();
    // Recreate the pre-generations schema by hand — opening through
    // openAdmissionStore on this code path would already migrate, so the
    // "before" file is written directly.
    const raw = new Database(t.path);
    try {
      raw.run(`CREATE TABLE authority_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        authority_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        owner_pid INTEGER,
        owner_start_time_ms INTEGER,
        owner_executable TEXT
      )`);
      raw.run(`CREATE TABLE claims (
        claim_id TEXT PRIMARY KEY,
        runtime_key TEXT NOT NULL,
        spec_digest TEXT NOT NULL,
        kind TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'resident', 'uncertain')),
        allocation_gib REAL NOT NULL,
        owner_epoch INTEGER NOT NULL,
        generation_version INTEGER NOT NULL,
        fence_token TEXT NOT NULL
      )`);
      raw.run(
        "INSERT INTO authority_meta (id, authority_id, epoch) VALUES (1, 'legacy-authority', 1)",
      );
      raw.run(`INSERT INTO claims (claim_id, runtime_key, spec_digest, kind, state,
                                   allocation_gib, owner_epoch, generation_version, fence_token)
               VALUES ('legacy-claim', 'w-legacy', 'd', 'ModelRun', 'pending',
                       4, 1, 1, 'legacy-fence')`);
      raw.run(`PRAGMA application_id = ${String(0x4c4d4144)}`);
      raw.run("PRAGMA user_version = 1");
    } finally {
      raw.close();
    }
    const store = openStore(t.path);
    try {
      const verify = new Database(t.path);
      try {
        const tables = verify
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((r) => r.name);
        expect(tables.some((name) => /generation/i.test(name))).toBe(true);
      } finally {
        verify.close();
      }
      // The migrated ledger stays fully functional: the pre-existing row
      // is readable and the new evidence table accepts appends.
      expect(row(store, "legacy-claim")?.state).toBe("pending");
      expect(generationsOf(store, "legacy-claim")).toEqual([]);
      expect(recordGen(store, "legacy-claim", "legacy-fence", { pid: 5400, startTimeMs: 3 })).toBe(
        true,
      );
      expect(generationsOf(store, "legacy-claim")).toEqual([{ pid: 5400, startTimeMs: 3 }]);
    } finally {
      store.close();
    }
    // Reopening is idempotent — the migration does not repeat or fail.
    const reopened = openStore(t.path);
    try {
      expect(generationsOf(reopened, "legacy-claim")).toEqual([{ pid: 5400, startTimeMs: 3 }]);
    } finally {
      reopened.close();
      t.cleanup();
    }
  });
});
