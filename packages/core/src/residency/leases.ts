/**
 * Request-lifetime residency leases with a fencing drain token (Refs #278,
 * DF-05). Pure and adapter-free: no IO, no timers, no TTL expiry. A lease is
 * freed only by release, bound-body settlement, or an explicit forced
 * commitUnload.
 *
 * The clock is injectable (Part of #519): `ResidencyLeasesOptions.now`
 * defaults to `Date.now` and is read only to stamp per-workload activity —
 * once at registry creation (the seed returned by `lastActivityAtMs` for a
 * workload never touched) and on a successful acquire or a release that
 * actually removes a lease. Nothing here schedules a timer or expires a lease
 * on idle; `lastActivityAtMs` is a read-out for the residency status
 * advisory, not a trigger.
 *
 * This module composes with sessions.ts (#569) as the fencing drain token
 * required before ingress wiring.
 *
 * The only mutable state here is the process-wide nullable registry binding
 * below: an opt-in seam with no I/O of its own. Null (the default) leaves
 * every ingress unchanged; a host installs a registry to activate
 * lease-checked admission. The same seam drives the `withReopenAfterLoad` /
 * `reopenWorkloadAfterLoad` helpers at the bottom of this module.
 *
 * Durability extension of AC3 (#278, DF-05): `createResidencyLeases` takes an
 * optional `onAudit` sink called once per forced-unload audit entry, after the
 * in-memory push. The sink runs synchronously inside commitUnload, so it must
 * be fast and bounded, and it cannot fail an unload: its errors are swallowed
 * and later unloads still call it. The in-memory audit stays authoritative for
 * the process lifetime; the sink only mirrors it outward. Each registry stamps
 * its entries with one incarnation id, generated when it is created, so a
 * persisted entry from an earlier process never matches a live one.
 */

import type {
  AcquireResult,
  BeginDrainResult,
  CommitUnloadResult,
  DrainToken,
  Lease,
  ResidencyAuditEntry,
  ResidencyLeases,
  ResidencySnapshot,
  WhenIdleResult,
} from "./types.js";

export type {
  AcquireResult,
  BeginDrainResult,
  CommitUnloadResult,
  DrainToken,
  Lease,
  ResidencyAuditEntry,
  ResidencyLeases,
  ResidencySnapshot,
  WhenIdleResult,
};

// ── Process-wide registry seam ──────────────────────────────────────────

let installedRegistry: ResidencyLeases | null = null;

export function setResidencyLeaseRegistry(registry: ResidencyLeases | null): void {
  installedRegistry = registry;
}

export function getResidencyLeaseRegistry(): ResidencyLeases | null {
  return installedRegistry;
}

/**
 * Reopen admission after a successful load (Part of #278, DF-05). A verified
 * stop leaves the workload `unloaded`, so a later start is the only event that
 * returns it to open. A single snapshot drives both the phase guard and the
 * reopen epoch, so the reopen cannot race a phase change between two reads.
 * Inert without a registry, when the load did not succeed, or when the workload
 * is not parked unloaded.
 */
export function reopenWorkloadAfterLoad(
  workload: string,
  loaded: boolean,
  registry?: ResidencyLeases | null,
): void {
  const reg = registry === undefined ? installedRegistry : registry;
  if (reg === null || !loaded) {
    return;
  }
  const snap = reg.snapshot(workload);
  if (snap.phase === "unloaded") {
    reg.reopen({ workload, epoch: snap.epoch });
  }
}

/**
 * Wrap a start call so a successful load reopens admission (Part of #278,
 * DF-05). Inert without a published registry: the default path returns the
 * `start()` promise unchanged, adding no await. A rejection propagates without
 * reopening; only a resolved, loaded result reopens.
 */
export function withReopenAfterLoad<R>(
  workload: string,
  start: () => Promise<R>,
  isLoaded: (r: R) => boolean,
  registry?: ResidencyLeases | null,
): Promise<R> {
  const reg = registry === undefined ? installedRegistry : registry;
  if (reg === null) {
    return start();
  }
  return start().then((r) => {
    reopenWorkloadAfterLoad(workload, isLoaded(r), reg);
    return r;
  });
}

// ── Internal types ──────────────────────────────────────────────────────

type Phase = "open" | "draining" | "unloaded";

interface WorkloadState {
  phase: Phase;
  epoch: number;
  leases: Map<string, { lease: Lease; abort: AbortController }>;
  waiters: Set<
    (result: { idle: true } | { idle: false; reason: string; active: string[] }) => void
  >;
}

// ── Helpers (module-level, small) ───────────────────────────────────────

function settleWaiters(
  state: WorkloadState,
  result: { idle: true } | { idle: false; reason: string; active: string[] },
): void {
  for (const waiter of state.waiters) {
    waiter(result);
  }
  state.waiters.clear();
}

function revokeAll(state: WorkloadState, reason: Error): string[] {
  const revoked: string[] = [];
  for (const [id, entry] of state.leases) {
    revoked.push(id);
    state.leases.delete(id);
    entry.abort.abort(reason);
  }
  return revoked;
}

function registryFor(registries: Map<string, WorkloadState>, workload: string): WorkloadState {
  let state = registries.get(workload);
  if (state === undefined) {
    state = { phase: "open", epoch: 0, leases: new Map(), waiters: new Set() };
    registries.set(workload, state);
  }
  return state;
}

function activeIds(state: WorkloadState): string[] {
  const ids: string[] = [];
  for (const id of state.leases.keys()) {
    ids.push(id);
  }
  return ids;
}

// ── Bound body ──────────────────────────────────────────────────────────

function bindLeaseToBody(
  body: ReadableStream<Uint8Array>,
  lease: Lease,
  onSettle?: () => void,
): ReadableStream<Uint8Array> {
  let settled = false;
  let readerClosed = false;
  let outerController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const reader = body.getReader();

  function settle(): void {
    if (settled) return;
    settled = true;
    lease.release();
    lease.signal.removeEventListener("abort", abortListener);
    if (onSettle !== undefined) onSettle();
  }

  function ensureReaderClosed(): void {
    if (readerClosed) return;
    readerClosed = true;
    void reader.cancel().catch(() => undefined);
  }

  // Listen for forced revocation while a read is pending (idle upstream
  // case).  The abort check at the top of pull() only fires when the
  // signal was *already* aborted before the first pull(); a forced
  // commitUnload that happens while reader.read() is awaiting will
  // leave the consumer hanging without this listener.
  //
  // On abort: error the OUTER stream via the saved controller so the
  // consumer sees a revoked stream (not a normal end-of-stream).  Then
  // cancel the upstream reader to unblock any pending read.  Marking
  // settled here keeps onSettle exactly-once inside this module: a later
  // settle() from the cancelled read must not fire it a second time.
  const abortListener = (): void => {
    if (settled) return;
    settled = true;
    if (outerController !== null) {
      outerController.error(lease.signal.reason);
    }
    ensureReaderClosed();
    if (onSettle !== undefined) onSettle();
  };
  lease.signal.addEventListener("abort", abortListener, { once: true });
  // A lease revoked before it is bound (forced commitUnload landing in the
  // post-forward awaits) never dispatches to the listener above, and the
  // pull() abort branch errors without settling. Settle eagerly here; the
  // once-guard in abortListener keeps onSettle exactly-once.
  if (lease.signal.aborted) abortListener();

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      // Save the controller so the abort listener can error this stream.
      outerController = controller;

      // Handle already-aborted signal at pull time (start has not drained)
      if (lease.signal.aborted) {
        ensureReaderClosed();
        controller.error(lease.signal.reason);
        return;
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          ensureReaderClosed();
          settle();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        ensureReaderClosed();
        settle();
        controller.error(err);
      }
    },
    cancel(): void {
      ensureReaderClosed();
      settle();
    },
  });
}

// ── Exposed boundary ────────────────────────────────────────────────────

/**
 * Optional durability seam for the forced-unload audit (Part of #278, DF-05).
 * `onAudit` runs synchronously inside `commitUnload`, once per forced entry
 * with a fresh copy, after the in-memory push. It must be fast and bounded, and
 * it cannot fail an unload: errors are swallowed and later unloads still call
 * it. The in-memory audit stays authoritative for the process lifetime.
 *
 * `now` (Part of #519) is the injectable clock used to stamp per-workload
 * activity, defaulting to `Date.now`. It is read only to stamp; it never
 * schedules anything.
 */
export type ResidencyLeasesOptions = {
  onAudit?: (entry: ResidencyAuditEntry) => void;
  now?: () => number;
};

function makeLease(
  state: WorkloadState,
  workload: string,
  n: number,
  onActivity: (workload: string) => void,
): AcquireResult {
  const id = `${workload}#${String(n)}`;
  const abort = new AbortController();

  const lease: Lease = {
    id,
    workload,
    epoch: state.epoch,
    signal: abort.signal,
    release(): boolean {
      const entry = state.leases.get(id);
      if (entry === undefined) return false;
      state.leases.delete(id);
      if (state.leases.size === 0 && state.phase === "draining") {
        settleWaiters(state, { idle: true });
      }
      onActivity(workload);
      return true;
    },
  };

  state.leases.set(id, { lease, abort });
  onActivity(workload);
  return { ok: true, lease };
}

function acquireLease(
  registries: Map<string, WorkloadState>,
  counters: Map<string, number>,
  workload: string,
  onActivity: (workload: string) => void,
): AcquireResult {
  const state = registryFor(registries, workload);
  if (state.phase === "draining" || state.phase === "unloaded") {
    return {
      ok: false,
      reason: (state.phase.charAt(0).toUpperCase() + state.phase.slice(1)) as
        | "Draining"
        | "Unloaded",
      workload,
      epoch: state.epoch,
    };
  }
  const n = (counters.get(workload) ?? 0) + 1;
  counters.set(workload, n);
  return makeLease(state, workload, n, onActivity);
}

function whenIdleImpl(
  registries: Map<string, WorkloadState>,
  token: DrainToken,
  opts?: { signal?: AbortSignal },
): Promise<WhenIdleResult> {
  return new Promise<WhenIdleResult>((resolve) => {
    const state = registries.get(token.workload);
    if (state === undefined) {
      resolve({ idle: false, reason: "StaleDrainToken", active: [] });
      return;
    }

    // Not current epoch or open phase → stale
    if (token.epoch !== state.epoch || state.phase === "open") {
      resolve({ idle: false, reason: "StaleDrainToken", active: activeIds(state) });
      return;
    }

    // Check if the provided signal is already aborted
    if (opts?.signal?.aborted === true) {
      resolve({ idle: false, reason: "Aborted", active: activeIds(state) });
      return;
    }

    // No leases → already idle
    if (state.leases.size === 0) {
      resolve({ idle: true });
      return;
    }

    // Capture state for closures (TS doesn't narrow inside closures)
    const activeState = state;

    // Register a waiter
    let listenerAttached = false;

    function settle(): void {
      if (listenerAttached) {
        opts?.signal?.removeEventListener("abort", listener);
        listenerAttached = false;
      }
    }

    function listener(): void {
      settle();
      activeState.waiters.delete(waiter);
      resolve({ idle: false, reason: "Aborted", active: activeIds(activeState) });
    }

    if (opts?.signal) {
      opts.signal.addEventListener("abort", listener, { once: true });
      listenerAttached = true;
    }

    const waiter = (
      result: { idle: true } | { idle: false; reason: string; active: string[] },
    ): void => {
      settle();
      activeState.waiters.delete(waiter);
      resolve(result as WhenIdleResult);
    };

    state.waiters.add(waiter);
  });
}

// Per-workload activity read-out (Part of #519). Seeded with the creation time
// so an untouched workload reports the registry's own creation time, not 0 or
// the first query time. Stamped on a successful acquire and on a release that
// removed a lease; never on a refused acquire, a no-op release or a forced
// revoke. Extracted to keep createResidencyLeases under the function length cap.
function createActivityTracker(now: () => number): {
  stampActivity: (workload: string) => void;
  lastActivityAtMs: (workload: string) => number;
} {
  const createdAtMs = now();
  const lastActivity = new Map<string, number>();
  return {
    stampActivity: (workload: string): void => {
      lastActivity.set(workload, now());
    },
    lastActivityAtMs: (workload: string): number => lastActivity.get(workload) ?? createdAtMs,
  };
}

// Append a forced-unload audit entry, trimming the ring to the newest 1024.
function pushAuditEntry(auditLog: ResidencyAuditEntry[], entry: ResidencyAuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > 1024) {
    auditLog.splice(0, auditLog.length - 1024);
  }
}

export function createResidencyLeases(opts?: ResidencyLeasesOptions): ResidencyLeases {
  const registries = new Map<string, WorkloadState>();
  const counters = new Map<string, number>();
  const auditLog: ResidencyAuditEntry[] = [];
  // One id per registry (the serving process installs one), stamped on every
  // audit entry it writes, so entries from different process lifetimes never
  // share a (workload, epoch, revoked, reason) identity.
  const incarnation = crypto.randomUUID();
  // Injectable clock (Part of #519): read only to stamp per-workload activity,
  // never to schedule.
  const now = opts?.now ?? Date.now;
  const activity = createActivityTracker(now);

  function notifyAuditSink(entry: ResidencyAuditEntry): void {
    const sink = opts?.onAudit;
    if (sink === undefined) {
      return;
    }
    const copy: ResidencyAuditEntry = { ...entry, revoked: [...entry.revoked] };
    try {
      sink(copy);
    } catch {
      // The sink is observability only: a failing sink never fails an unload
      // and is retried on every later forced commitUnload.
    }
  }

  function acquire(workload: string): AcquireResult {
    return acquireLease(registries, counters, workload, activity.stampActivity);
  }

  function active(workload: string): string[] {
    const state = registries.get(workload);
    if (state === undefined) return [];
    return activeIds(state);
  }

  function beginDrain(workload: string): BeginDrainResult {
    const state = registryFor(registries, workload);
    if (state.phase === "unloaded") {
      return { ok: false, reason: "Unloaded", workload, epoch: state.epoch };
    }
    if (state.phase === "draining") {
      return { ok: false, reason: "AlreadyDraining", workload, epoch: state.epoch };
    }
    state.epoch += 1;
    state.phase = "draining";
    return { ok: true, token: { workload, epoch: state.epoch }, active: activeIds(state) };
  }

  function whenIdle(token: DrainToken, opts?: { signal?: AbortSignal }): Promise<WhenIdleResult> {
    return whenIdleImpl(registries, token, opts);
  }

  function commitUnload(
    token: DrainToken,
    unloadOpts?: { force?: boolean; reason?: string },
  ): CommitUnloadResult {
    const state = registries.get(token.workload);
    if (token.epoch !== state?.epoch || state.phase !== "draining") {
      return { ok: false, reason: "StaleDrainToken" };
    }

    if (state.leases.size > 0 && unloadOpts?.force !== true) {
      return { ok: false, reason: "LeasesActive", active: activeIds(state) };
    }

    let revoked: string[] = [];
    if (unloadOpts?.force === true && state.leases.size > 0) {
      revoked = revokeAll(state, new Error("lease revoked: forced unload"));
      const entry: ResidencyAuditEntry = {
        workload: token.workload,
        epoch: state.epoch,
        forced: true,
        revoked,
        ...(unloadOpts.reason !== undefined ? { reason: unloadOpts.reason } : {}),
        incarnation,
      };
      pushAuditEntry(auditLog, entry);
      notifyAuditSink(entry);
    }

    state.phase = "unloaded";
    settleWaiters(state, { idle: true });
    return { ok: true, revoked };
  }

  function cancelDrain(token: DrainToken): boolean {
    const state = registries.get(token.workload);
    if (token.epoch !== state?.epoch || state.phase !== "draining") {
      return false;
    }
    state.phase = "open";
    settleWaiters(state, { idle: false, reason: "DrainCancelled", active: activeIds(state) });
    return true;
  }

  function reopen(token: DrainToken): boolean {
    const state = registries.get(token.workload);
    if (token.epoch !== state?.epoch || state.phase !== "unloaded") {
      return false;
    }
    state.phase = "open";
    return true;
  }

  function waiterCount(workload: string): number {
    return countWaiters(registries, workload);
  }

  function snapshot(workload: string): ResidencySnapshot {
    const state = registries.get(workload);
    if (state === undefined) {
      return { workload, phase: "open", epoch: 0, active: [], waiters: 0 };
    }
    return {
      workload,
      phase: state.phase,
      epoch: state.epoch,
      active: activeIds(state),
      waiters: state.waiters.size,
    };
  }

  function audit(): ResidencyAuditEntry[] {
    return [...auditLog];
  }

  return {
    acquire,
    active,
    beginDrain,
    whenIdle,
    commitUnload,
    cancelDrain,
    reopen,
    snapshot,
    waiterCount,
    audit,
    lastActivityAtMs: activity.lastActivityAtMs,
  };
}

export { bindLeaseToBody };

function countWaiters(registries: Map<string, WorkloadState>, workload: string): number {
  const state = registries.get(workload);
  if (state === undefined) return 0;
  return state.waiters.size;
}
