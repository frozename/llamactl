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
 */

import { openaiProxy } from "@llamactl/core";
import { getResidencyLeaseRegistry, type ResidencyLeases } from "@llamactl/core/residency/leases";

export type StopFenceRefusal = {
  reason: "LeasesActive" | "DrainInProgress";
  active: string[];
};

export interface FenceWorkloadStopOptions<R> {
  workload: string;
  stop: () => Promise<R>;
  isVerifiedStop: (r: R) => boolean;
  refuse: (f: StopFenceRefusal) => R;
  registry?: ResidencyLeases | null;
}

async function withRouteWithdrawn<R>(workload: string, run: () => Promise<R>): Promise<R> {
  const release = openaiProxy.withdrawServingRoute(workload);
  try {
    return await run();
  } finally {
    release();
  }
}

async function runFenced<R>(
  registry: ResidencyLeases,
  opts: FenceWorkloadStopOptions<R>,
): Promise<R> {
  const d = registry.beginDrain(opts.workload);
  if (!d.ok) {
    if (d.reason === "AlreadyDraining") {
      return opts.refuse({ reason: "DrainInProgress", active: registry.active(opts.workload) });
    }
    return await withRouteWithdrawn(opts.workload, opts.stop);
  }
  if (d.active.length > 0) {
    registry.cancelDrain(d.token);
    return opts.refuse({ reason: "LeasesActive", active: d.active });
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
    return withRouteWithdrawn(opts.workload, opts.stop);
  }
  return runFenced(registry, opts);
}

export { reopenWorkloadAfterLoad } from "@llamactl/core/residency/leases";
