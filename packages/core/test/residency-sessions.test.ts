import { expect, test } from "bun:test";

// #520: the session-refcount store lands with the fix. A variable specifier
// keeps tsc from resolving the not-yet-existing module, so each case fails by
// assertion at the pinned base rather than by a resolution error.
const SESSIONS_MODULE = "../src/residency/sessions.js";

type AcquireResult =
  | { ok: true; workload: string; refs: number }
  | { ok: false; reason: "AffinityConflict"; boundWorkload: string };

type CheckUnloadResult =
  | { ok: true; released: string[] }
  | { ok: false; reason: "SessionActive"; sessions: string[] };

type SessionRefcounts = {
  acquire: (sessionId: string, workload: string) => AcquireResult;
  release: (sessionId: string) => unknown;
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
  expect(rc.acquire("s1", "glm")).toEqual({ ok: true, workload: "glm", refs: 2 });
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
  expect(rc.acquire("s1", "glm")).toEqual({ ok: true, workload: "glm", refs: 1 });
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
