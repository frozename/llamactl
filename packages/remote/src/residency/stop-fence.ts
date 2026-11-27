/**
 * Node-side stop fence for serverStop/modelHostStop (#278 DF-05, #280 DF-07).
 * Mirrors the #599 engine-client drain pattern: beginDrain blocks new
 * acquires, held leases refuse the stop, and a verified stop commits the
 * unload so the workload stays `unloaded` at the advanced epoch — a stopped
 * engine must not admit new requests, which would 503 model_not_loaded
 * against a dead server. Only a later load (reopenWorkloadAfterLoad, now the
 * core helper re-exported below) returns it to open. An unverified or failed
 * stop cancels the drain back to open.
 *
 * #280 DF-07: for the stop's duration the workload's local routes are withdrawn
 * from the openaiProxy serving gate, so a pin during the window is refused
 * draining instead of forwarded to a dying engine. The withdrawal wraps only
 * the stop and its commit/cancel decision — never beginDrain or a refusal — and
 * is released on every settle: a verified stop leaves the route gone (the
 * runtime record is gone), while an unverified or thrown stop restores it (the
 * #677 rollback). The stop RESULT is still byte-identical when no registry is
 * published; the only addition is that the workload's local routes are withdrawn
 * for the stop's duration.
 *
 * #520: the session-refcount registry composes the same way — sessions refuse
 * like leases. After a successful beginDrain and the LeasesActive check (which
 * keeps precedence), checkUnload runs in the same synchronous tick; a live
 * session refuses SessionsActive and a throwing registry SessionsUnknown, and
 * the drain is cancelled either way — before any route withdrawal or stop. The
 * fence never releases sessions; the explicit override is
 * `residency force-unload`.
 */

import { openaiProxy } from "@llamactl/core";
import {
  type DrainToken,
  getResidencyLeaseRegistry,
  type ResidencyLeases,
} from "@llamactl/core/residency/leases";
import {
  currentSessionRefcounts,
  type SessionRefcounts,
  type SessionUnloadCheck,
} from "@llamactl/core/residency/sessions";

export type StopFenceRefusal = {
  reason: "LeasesActive" | "DrainInProgress" | "SessionsActive" | "SessionsUnknown";
  active: string[];
};

export interface FenceWorkloadStopOptions<R> {
  workload: string;
  stop: () => Promise<R>;
  isVerifiedStop: (r: R) => boolean;
  refuse: (f: StopFenceRefusal) => R;
  registry?: ResidencyLeases | null;
  sessions?: SessionRefcounts | null;
  wait?: { timeoutMs: number; signal: AbortSignal | undefined };
}

async function withRouteWithdrawn<R>(workload: string, run: () => Promise<R>): Promise<R> {
  const release = openaiProxy.withdrawServingRoute(workload);
  try {
    return await run();
  } finally {
    release();
  }
}

async function waitForStopLeases(
  registry: ResidencyLeases,
  token: DrainToken,
  wait: NonNullable<FenceWorkloadStopOptions<unknown>["wait"]>,
): Promise<StopFenceRefusal | undefined> {
  const timeout = AbortSignal.timeout(wait.timeoutMs);
  const signal = wait.signal === undefined ? timeout : AbortSignal.any([timeout, wait.signal]);
  const idle = await registry.whenIdle(token, { signal });
  const snapshot = registry.snapshot(token.workload);
  if (snapshot.epoch !== token.epoch || snapshot.phase !== "draining") {
    return { reason: "DrainInProgress", active: snapshot.active };
  }
  return !idle.idle || signal.aborted
    ? { reason: "LeasesActive", active: snapshot.active }
    : undefined;
}

function activeLeasesRefusal(active: string[]): StopFenceRefusal | undefined {
  return active.length > 0 ? { reason: "LeasesActive", active } : undefined;
}

async function runFenced<R>(
  registry: ResidencyLeases,
  opts: FenceWorkloadStopOptions<R>,
): Promise<R> {
  const d = registry.beginDrain(opts.workload);
  if (!d.ok) {
    if (d.reason === "AlreadyDraining" || opts.wait !== undefined) {
      return opts.refuse({ reason: "DrainInProgress", active: registry.active(opts.workload) });
    }
    return await withRouteWithdrawn(opts.workload, opts.stop);
  }
  const refusal =
    opts.wait === undefined
      ? activeLeasesRefusal(d.active)
      : await waitForStopLeases(registry, d.token, opts.wait);
  if (refusal !== undefined) {
    registry.cancelDrain(d.token);
    return opts.refuse(refusal);
  }
  const sessions = opts.sessions === undefined ? currentSessionRefcounts() : opts.sessions;
  if (sessions !== null) {
    let check: SessionUnloadCheck;
    try {
      check = sessions.checkUnload(opts.workload);
    } catch {
      registry.cancelDrain(d.token);
      return opts.refuse({ reason: "SessionsUnknown", active: [] });
    }
    if (!check.ok) {
      registry.cancelDrain(d.token);
      return opts.refuse({ reason: "SessionsActive", active: [...check.sessions] });
    }
  }
  return await withRouteWithdrawn(opts.workload, async () => {
    let r: R;
    try {
      r = await opts.stop();
    } catch (e) {
      registry.cancelDrain(d.token);
      throw e;
    }
    if (opts.isVerifiedStop(r)) {
      registry.commitUnload(d.token);
      return r;
    }
    registry.cancelDrain(d.token);
    return r;
  });
}

export function fenceWorkloadStop<R>(opts: FenceWorkloadStopOptions<R>): Promise<R> {
  const registry = opts.registry === undefined ? getResidencyLeaseRegistry() : opts.registry;
  if (registry === null) {
    if (opts.wait !== undefined)
      return Promise.resolve(opts.refuse({ reason: "DrainInProgress", active: [] }));
    return withRouteWithdrawn(opts.workload, opts.stop);
  }
  return runFenced(registry, opts);
}

export { reopenWorkloadAfterLoad } from "@llamactl/core/residency/leases";
