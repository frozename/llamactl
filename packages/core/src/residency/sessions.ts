/**
 * Active-session refcounts for residency (#520, #569). Pure and adapter-free:
 * no IO, no timers. proxyOpenAI (openaiProxy.ts) acquires a session per
 * request carrying the session header while both this registry and the
 * DF-05 lease registry (#278) are installed. `agent serve` installs one at
 * start when LLAMACTL_RESIDENCY_LEASES is on and
 * LLAMACTL_RESIDENCY_SESSION_IDLE_MS (milliseconds) is set. proxyOpenAI reads
 * activeSessions to prefer a session's already-bound local workload among the
 * route candidates for a request (affinity across tool calls, #520), and calls
 * touch to refresh a bound session's idle clock when a response-cache hit
 * serves it (#520).
 *
 * Eviction consults the installed registry before stopping a workload
 * (workload/apply.ts, #631): a live session refuses it as
 * EvictSessionActive, and a checkUnload that throws refuses it as
 * EvictSessionUnknown. forceRelease and checkUnload({ force: true }) drop
 * the sessions so a later eviction can proceed.
 *
 * checkUnload itself does not fence, but the node stop fence
 * (remote residency/stop-fence.ts) consults it under the DF-05 drain,
 * which closes the window; residency force-unload calls forceRelease
 * under its drain. The profile-switch executor (remote residency/profile-
 * transition.ts) also consults checkUnload under its drain (#520): it
 * checks every victim at fence time and re-checks idle victims after the
 * drain window, refusing SessionsActive/SessionsUnknown without ever
 * releasing sessions; the override is `residency force-unload`.
 *
 * Core `startServer`'s stop-before-start (`server.ts` fencedStop) also
 * consults checkUnload under its DF-05 drain (#520): a session bound to the
 * tracked instance refuses the restart as SessionsActive, and a throwing
 * checkUnload as SessionsUnknown, but only while the tracked instance is
 * live — a crashed instance never blocks — and it never releases sessions.
 *
 * Release is generation-aware (#520 follow-up from the #617 review): a
 * stale release carrying an old generation cannot drop a newer
 * acquisition of the same session ID.
 *
 * releaseSession is the explicit per-session release (#520): it drops one
 * session binding by id — an idle binding outright, an in-flight binding
 * only under force — deleting the entry so a stale release(id, gen) or
 * cancelAcquire turns into a no-op and a re-acquire gets a new generation.
 * A forced release drops only the binding: the DF-05 leases of in-flight
 * requests stay held, so LeasesActive still fences their stop.
 *
 * A request refused by DF-05 admission (Draining/Unloaded) undoes its
 * session acquire (cancelAcquire) instead of releasing it, so a refused
 * request neither binds a fresh session nor extends an idle binding.
 * This makes the profile-switch post-drain re-check (#730) defence in
 * depth rather than the only thing standing between a refused request
 * and a phantom binding.
 */

export interface SessionRefcountOptions {
  idleTimeoutMs: number;
  now?: () => number;
}

export type SessionAcquireResult =
  | { ok: true; workload: string; refs: number; generation: number }
  | { ok: false; reason: "AffinityConflict"; boundWorkload: string };

export type SessionUnloadCheck =
  | { ok: true; released: string[] }
  | { ok: false; reason: "SessionActive"; sessions: string[] };

export type SessionSnapshotRow = {
  sessionId: string;
  workload: string;
  refs: number;
  idleMs: number;
  expiresInMs: number | null;
};

export type SessionSnapshot = {
  idleTimeoutMs: number;
  sessions: SessionSnapshotRow[];
};

export type SessionReleaseResult =
  | { ok: true; sessionId: string; workload: string; refs: number; forced: boolean }
  | { ok: false; reason: "SessionNotFound"; sessionId: string }
  | {
      ok: false;
      reason: "SessionInFlight";
      sessionId: string;
      workload: string;
      refs: number;
    };

export interface SessionRefcounts {
  acquire(sessionId: string, workload: string): SessionAcquireResult;
  /**
   * Decrement the refcount for a session. When `generation` is given and
   * does not match the live entry's generation (or no entry exists), the
   * call is a no-op and does not refresh lastActivityMs, so a stale
   * release cannot drop a newer acquisition. When `generation` is
   * omitted, the legacy by-id decrement is kept unchanged.
   */
  release(sessionId: string, generation?: number): void;
  /**
   * Undo the acquire that returned `generation`. It must be called
   * synchronously after that acquire, before any other call for that
   * session. It is used when residency admission refuses the request.
   * It decrements refs without refreshing lastActivityMs, and restores
   * the pre-acquire lastActivityMs. It deletes the entry when that
   * acquire created it and refs reaches 0. It is a no-op when there is
   * no entry, the generation mismatches, or there is no recorded undo.
   */
  cancelAcquire?(sessionId: string, generation: number): void;
  touch(sessionId: string): void;
  forceRelease(workload: string): string[];
  activeSessions(workload: string): string[];
  checkUnload(workload: string, opts?: { force?: boolean }): SessionUnloadCheck;
  /** Return a snapshot of all live sessions, sorted by last activity. */
  snapshot?(): SessionSnapshot;
  /**
   * Release one session binding by id. An idle binding (refs === 0) drops and
   * deletes the entry; an in-flight binding (refs > 0) refuses. With
   * `force: true`, in-flight bindings are dropped and the entry is deleted
   * (refs reported at the point of force). Returns SessionNotFound when the
   * session is not live (unknown or pruned). Throws when sessionId is empty.
   */
  releaseSession?(sessionId: string, opts?: { force?: boolean }): SessionReleaseResult;
}

// ── Process-wide registry seam ──────────────────────────────────────────

let installedSessions: SessionRefcounts | null = null;

export function setSessionRefcountRegistry(registry: SessionRefcounts | null): void {
  installedSessions = registry;
}

export function currentSessionRefcounts(): SessionRefcounts | null {
  return installedSessions;
}

interface SessionEntry {
  workload: string;
  refs: number;
  generation: number;
  lastActivityMs: number;
  lastAcquire: { created: boolean; priorActivityMs: number } | null;
}

function requireNonEmpty(value: string, what: string): void {
  if (value === "") throw new Error(`${what} must not be empty`);
}

export function createSessionRefcounts(opts: SessionRefcountOptions): SessionRefcounts {
  if (!Number.isFinite(opts.idleTimeoutMs) || opts.idleTimeoutMs <= 0) {
    throw new Error(
      `idleTimeoutMs must be a positive finite number (got ${String(opts.idleTimeoutMs)})`,
    );
  }
  const idleTimeoutMs = opts.idleTimeoutMs;
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, SessionEntry>();
  let nextGeneration = 0;

  const isExpired = (entry: SessionEntry): boolean =>
    entry.refs === 0 && now() - entry.lastActivityMs >= idleTimeoutMs;

  function prune(): void {
    for (const [id, entry] of sessions) {
      if (isExpired(entry)) sessions.delete(id);
    }
  }

  function liveIdsFor(workload: string): string[] {
    const ids: string[] = [];
    for (const [id, entry] of sessions) {
      if (entry.workload === workload) ids.push(id);
    }
    return ids.sort();
  }

  return {
    acquire(sessionId, workload): SessionAcquireResult {
      requireNonEmpty(sessionId, "sessionId");
      requireNonEmpty(workload, "workload");
      prune();
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        const generation = ++nextGeneration;
        const activityMs = now();
        sessions.set(sessionId, {
          workload,
          refs: 1,
          generation,
          lastActivityMs: activityMs,
          lastAcquire: { created: true, priorActivityMs: activityMs },
        });
        return { ok: true, workload, refs: 1, generation };
      }
      if (entry.workload !== workload) {
        return { ok: false, reason: "AffinityConflict", boundWorkload: entry.workload };
      }
      const priorActivityMs = entry.lastActivityMs;
      entry.refs += 1;
      entry.lastActivityMs = now();
      entry.lastAcquire = { created: false, priorActivityMs };
      return { ok: true, workload, refs: entry.refs, generation: entry.generation };
    },
    release(sessionId, generation): void {
      prune();
      const entry = sessions.get(sessionId);
      if (entry === undefined) return;
      if (generation !== undefined && entry.generation !== generation) return;
      entry.refs = Math.max(0, entry.refs - 1);
      entry.lastActivityMs = now();
      entry.lastAcquire = null;
    },
    cancelAcquire(sessionId, generation): void {
      prune();
      const entry = sessions.get(sessionId);
      if (entry === undefined) return;
      if (entry.generation !== generation) return;
      if (entry.lastAcquire === null) return;
      const undo = entry.lastAcquire;
      entry.refs = Math.max(0, entry.refs - 1);
      entry.lastAcquire = null;
      if (undo.created && entry.refs === 0) {
        sessions.delete(sessionId);
      } else {
        entry.lastActivityMs = undo.priorActivityMs;
      }
    },
    touch(sessionId): void {
      requireNonEmpty(sessionId, "sessionId");
      prune();
      const entry = sessions.get(sessionId);
      if (entry === undefined) return;
      entry.lastActivityMs = now();
      entry.lastAcquire = null;
    },
    forceRelease(workload): string[] {
      prune();
      const released = liveIdsFor(workload);
      for (const id of released) sessions.delete(id);
      return released;
    },
    activeSessions(workload): string[] {
      prune();
      return liveIdsFor(workload);
    },
    checkUnload(workload, checkOpts): SessionUnloadCheck {
      prune();
      const ids = liveIdsFor(workload);
      if (ids.length === 0) return { ok: true, released: [] };
      if (checkOpts?.force !== true) {
        return { ok: false, reason: "SessionActive", sessions: ids };
      }
      for (const id of ids) sessions.delete(id);
      return { ok: true, released: ids };
    },
    snapshot(): SessionSnapshot {
      prune();
      return buildSessionSnapshot(sessions, now(), idleTimeoutMs);
    },
    releaseSession(sessionId, opts): SessionReleaseResult {
      requireNonEmpty(sessionId, "sessionId");
      prune();
      return releaseSessionFrom(sessions, sessionId, opts, now);
    },
  };
}

function releaseSessionFrom(
  sessions: Map<string, SessionEntry>,
  sessionId: string,
  opts: { force?: boolean } | undefined,
  now: () => number,
): SessionReleaseResult {
  const entry = sessions.get(sessionId);
  if (entry === undefined) {
    return { ok: false, reason: "SessionNotFound", sessionId };
  }
  if (entry.refs > 0) {
    if (opts?.force !== true) {
      return {
        ok: false,
        reason: "SessionInFlight",
        sessionId,
        workload: entry.workload,
        refs: entry.refs,
      };
    }
    const refsBefore = entry.refs;
    sessions.delete(sessionId);
    return {
      ok: true,
      sessionId,
      workload: entry.workload,
      refs: refsBefore,
      forced: true,
    };
  }
  sessions.delete(sessionId);
  return {
    ok: true,
    sessionId,
    workload: entry.workload,
    refs: 0,
    forced: false,
  };
}

function buildSessionSnapshot(
  sessions: ReadonlyMap<string, SessionEntry>,
  nowMs: number,
  idleTimeoutMs: number,
): SessionSnapshot {
  const rows: SessionSnapshotRow[] = [];
  for (const [sessionId, entry] of sessions) {
    const idleMs = nowMs - entry.lastActivityMs;
    const expiresInMs = entry.refs > 0 ? null : Math.max(0, idleTimeoutMs - idleMs);
    rows.push({ sessionId, workload: entry.workload, refs: entry.refs, idleMs, expiresInMs });
  }
  rows.sort(
    (a, b) =>
      a.idleMs - b.idleMs ||
      a.workload.localeCompare(b.workload) ||
      a.sessionId.localeCompare(b.sessionId),
  );
  return { idleTimeoutMs, sessions: rows };
}
