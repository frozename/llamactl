import { expect, test } from "bun:test";

import { createSessionRefcounts, type SessionRefcounts } from "../src/residency/sessions.js";

// #520: operator per-session release. releaseSession lands with the fix as an
// optional method on the refcount registry, so every case probes it through
// `releaseSession?.(...)`: on the pinned base the call evaluates to undefined
// and each assertion fails on the returned value, never on a missing export
// or a type error.

type SessionReleaseResult =
  | { ok: true; sessionId: string; workload: string; refs: number; forced: boolean }
  | { ok: false; reason: "SessionNotFound"; sessionId: string }
  | {
      ok: false;
      reason: "SessionInFlight";
      sessionId: string;
      workload: string;
      refs: number;
    };

type ReleasableRefcounts = SessionRefcounts & {
  releaseSession?: (sessionId: string, opts?: { force?: boolean }) => SessionReleaseResult;
};

function registry(now: () => number): ReleasableRefcounts {
  return createSessionRefcounts({ idleTimeoutMs: 1000, now });
}

function acquireIdle(reg: ReleasableRefcounts, sessionId: string, workload: string): void {
  const got = reg.acquire(sessionId, workload);
  if (!got.ok) {
    throw new Error(`acquire(${sessionId}) refused: ${got.reason}`);
  }
  reg.release(sessionId, got.generation);
}

test("#520 C1: releaseSession drops an idle binding and frees the workload", () => {
  // Kills: returning ok without deleting the entry.
  const reg = registry(() => 0);
  acquireIdle(reg, "s1", "wl-a");
  expect(reg.checkUnload("wl-a")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });

  expect(reg.releaseSession?.("s1")).toEqual({
    ok: true,
    sessionId: "s1",
    workload: "wl-a",
    refs: 0,
    forced: false,
  });
  expect(reg.checkUnload("wl-a")).toEqual({ ok: true, released: [] });
  expect(reg.activeSessions("wl-a")).toEqual([]);
  expect(reg.snapshot?.()?.sessions).toEqual([]);
});

test("#520 C2: releaseSession frees the affinity binding for a new workload", () => {
  // Kills: a release that leaves the workload binding in place.
  const reg = registry(() => 0);
  acquireIdle(reg, "s1", "wl-a");
  expect(reg.acquire("s1", "wl-b")).toEqual({
    ok: false,
    reason: "AffinityConflict",
    boundWorkload: "wl-a",
  });

  reg.releaseSession?.("s1");

  expect(reg.acquire("s1", "wl-b")).toMatchObject({ ok: true, workload: "wl-b", refs: 1 });
});

test("#520 C3: an in-flight session refuses releaseSession as SessionInFlight", () => {
  // Kills: ignoring refs — releasing anyway or reporting ok.
  const reg = registry(() => 0);
  const got = reg.acquire("s1", "wl-a");
  expect(got.ok).toBe(true);

  expect(reg.releaseSession?.("s1")).toEqual({
    ok: false,
    reason: "SessionInFlight",
    sessionId: "s1",
    workload: "wl-a",
    refs: 1,
  });
  expect(reg.checkUnload("wl-a")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
});

test("#520 C4: force drops an in-flight binding; a stale release stays a no-op", () => {
  // Kills: force ignored, or force zeroing refs instead of deleting the entry.
  const reg = registry(() => 0);
  const got = reg.acquire("s1", "wl-a");
  if (!got.ok) {
    throw new Error("acquire(s1) refused");
  }
  const generation = got.generation;

  expect(reg.releaseSession?.("s1", { force: true })).toEqual({
    ok: true,
    sessionId: "s1",
    workload: "wl-a",
    refs: 1,
    forced: true,
  });
  const rebound = reg.acquire("s1", "wl-b");
  expect(rebound).toMatchObject({ ok: true, workload: "wl-b", refs: 1 });

  reg.release("s1", generation);
  const rows = reg.snapshot?.()?.sessions ?? [];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    sessionId: "s1",
    workload: "wl-b",
    refs: 1,
    expiresInMs: null,
  });
});

test("#520 C5: releaseSession reports SessionNotFound for unknown and pruned ids", () => {
  // Kills: a missing prune before the lookup — an idled-out entry must read
  // as not found, not as a live session.
  let clock = 0;
  const reg = registry(() => clock);

  expect(reg.releaseSession?.("nope")).toEqual({
    ok: false,
    reason: "SessionNotFound",
    sessionId: "nope",
  });

  acquireIdle(reg, "s1", "wl-a");
  clock = 1000;
  expect(reg.releaseSession?.("s1")).toEqual({
    ok: false,
    reason: "SessionNotFound",
    sessionId: "s1",
  });
});

test("#520 C6: releaseSession rejects an empty sessionId", () => {
  // Kills: dropping requireNonEmpty.
  const reg = registry(() => 0);
  expect(() => reg.releaseSession?.("")).toThrow("sessionId must not be empty");
});
