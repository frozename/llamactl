/**
 * Node-side stop fence for serverStop/modelHostStop (Part of #278, DF-05).
 * Mirrors the #599 engine-client drain pattern: beginDrain blocks new
 * acquires, held leases refuse the stop, and a verified stop cycles
 * commitUnload+reopen so the epoch advances while the phase returns to open.
 * Inert when no registry is published: the stop promise is returned
 * unwrapped, byte-identical to the unfenced call.
 */

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

async function runFenced<R>(
  registry: ResidencyLeases,
  opts: FenceWorkloadStopOptions<R>,
): Promise<R> {
  const d = registry.beginDrain(opts.workload);
  if (!d.ok) {
    if (d.reason === "AlreadyDraining") {
      return opts.refuse({ reason: "DrainInProgress", active: registry.active(opts.workload) });
    }
    return await opts.stop();
  }
  if (d.active.length > 0) {
    registry.cancelDrain(d.token);
    return opts.refuse({ reason: "LeasesActive", active: d.active });
  }
  let r: R;
  try {
    r = await opts.stop();
  } catch (e) {
    registry.cancelDrain(d.token);
    throw e;
  }
  if (opts.isVerifiedStop(r)) {
    const c = registry.commitUnload(d.token);
    if (c.ok) {
      registry.reopen(d.token);
    }
    return r;
  }
  registry.cancelDrain(d.token);
  return r;
}

export function fenceWorkloadStop<R>(opts: FenceWorkloadStopOptions<R>): Promise<R> {
  const registry = opts.registry === undefined ? getResidencyLeaseRegistry() : opts.registry;
  if (registry === null) {
    return opts.stop();
  }
  return runFenced(registry, opts);
}
