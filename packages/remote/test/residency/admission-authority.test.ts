/**
 * RED contract tests for the target-owned admission authority lifecycle
 * (plan v3 — "Ordered RED/GREEN work packages", "Authority lifecycle"
 * item). One case per contract rule; all observation is injected, no
 * real processes are spawned or signaled.
 *
 * The pure generation-evidence judge (`judgeGeneration`, verdicts
 * same-generation / verified-absent / different-generation / uncertain)
 * is NOT on this base — it lives in
 * packages/core/src/residency/generation-evidence.ts on branch
 * feat/target-authority-core-policy. The stub under test declares
 * minimal local mirror types (GenerationRecord, ProcessObservation,
 * GenerationVerdict, JudgeGeneration) for the seat to wire the real
 * judge behind when the core branch merges.
 *
 * Contract notes pinned here:
 * - admit() maps the store's join-pending/already-resident onto
 *   "joined"/"resident"; refused outcomes carry the policy reason
 *   verbatim. The budget comes from the injected budgetGiB() probe on
 *   every call; undefined refuses BudgetUnknown, never unlimited.
 * - recordGeneration() validates the fence token without consuming it —
 *   the same token then drives completeReady()/failUncertain().
 * - tryRelease() is the only release path and frees a charge only on
 *   verified whole-runtime absence: every recorded generation judges
 *   verified-absent under a fresh observation, and the runtime-dir pid
 *   record is present and names a recorded generation. A vanished pid
 *   record, an unidentifiable death, a conflicting pid record, a claim
 *   with no captured generation, or a live-looking observation all
 *   retain the charge. Uncertain is absorbing — nothing repromotes it.
 * - An unreadable store still opens: the authority is degraded and every
 *   admit refuses AuthorityUnavailable — degraded, never legacy.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AdmissionAuthority,
  type AdmitRequest,
  type AuthorityClaimRow,
  openAdmissionAuthority,
  type ProcessObservation,
} from "../../src/residency/admission-authority.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

interface Harness {
  authority: AdmissionAuthority;
  observations: Map<number, ProcessObservation>;
  pidFiles: Map<string, number>;
  budget: { value: number | undefined };
  cleanup: () => void;
}

// openAdmissionAuthority must not throw for a healthy store; asserting
// here keeps a not-implemented or broken open as an assertion failure,
// not a crash.
const openAuthority = (budgetGiB: number | undefined = 24): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-admission-authority-"));
  const observations = new Map<number, ProcessObservation>();
  const pidFiles = new Map<string, number>();
  const budget = { value: budgetGiB };
  let authority: AdmissionAuthority | undefined;
  let threw: unknown;
  try {
    authority = openAdmissionAuthority({
      storePath: join(dir, "admission.db"),
      runtimeRoot: join(dir, "runtime"),
      budgetGiB: () => budget.value,
      observe: (pid) => observations.get(pid),
      readPidFile: (key) => pidFiles.get(key),
    });
  } catch (e) {
    threw = e;
  }
  if (threw !== undefined || authority === undefined) {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(threw).toBeUndefined();
  if (authority === undefined) {
    throw new Error("openAdmissionAuthority returned no authority");
  }
  return {
    authority,
    observations,
    pidFiles,
    budget,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const request = (
  runtimeKey: string,
  specDigest: string,
  kind: "ModelRun" | "ModelHost",
  allocationGiB: number,
): AdmitRequest => ({ runtimeKey, specDigest, kind, allocationGiB });

const mustAdmit = (
  authority: AdmissionAuthority,
  req: AdmitRequest,
): { claimId: string; fenceToken: string } => {
  const outcome = authority.admit(req);
  expect(outcome.kind).toBe("admitted");
  if (outcome.kind !== "admitted") {
    throw new Error(`expected admitted, got ${outcome.kind}`);
  }
  return { claimId: outcome.claimId, fenceToken: outcome.fenceToken };
};

const row = (authority: AdmissionAuthority, claimId: string): AuthorityClaimRow | undefined =>
  authority.snapshot().find((r) => r.claimId === claimId);

const chargedGiB = (authority: AdmissionAuthority): number =>
  authority.snapshot().reduce((sum, r) => sum + r.allocationGiB, 0);

describe("admission-authority", () => {
  test("admit records a pending claim and returns its claimId and fence token", () => {
    const h = openAuthority(24);
    try {
      const outcome = h.authority.admit(request("w-a", "d1", "ModelRun", 8));
      expect(outcome.kind).toBe("admitted");
      if (outcome.kind !== "admitted") {
        throw new Error("not admitted");
      }
      expect(outcome.claimId.length).toBeGreaterThan(0);
      expect(outcome.fenceToken.length).toBeGreaterThan(0);
      expect(outcome.chargedGiB).toBe(8);
      expect(outcome.committedGiB).toBe(8);
      const r = row(h.authority, outcome.claimId);
      expect(r?.state).toBe("pending");
      expect(r?.runtimeKey).toBe("w-a");
      expect(r?.specDigest).toBe("d1");
      expect(r?.kind).toBe("ModelRun");
      expect(r?.allocationGiB).toBe(8);
      expect(r?.generations).toEqual([]);
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("a second identical request joins the same claim and is not double-charged", () => {
    const h = openAuthority(24);
    try {
      const req = request("w-j", "dg", "ModelRun", 8);
      const first = h.authority.admit(req);
      const second = h.authority.admit(req);
      expect(first.kind).toBe("admitted");
      expect(second.kind).toBe("joined");
      if (first.kind === "admitted" && second.kind === "joined") {
        expect(second.claimId).toBe(first.claimId);
      }
      const rows = h.authority.snapshot().filter((r) => r.runtimeKey === "w-j");
      expect(rows.length).toBe(1);
      expect(rows.reduce((s, r) => s + r.allocationGiB, 0)).toBe(8);
      // Only 8 of 24 is charged — a different-key 16 GiB claim must fit exactly.
      const other = h.authority.admit(request("w-k", "dk", "ModelHost", 16));
      expect(other.kind).toBe("admitted");
      if (other.kind === "admitted") {
        expect(other.committedGiB).toBe(24);
      }
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("a different spec on the same key is refused WorkloadBusy", () => {
    const h = openAuthority(24);
    try {
      mustAdmit(h.authority, request("w-b", "d1", "ModelRun", 8));
      const differentDigest = h.authority.admit(request("w-b", "d2", "ModelRun", 8));
      expect(differentDigest.kind).toBe("refuse");
      if (differentDigest.kind === "refuse") {
        expect(differentDigest.reason).toBe("WorkloadBusy");
      }
      // Same digest but a different kind also conflicts — one runtime dir.
      const differentKind = h.authority.admit(request("w-b", "d1", "ModelHost", 8));
      expect(differentKind.kind).toBe("refuse");
      if (differentKind.kind === "refuse") {
        expect(differentKind.reason).toBe("WorkloadBusy");
      }
      expect(chargedGiB(h.authority)).toBe(8);
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("recordGeneration stores the pid evidence", () => {
    const h = openAuthority(24);
    try {
      const { claimId, fenceToken } = mustAdmit(h.authority, request("w-g", "d", "ModelRun", 8));
      expect(
        h.authority.recordGeneration(claimId, "bogus-fence-token", {
          pid: 4100,
          startTimeMs: 700,
        }),
      ).toBe(false);
      expect(
        h.authority.recordGeneration(claimId, fenceToken, { pid: 4100, startTimeMs: 700 }),
      ).toBe(true);
      // A retry generation is captured alongside the first.
      expect(
        h.authority.recordGeneration(claimId, fenceToken, { pid: 4101, startTimeMs: 900 }),
      ).toBe(true);
      const r = row(h.authority, claimId);
      expect(r?.generations).toEqual([
        { pid: 4100, startTimeMs: 700 },
        { pid: 4101, startTimeMs: 900 },
      ]);
      // The evidence is consulted: a recorded pid observed alive keeps the charge.
      h.observations.set(4100, { pid: 4100, alive: false, startTimeMs: 700 });
      h.observations.set(4101, { pid: 4101, alive: true, startTimeMs: 900 });
      h.pidFiles.set("w-g", 4101);
      expect(h.authority.tryRelease(claimId).kind).toBe("retained");
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("completeReady with a stale fence token is rejected without mutation", () => {
    const h = openAuthority(24);
    try {
      const { claimId, fenceToken } = mustAdmit(h.authority, request("w-s", "d", "ModelRun", 8));
      expect(h.authority.completeReady(claimId, "bogus-fence-token")).toBe(false);
      expect(row(h.authority, claimId)?.state).toBe("pending");
      expect(h.authority.completeReady(claimId, fenceToken)).toBe(true);
      expect(row(h.authority, claimId)?.state).toBe("resident");
      // The transition rotated the token; the pre-commit token is now stale.
      expect(h.authority.completeReady(claimId, fenceToken)).toBe(false);
      expect(h.authority.failUncertain(claimId, fenceToken, "late timeout")).toBe(false);
      expect(h.authority.recordGeneration(claimId, fenceToken, { pid: 4200 })).toBe(false);
      expect(row(h.authority, claimId)?.state).toBe("resident");
      expect(row(h.authority, claimId)?.generations).toEqual([]);
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("timeout or disconnect -> failUncertain keeps the memory charged", () => {
    const h = openAuthority(24);
    try {
      const { claimId, fenceToken } = mustAdmit(h.authority, request("w-u", "d", "ModelRun", 20));
      expect(h.authority.failUncertain(claimId, "bogus-fence-token", "timeout")).toBe(false);
      expect(h.authority.failUncertain(claimId, fenceToken, "readiness timeout")).toBe(true);
      const r = row(h.authority, claimId);
      expect(r?.state).toBe("uncertain");
      expect(r?.allocationGiB).toBe(20);
      // Still charged: only 4 of 24 GiB remains for new claims.
      const over = h.authority.admit(request("w-2", "d2", "ModelHost", 20));
      expect(over.kind).toBe("refuse");
      if (over.kind === "refuse") {
        expect(over.reason).toBe("BudgetExceeded");
      }
      expect(h.authority.admit(request("w-3", "d3", "ModelHost", 4)).kind).toBe("admitted");
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("an uncertain claim stays uncertain and charged even if a later observation looks alive", () => {
    const h = openAuthority(24);
    try {
      const { claimId, fenceToken } = mustAdmit(h.authority, request("w-t", "d", "ModelRun", 8));
      expect(
        h.authority.recordGeneration(claimId, fenceToken, { pid: 4300, startTimeMs: 1000 }),
      ).toBe(true);
      expect(h.authority.failUncertain(claimId, fenceToken, "loader disconnect")).toBe(true);
      // The recorded pid later looks alive and identical — uncertain is
      // terminal in this slice: no repromote, no release on live evidence.
      h.observations.set(4300, { pid: 4300, alive: true, startTimeMs: 1000 });
      h.pidFiles.set("w-t", 4300);
      expect(h.authority.tryRelease(claimId).kind).toBe("retained");
      const r = row(h.authority, claimId);
      expect(r?.state).toBe("uncertain");
      expect(r?.allocationGiB).toBe(8);
      // An uncertain row can never be joined or re-admitted.
      const dup = h.authority.admit(request("w-t", "d", "ModelRun", 8));
      expect(dup.kind).toBe("refuse");
      if (dup.kind === "refuse") {
        expect(dup.reason).toBe("WorkloadBusy");
      }
      const over = h.authority.admit(request("w-z", "dz", "ModelHost", 20));
      expect(over.kind).toBe("refuse");
      if (over.kind === "refuse") {
        expect(over.reason).toBe("BudgetExceeded");
      }
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("tryRelease releases only on verified absence (dead pid, matching identity, consistent pid record)", () => {
    const h = openAuthority(24);
    try {
      const { claimId, fenceToken } = mustAdmit(h.authority, request("w-r", "d", "ModelRun", 8));
      expect(
        h.authority.recordGeneration(claimId, fenceToken, { pid: 4400, startTimeMs: 50 }),
      ).toBe(true);
      expect(h.authority.completeReady(claimId, fenceToken)).toBe(true);
      h.observations.set(4400, { pid: 4400, alive: false, startTimeMs: 50 });
      h.pidFiles.set("w-r", 4400);
      expect(h.authority.tryRelease(claimId).kind).toBe("released");
      expect(row(h.authority, claimId)).toBeUndefined();
      expect(chargedGiB(h.authority)).toBe(0);
      expect(h.authority.tryRelease(claimId).kind).toBe("unknown-claim");
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("a vanished pid file or an unidentified dead process does not release", () => {
    const h = openAuthority(24);
    try {
      // Dead with matching identity, but the runtime-dir pid record is gone.
      const gone = mustAdmit(h.authority, request("w-v", "d", "ModelRun", 4));
      expect(
        h.authority.recordGeneration(gone.claimId, gone.fenceToken, {
          pid: 4500,
          startTimeMs: 10,
        }),
      ).toBe(true);
      h.observations.set(4500, { pid: 4500, alive: false, startTimeMs: 10 });
      expect(h.authority.tryRelease(gone.claimId).kind).toBe("retained");
      expect(row(h.authority, gone.claimId)).toBeDefined();

      // Dead but unidentifiable — cannot prove the corpse is the recorded one.
      const unidentified = mustAdmit(h.authority, request("w-n", "d", "ModelRun", 4));
      expect(
        h.authority.recordGeneration(unidentified.claimId, unidentified.fenceToken, {
          pid: 4501,
        }),
      ).toBe(true);
      h.observations.set(4501, { pid: 4501, alive: false });
      h.pidFiles.set("w-n", 4501);
      expect(h.authority.tryRelease(unidentified.claimId).kind).toBe("retained");
      expect(row(h.authority, unidentified.claimId)).toBeDefined();

      // The pid record names a process the claim never recorded — conflicting.
      const conflict = mustAdmit(h.authority, request("w-c", "d", "ModelRun", 4));
      expect(
        h.authority.recordGeneration(conflict.claimId, conflict.fenceToken, {
          pid: 4502,
          startTimeMs: 30,
        }),
      ).toBe(true);
      h.observations.set(4502, { pid: 4502, alive: false, startTimeMs: 30 });
      h.pidFiles.set("w-c", 4599);
      expect(h.authority.tryRelease(conflict.claimId).kind).toBe("retained");
      expect(row(h.authority, conflict.claimId)).toBeDefined();

      // No generation captured at all — unprovable, stays charged.
      const unproven = mustAdmit(h.authority, request("w-g0", "d", "ModelRun", 4));
      h.observations.set(4503, { pid: 4503, alive: false, startTimeMs: 40 });
      h.pidFiles.set("w-g0", 4503);
      expect(h.authority.tryRelease(unproven.claimId).kind).toBe("retained");
      expect(row(h.authority, unproven.claimId)).toBeDefined();

      expect(chargedGiB(h.authority)).toBe(16);
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("a dead parent whose recorded pid has a living matching child observation keeps the charge", () => {
    const h = openAuthority(24);
    try {
      const { claimId, fenceToken } = mustAdmit(h.authority, request("w-p", "d", "ModelRun", 8));
      expect(
        h.authority.recordGeneration(claimId, fenceToken, { pid: 4600, startTimeMs: 100 }),
      ).toBe(true);
      expect(
        h.authority.recordGeneration(claimId, fenceToken, { pid: 4601, startTimeMs: 150 }),
      ).toBe(true);
      // The recorded parent is provably dead; a recorded child survives.
      h.observations.set(4600, { pid: 4600, alive: false, startTimeMs: 100 });
      h.observations.set(4601, { pid: 4601, alive: true, startTimeMs: 150 });
      h.pidFiles.set("w-p", 4601);
      expect(h.authority.tryRelease(claimId).kind).toBe("retained");
      expect(row(h.authority, claimId)).toBeDefined();
      const over = h.authority.admit(request("w-q", "dq", "ModelHost", 20));
      expect(over.kind).toBe("refuse");
      if (over.kind === "refuse") {
        expect(over.reason).toBe("BudgetExceeded");
      }
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("after a verified release, a new different-key claim can reuse that capacity", () => {
    const h = openAuthority(24);
    try {
      const { claimId, fenceToken } = mustAdmit(h.authority, request("w-old", "d", "ModelRun", 16));
      expect(h.authority.recordGeneration(claimId, fenceToken, { pid: 4700, startTimeMs: 5 })).toBe(
        true,
      );
      const blocked = h.authority.admit(request("w-new", "dn", "ModelHost", 16));
      expect(blocked.kind).toBe("refuse");
      if (blocked.kind === "refuse") {
        expect(blocked.reason).toBe("BudgetExceeded");
      }
      h.observations.set(4700, { pid: 4700, alive: false, startTimeMs: 5 });
      h.pidFiles.set("w-old", 4700);
      expect(h.authority.tryRelease(claimId).kind).toBe("released");
      const freed = h.authority.admit(request("w-new", "dn", "ModelHost", 16));
      expect(freed.kind).toBe("admitted");
      if (freed.kind === "admitted") {
        expect(freed.committedGiB).toBe(16);
      }
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("unknown budget refuses BudgetUnknown and never falls back to unlimited", () => {
    // Open with a real budget, then make the probe report unknown: passing
    // undefined to openAuthority would hit its default and admit.
    const h = openAuthority(24);
    h.budget.value = undefined;
    try {
      const outcome = h.authority.admit(request("w-x", "d", "ModelRun", 4));
      expect(outcome.kind).toBe("refuse");
      if (outcome.kind === "refuse") {
        expect(outcome.reason).toBe("BudgetUnknown");
      }
      expect(h.authority.snapshot()).toEqual([]);
      // When the probe later reports a real figure the same request can admit.
      h.budget.value = 24;
      expect(h.authority.admit(request("w-x", "d", "ModelRun", 4)).kind).toBe("admitted");
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("snapshot returns detached records", () => {
    const h = openAuthority(24);
    try {
      const { claimId, fenceToken } = mustAdmit(h.authority, request("w-d", "d", "ModelRun", 8));
      expect(h.authority.recordGeneration(claimId, fenceToken, { pid: 4800, startTimeMs: 1 })).toBe(
        true,
      );
      const snap = row(h.authority, claimId);
      if (!snap) {
        throw new Error("row missing from snapshot");
      }
      snap.state = "resident";
      snap.allocationGiB = 0;
      snap.fenceToken = "forged";
      snap.generations[0]!.pid = 9999;
      const after = row(h.authority, claimId);
      expect(after?.state).toBe("pending");
      expect(after?.allocationGiB).toBe(8);
      expect(after?.fenceToken).toBe(fenceToken);
      expect(after?.generations[0]?.pid).toBe(4800);
    } finally {
      h.authority.close();
      h.cleanup();
    }
  });

  test("an unreadable store yields AuthorityUnavailable on every admit", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-admission-authority-"));
    const storePath = join(dir, "admission.db");
    writeFileSync(storePath, "this is not a sqlite database — it fails the header check");
    let authority: AdmissionAuthority | undefined;
    let threw: unknown;
    try {
      try {
        authority = openAdmissionAuthority({
          storePath,
          runtimeRoot: join(dir, "runtime"),
          budgetGiB: () => 24,
          observe: () => undefined,
          readPidFile: () => undefined,
        });
      } catch (e) {
        threw = e;
      }
      // Degraded, never legacy: open does not throw, every admit refuses.
      expect(threw).toBeUndefined();
      if (authority === undefined) {
        throw new Error("openAdmissionAuthority returned no authority");
      }
      const first = authority.admit(request("w-d1", "d", "ModelRun", 4));
      expect(first.kind).toBe("refuse");
      if (first.kind === "refuse") {
        expect(first.reason).toBe("AuthorityUnavailable");
      }
      const second = authority.admit(request("w-d2", "d", "ModelHost", 4));
      expect(second.kind).toBe("refuse");
      if (second.kind === "refuse") {
        expect(second.reason).toBe("AuthorityUnavailable");
      }
      expect(authority.snapshot()).toEqual([]);
      authority.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
