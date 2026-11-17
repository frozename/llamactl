/**
 * Active-session refcounts for residency (#520, #569). Pure and adapter-free:
 * no IO, no timers. proxyOpenAI (openaiProxy.ts) acquires a session per
 * request carrying the session header while both this registry and the
 * DF-05 lease registry (#278) are installed. `agent serve` installs one at
 * start when LLAMACTL_RESIDENCY_LEASES is on and
 * LLAMACTL_RESIDENCY_SESSION_IDLE_MS (milliseconds) is set. proxyOpenAI reads
 * activeSessions to prefer a session's already-bound local workload among the
 * route candidates for a request (affinity across tool calls, #520).
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
 * under its drain.
 *
 * Release is generation-aware (#520 follow-up from the #617 review): a
 * stale release carrying an old generation cannot drop a newer
 * acquisition of the same session ID.
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
  touch(sessionId: string): void;
  forceRelease(workload: string): string[];
  activeSessions(workload: string): string[];
  checkUnload(workload: string, opts?: { force?: boolean }): SessionUnloadCheck;
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
        sessions.set(sessionId, { workload, refs: 1, generation, lastActivityMs: now() });
        return { ok: true, workload, refs: 1, generation };
      }
      if (entry.workload !== workload) {
        return { ok: false, reason: "AffinityConflict", boundWorkload: entry.workload };
      }
      entry.refs += 1;
      entry.lastActivityMs = now();
      return { ok: true, workload, refs: entry.refs, generation: entry.generation };
    },
    release(sessionId, generation): void {
      prune();
      const entry = sessions.get(sessionId);
      if (entry === undefined) return;
      if (generation !== undefined && entry.generation !== generation) return;
      entry.refs = Math.max(0, entry.refs - 1);
      entry.lastActivityMs = now();
    },
    touch(sessionId): void {
      requireNonEmpty(sessionId, "sessionId");
      prune();
      const entry = sessions.get(sessionId);
      if (entry === undefined) return;
      entry.lastActivityMs = now();
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
  };
}
