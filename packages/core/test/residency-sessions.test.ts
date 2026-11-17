import { expect, test } from "bun:test";

// #520: the session-refcount store lands with the fix. A variable specifier
// keeps tsc from resolving the not-yet-existing module, so each case fails by
// assertion at the pinned base rather than by a resolution error.
const SESSIONS_MODULE = "../src/residency/sessions.js";

type AcquireResult =
  | { ok: true; workload: string; refs: number; generation?: number }
  | { ok: false; reason: "AffinityConflict"; boundWorkload: string };

type CheckUnloadResult =
  | { ok: true; released: string[] }
  | { ok: false; reason: "SessionActive"; sessions: string[] };

type SessionRefcounts = {
  acquire: (sessionId: string, workload: string) => AcquireResult;
  release: (sessionId: string, generation?: number) => unknown;
  cancelAcquire?: (sessionId: string, generation: number) => unknown;
  touch: (sessionId: string) => unknown;
  checkUnload: (workload: string, opts?: { force?: boolean }) => CheckUnloadResult;
  forceRelease: (workload: string) => string[];
  activeSessions: (workload: string) => string[];
};

type Mod = {
  createSessionRefcounts: (options: {
    idleTimeoutMs: number;
    now?: () => number;
  }) => SessionRefcounts;
};

async function load(): Promise<Mod> {
  const mod = (await import(SESSIONS_MODULE).catch(() => undefined)) as Mod | undefined;
  expect(typeof mod?.createSessionRefcounts).toBe("function");
  return mod!;
}

function generationOf(result: AcquireResult): number | undefined {
  return result.ok ? result.generation : undefined;
}

test("#520: an active session refuses unload as SessionActive", async () => {
  const mod = await load();
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000 });
  rc.acquire("s1", "glm");
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
});

test("#520: a released session still blocks unload until the idle timeout lapses", async () => {
  const mod = await load();
  let t = 1_000;
  const idleTimeoutMs = 5_000;
  const rc = mod.createSessionRefcounts({ idleTimeoutMs, now: (): number => t });
  rc.acquire("s1", "glm");
  rc.release("s1");
  t += idleTimeoutMs - 1;
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
  t += 1;
  expect(rc.checkUnload("glm")).toEqual({ ok: true, released: [] });
  expect(rc.activeSessions("glm")).toEqual([]);
});

test("#520: release refreshes the idle deadline, expiring only idleTimeoutMs after the release", async () => {
  const mod = await load();
  let t = 1_000;
  const idleTimeoutMs = 5_000;
  const rc = mod.createSessionRefcounts({ idleTimeoutMs, now: (): number => t });
  rc.acquire("s1", "glm");
  t += 2 * idleTimeoutMs;
  rc.release("s1");
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
  t += idleTimeoutMs - 1;
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
  t += 1;
  expect(rc.checkUnload("glm")).toEqual({ ok: true, released: [] });
  expect(rc.activeSessions("glm")).toEqual([]);
});

test("#520: touch before the idle deadline extends the session past the original expiry", async () => {
  const mod = await load();
  let t = 1_000;
  const idleTimeoutMs = 5_000;
  const rc = mod.createSessionRefcounts({ idleTimeoutMs, now: (): number => t });
  rc.acquire("s1", "glm");
  rc.release("s1");
  t += idleTimeoutMs - 1;
  rc.touch("s1");
  t += 1;
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
  t += idleTimeoutMs - 2;
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
  t += 1;
  expect(rc.checkUnload("glm")).toEqual({ ok: true, released: [] });
  expect(rc.activeSessions("glm")).toEqual([]);
});

test("#520: outstanding refs keep a session alive past the idle timeout", async () => {
  const mod = await load();
  let t = 1_000;
  const idleTimeoutMs = 1_000;
  const rc = mod.createSessionRefcounts({ idleTimeoutMs, now: (): number => t });
  rc.acquire("s1", "glm");
  rc.acquire("s1", "glm");
  rc.release("s1");
  t += 10 * idleTimeoutMs;
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
});

test("#520: session affinity pins a session to its first workload until expiry", async () => {
  const mod = await load();
  let t = 1_000;
  const idleTimeoutMs = 1_000;
  const rc = mod.createSessionRefcounts({ idleTimeoutMs, now: (): number => t });
  rc.acquire("s1", "glm");
  expect(rc.acquire("s1", "deepseek")).toEqual({
    ok: false,
    reason: "AffinityConflict",
    boundWorkload: "glm",
  });
  expect(rc.acquire("s1", "glm")).toMatchObject({ ok: true, workload: "glm", refs: 2 });
  rc.release("s1");
  rc.release("s1");
  t += idleTimeoutMs;
  expect(rc.acquire("s1", "deepseek")).toMatchObject({ ok: true });
});

test("#520: sessions bound to other workloads do not block this unload", async () => {
  const mod = await load();
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000 });
  rc.acquire("s-mimo", "mimo");
  expect(rc.checkUnload("glm")).toEqual({ ok: true, released: [] });
  expect(rc.activeSessions("glm")).toEqual([]);
  expect(rc.activeSessions("mimo")).toEqual(["s-mimo"]);
});

test("#520: force unload releases sessions and forceRelease drops one workload's ids", async () => {
  const mod = await load();
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000 });
  rc.acquire("s1", "glm");
  rc.acquire("s2", "mimo");
  expect(rc.checkUnload("glm", { force: true })).toEqual({ ok: true, released: ["s1"] });
  expect(rc.checkUnload("glm")).toEqual({ ok: true, released: [] });
  expect(rc.checkUnload("mimo")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s2"],
  });
  rc.acquire("s3", "glm");
  expect(rc.forceRelease("glm")).toEqual(["s3"]);
  expect(rc.checkUnload("glm")).toEqual({ ok: true, released: [] });
  expect(rc.checkUnload("mimo")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s2"],
  });
});

test("#520: release underflow is a no-op and never drives refs negative", async () => {
  const mod = await load();
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000 });
  rc.release("ghost");
  rc.acquire("s1", "glm");
  rc.release("s1");
  rc.release("s1");
  rc.release("s1");
  expect(rc.acquire("s1", "glm")).toMatchObject({ ok: true, workload: "glm", refs: 1 });
});

test("#520: a stale release after forceRelease cannot drop a re-acquired session", async () => {
  const mod = await load();
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => 1_000 });
  const a1 = rc.acquire("s1", "glm");
  expect(a1.ok && typeof a1.generation).toBe("number");
  const gen1 = generationOf(a1);
  expect(rc.forceRelease("glm")).toEqual(["s1"]);
  const a2 = rc.acquire("s1", "glm");
  expect(a2).toMatchObject({ ok: true, workload: "glm", refs: 1 });
  const gen2 = generationOf(a2);
  expect(gen2).not.toBe(gen1);
  rc.release("s1", gen1);
  expect(rc.acquire("s1", "glm")).toMatchObject({
    ok: true,
    workload: "glm",
    refs: 2,
    generation: gen2,
  });
});

test("#520: a stale release after checkUnload({force:true}) is a no-op", async () => {
  const mod = await load();
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => 1_000 });
  const a1 = rc.acquire("s1", "glm");
  expect(a1.ok && typeof a1.generation).toBe("number");
  const gen1 = generationOf(a1);
  expect(rc.checkUnload("glm", { force: true })).toEqual({ ok: true, released: ["s1"] });
  const a2 = rc.acquire("s1", "glm");
  expect(a2).toMatchObject({ ok: true, workload: "glm", refs: 1 });
  const gen2 = generationOf(a2);
  expect(gen2).not.toBe(gen1);
  rc.release("s1", gen1);
  expect(rc.activeSessions("glm")).toEqual(["s1"]);
  expect(rc.acquire("s1", "glm")).toMatchObject({
    ok: true,
    workload: "glm",
    refs: 2,
    generation: gen2,
  });
});

test("#520: a current-generation release decrements exactly once", async () => {
  const mod = await load();
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => 1_000 });
  const a1 = rc.acquire("s1", "glm");
  const a2 = rc.acquire("s1", "glm");
  expect(a1.ok && a2.ok && a1.generation === a2.generation).toBe(true);
  rc.release("s1", generationOf(a2));
  expect(rc.acquire("s1", "glm")).toMatchObject({ ok: true, workload: "glm", refs: 2 });
  rc.release("s1");
  expect(rc.acquire("s1", "glm")).toMatchObject({ ok: true, workload: "glm", refs: 2 });
});

test("#520: constructor and acquire fail closed on invalid input", async () => {
  const mod = await load();
  for (const idleTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => mod.createSessionRefcounts({ idleTimeoutMs })).toThrow();
  }
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000 });
  expect(() => rc.acquire("", "glm")).toThrow();
  expect(() => rc.acquire("s", "")).toThrow();
});

test("#520: a stale release does not refresh lastActivityMs, so idle expiry proceeds from the current release", async () => {
  const mod = await load();
  let t = 1_000;
  const idleTimeoutMs = 5_000;
  const rc = mod.createSessionRefcounts({ idleTimeoutMs, now: (): number => t });
  const a1 = rc.acquire("s1", "glm");
  expect(a1.ok && typeof a1.generation).toBe("number");
  const gen1 = generationOf(a1);
  expect(rc.forceRelease("glm")).toEqual(["s1"]);
  const a2 = rc.acquire("s1", "glm");
  expect(a2).toMatchObject({ ok: true, workload: "glm", refs: 1 });
  const gen2 = generationOf(a2);
  expect(gen2).not.toBe(gen1);
  rc.release("s1", gen2);
  t += idleTimeoutMs / 2;
  rc.release("s1", gen1);
  expect(rc.activeSessions("glm")).toEqual(["s1"]);
  t += idleTimeoutMs / 2;
  expect(rc.activeSessions("glm")).toEqual([]);
});

test("#520: cancelAcquire drops a binding its own acquire created", async () => {
  const mod = await load();
  const rc = mod.createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => 1_000 });
  expect(typeof rc.cancelAcquire).toBe("function");
  const created = rc.acquire("s1", "glm");
  expect(created.ok).toBe(true);
  const gen = generationOf(created);
  expect(typeof gen).toBe("number");
  // Kills a cancelAcquire that only decrements refs: the entry its own
  // acquire created must be deleted, or s1 stays bound to glm and the
  // re-acquire on "other" conflicts.
  rc.cancelAcquire!("s1", gen!);
  expect(rc.activeSessions("glm")).toEqual([]);
  expect(rc.acquire("s1", "other")).toMatchObject({ ok: true, workload: "other" });
});

test("#520: cancelAcquire of a joined acquire restores refs and the idle deadline", async () => {
  const mod = await load();
  let t = 1_000;
  const idleTimeoutMs = 5_000;
  const rc = mod.createSessionRefcounts({ idleTimeoutMs, now: (): number => t });
  expect(typeof rc.cancelAcquire).toBe("function");

  const first = rc.acquire("s1", "glm");
  const gen = generationOf(first);
  expect(typeof gen).toBe("number");
  rc.release("s1", gen);
  // Idle binding: refs 0, lastActivity 1_000, expires at 6_000.
  t = 3_000;
  const joined = rc.acquire("s1", "glm");
  expect(joined).toMatchObject({ ok: true, refs: 1, generation: gen });
  // Kills a cancelAcquire that delegates to release or refreshes
  // lastActivityMs: the undo must restore the pre-acquire deadline (1_000),
  // so the session still expires at 6_000 rather than 3_000 + 5_000.
  rc.cancelAcquire!("s1", gen!);

  t = 5_999;
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
  t = 6_000;
  expect(rc.checkUnload("glm")).toEqual({ ok: true, released: [] });
  expect(rc.activeSessions("glm")).toEqual([]);

  // Refs restoration: cancel the latest of two joins, then one release
  // must bring refs to 0 so the session expires idleTimeoutMs later.
  t = 10_000;
  const s2first = rc.acquire("s2", "glm");
  const gen2 = generationOf(s2first);
  rc.release("s2", gen2);
  rc.acquire("s2", "glm");
  const s2second = rc.acquire("s2", "glm");
  expect(s2second).toMatchObject({ ok: true, refs: 2, generation: gen2 });
  rc.cancelAcquire!("s2", gen2!);
  rc.release("s2", gen2);
  t = 14_999;
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s2"],
  });
  t = 15_000;
  expect(rc.checkUnload("glm")).toEqual({ ok: true, released: [] });
});

test("#520: a stale-generation cancelAcquire is a no-op", async () => {
  const mod = await load();
  let t = 1_000;
  const idleTimeoutMs = 1_000;
  const rc = mod.createSessionRefcounts({ idleTimeoutMs, now: (): number => t });
  expect(typeof rc.cancelAcquire).toBe("function");

  const stale = rc.acquire("s1", "glm");
  const gen1 = generationOf(stale);
  expect(typeof gen1).toBe("number");
  expect(rc.forceRelease("glm")).toEqual(["s1"]);
  const live = rc.acquire("s1", "glm");
  expect(live).toMatchObject({ ok: true, workload: "glm", refs: 1 });
  const gen2 = generationOf(live);
  expect(gen2).not.toBe(gen1);
  // Kills a cancelAcquire that drops the generation check: g1 is stale, so
  // the live refs-1 binding must survive untouched.
  rc.cancelAcquire!("s1", gen1!);

  expect(rc.activeSessions("glm")).toEqual(["s1"]);
  t += 10 * idleTimeoutMs;
  expect(rc.checkUnload("glm")).toEqual({
    ok: false,
    reason: "SessionActive",
    sessions: ["s1"],
  });
});
