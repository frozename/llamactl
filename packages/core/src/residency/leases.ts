/**
 * Request-lifetime residency leases with a fencing drain token (Refs #278,
 * DF-05). Pure and adapter-free: no IO, no timers, no Date.now, no TTL
 * expiry. A lease is freed only by release, bound-body settlement, or an
 * explicit forced commitUnload.
 *
 * This module composes with sessions.ts (#569) as the fencing drain token
 * required before ingress wiring.
 *
 * The only mutable state here is the process-wide nullable registry binding
 * below: an opt-in seam with no I/O of its own. Null (the default) leaves
 * every ingress unchanged; a host installs a registry to activate
 * lease-checked admission.
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

function makeLease(state: WorkloadState, workload: string, n: number): AcquireResult {
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
      return true;
    },
  };

  state.leases.set(id, { lease, abort });
  return { ok: true, lease };
}

function acquireLease(
  registries: Map<string, WorkloadState>,
  counters: Map<string, number>,
  workload: string,
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
  return makeLease(state, workload, n);
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

export function createResidencyLeases(): ResidencyLeases {
  const registries = new Map<string, WorkloadState>();
  const counters = new Map<string, number>();
  const auditLog: ResidencyAuditEntry[] = [];

  function acquire(workload: string): AcquireResult {
    return acquireLease(registries, counters, workload);
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
    opts?: { force?: boolean; reason?: string },
  ): CommitUnloadResult {
    const state = registries.get(token.workload);
    if (token.epoch !== state?.epoch || state.phase !== "draining") {
      return { ok: false, reason: "StaleDrainToken" };
    }

    if (state.leases.size > 0 && opts?.force !== true) {
      return { ok: false, reason: "LeasesActive", active: activeIds(state) };
    }

    let revoked: string[] = [];
    if (opts?.force === true && state.leases.size > 0) {
      revoked = revokeAll(state, new Error("lease revoked: forced unload"));
      auditLog.push({
        workload: token.workload,
        epoch: state.epoch,
        forced: true,
        revoked,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      });
      if (auditLog.length > 1024) {
        auditLog.splice(0, auditLog.length - 1024);
      }
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
  };
}

export { bindLeaseToBody };

function countWaiters(registries: Map<string, WorkloadState>, workload: string): number {
  const state = registries.get(workload);
  if (state === undefined) return 0;
  return state.waiters.size;
}
