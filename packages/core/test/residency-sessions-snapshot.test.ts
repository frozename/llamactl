import { expect, test } from "bun:test";

import { createSessionRefcounts } from "../src/residency/sessions.js";

// #520: bound sessions become visible in residency status through a
// read-only snapshot() on the refcount registry. The method lands with the
// fix; snapshot is optional here so every case fails by assertion at the
// pinned base (undefined !== the expected payload), never by a missing
// export or a type error.

type SessionSnapshotRow = {
  sessionId: string;
  workload: string;
  refs: number;
  idleMs: number;
  expiresInMs: number | null;
};

type SessionSnapshot = {
  idleTimeoutMs: number;
  sessions: SessionSnapshotRow[];
};

type SessionRefcountsWithSnapshot = ReturnType<typeof createSessionRefcounts> & {
  snapshot?: () => SessionSnapshot;
};

function registry(now: () => number): SessionRefcountsWithSnapshot {
  return createSessionRefcounts({ idleTimeoutMs: 1000, now });
}

test("#520 snapshot: bound sessions report refs, idle time and expiry", () => {
  // Kills: snapshot absent; expiresInMs computed for an in-flight session;
  // unsorted rows.
  let t = 0;
  const reg = registry(() => t);
  const inFlight = reg.acquire("s-b", "wl-b");
  expect(inFlight.ok).toBe(true);
  const idle = reg.acquire("s-a", "wl-a");
  if (!idle.ok) throw new Error("acquire(s-a) refused");
  t = 200;
  reg.release("s-a", idle.generation);
  t = 700;
  expect(reg.snapshot?.()).toEqual({
    idleTimeoutMs: 1000,
    sessions: [
      { sessionId: "s-a", workload: "wl-a", refs: 0, idleMs: 500, expiresInMs: 500 },
      { sessionId: "s-b", workload: "wl-b", refs: 1, idleMs: 700, expiresInMs: null },
    ],
  });
});

test("#520 snapshot: sessionId breaks ties within a workload", () => {
  // Kills: rows ordered by insertion or sorted by sessionId across
  // workloads instead of (workload, sessionId).
  const t = 0;
  const reg = registry(() => t);
  reg.acquire("s-z", "wl-a");
  reg.acquire("s-a", "wl-a");
  reg.acquire("s-m", "wl-b");
  expect(reg.snapshot?.()).toEqual({
    idleTimeoutMs: 1000,
    sessions: [
      { sessionId: "s-a", workload: "wl-a", refs: 1, idleMs: 0, expiresInMs: null },
      { sessionId: "s-z", workload: "wl-a", refs: 1, idleMs: 0, expiresInMs: null },
      { sessionId: "s-m", workload: "wl-b", refs: 1, idleMs: 0, expiresInMs: null },
    ],
  });
});

test("#520 snapshot: prunes a session at its idle deadline", () => {
  // Kills: snapshot not pruning expired entries (the t=1000 row would
  // remain); an off-by-one in expiresInMs.
  let t = 0;
  const reg = registry(() => t);
  const acq = reg.acquire("s-a", "wl-a");
  if (!acq.ok) throw new Error("acquire(s-a) refused");
  reg.release("s-a", acq.generation);
  t = 999;
  expect(reg.snapshot?.()).toEqual({
    idleTimeoutMs: 1000,
    sessions: [{ sessionId: "s-a", workload: "wl-a", refs: 0, idleMs: 999, expiresInMs: 1 }],
  });
  t = 1000;
  expect(reg.snapshot?.()).toEqual({ idleTimeoutMs: 1000, sessions: [] });
});

test("#520 snapshot: never refreshes lastActivityMs", () => {
  // Kills: snapshot touching lastActivityMs — a refresh at t=900 would read
  // idleMs 300 at t=1200 instead of 700.
  let t = 500;
  const reg = registry(() => t);
  const acq = reg.acquire("s-c", "wl-c");
  if (!acq.ok) throw new Error("acquire(s-c) refused");
  reg.release("s-c", acq.generation);
  t = 900;
  expect(reg.snapshot?.()).toEqual({
    idleTimeoutMs: 1000,
    sessions: [{ sessionId: "s-c", workload: "wl-c", refs: 0, idleMs: 400, expiresInMs: 600 }],
  });
  t = 1200;
  expect(reg.snapshot?.()).toEqual({
    idleTimeoutMs: 1000,
    sessions: [{ sessionId: "s-c", workload: "wl-c", refs: 0, idleMs: 700, expiresInMs: 300 }],
  });
  t = 1500;
  expect(reg.activeSessions("wl-c")).toEqual([]);
  expect(reg.snapshot?.()).toEqual({ idleTimeoutMs: 1000, sessions: [] });
});

test("#520 snapshot: returns a read-only copy of the live entries", () => {
  // Kills: returning internal entries or arrays by reference.
  const t = 0;
  const reg = registry(() => t);
  const acq = reg.acquire("s-a", "wl-a");
  if (!acq.ok) throw new Error("acquire(s-a) refused");
  reg.release("s-a", acq.generation);
  const expected: SessionSnapshot = {
    idleTimeoutMs: 1000,
    sessions: [{ sessionId: "s-a", workload: "wl-a", refs: 0, idleMs: 0, expiresInMs: 1000 }],
  };
  const snap1 = reg.snapshot?.();
  expect(snap1).toEqual(expected);
  if (snap1 === undefined) throw new Error("snapshot missing");
  snap1.sessions.push({
    sessionId: "s-z",
    workload: "wl-z",
    refs: 0,
    idleMs: 0,
    expiresInMs: 1000,
  });
  const first = snap1.sessions[0];
  if (first === undefined) throw new Error("snapshot row missing");
  first.refs = 99;
  first.workload = "x";
  expect(reg.snapshot?.()).toEqual(expected);
  expect(reg.checkUnload("wl-a")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s-a"],
  });
});

test("#520 snapshot: preserves lastAcquire so cancelAcquire undoes a created binding", () => {
  // Kills: snapshot setting entry.lastAcquire = null, which leaves a
  // phantom refs 1 binding after a refused admission.
  const t = 0;
  const reg = registry(() => t);
  const acq = reg.acquire("s-x", "wl-x");
  if (!acq.ok) throw new Error("acquire(s-x) refused");
  expect(reg.snapshot?.()).toEqual({
    idleTimeoutMs: 1000,
    sessions: [{ sessionId: "s-x", workload: "wl-x", refs: 1, idleMs: 0, expiresInMs: null }],
  });
  reg.cancelAcquire!("s-x", acq.generation);
  expect(reg.activeSessions("wl-x")).toEqual([]);
  expect(reg.snapshot?.()).toEqual({ idleTimeoutMs: 1000, sessions: [] });
});

test("#520 snapshot: cancelAcquire after a re-acquire restores the prior idle deadline", () => {
  // Kills: snapshot setting entry.lastAcquire = null — the joined
  // acquire's undo record must survive the snapshot read so the prior
  // activity at t=100 is restored.
  let t = 0;
  const reg = registry(() => t);
  const first = reg.acquire("s-y", "wl-y");
  if (!first.ok) throw new Error("acquire(s-y) refused");
  t = 100;
  reg.release("s-y", first.generation);
  t = 300;
  const joined = reg.acquire("s-y", "wl-y");
  if (!joined.ok) throw new Error("re-acquire(s-y) refused");
  expect(reg.snapshot?.()).toEqual({
    idleTimeoutMs: 1000,
    sessions: [{ sessionId: "s-y", workload: "wl-y", refs: 1, idleMs: 0, expiresInMs: null }],
  });
  reg.cancelAcquire!("s-y", joined.generation);
  t = 400;
  expect(reg.snapshot?.()).toEqual({
    idleTimeoutMs: 1000,
    sessions: [{ sessionId: "s-y", workload: "wl-y", refs: 0, idleMs: 300, expiresInMs: 700 }],
  });
});
