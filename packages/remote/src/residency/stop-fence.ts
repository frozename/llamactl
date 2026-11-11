/**
 * Node-side stop fence for serverStop/modelHostStop (Part of #278, DF-05).
 * Mirrors the #599 engine-client drain pattern: beginDrain blocks new
 * acquires, held leases refuse the stop, and a verified stop commits the
 * unload so the workload stays `unloaded` at the advanced epoch — a stopped
 * engine must not admit new requests, which would 503 model_not_loaded
 * against a dead server. Only a later load (reopenWorkloadAfterLoad) returns
 * it to open. An unverified or failed stop cancels the drain back to open.
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
    registry.commitUnload(d.token);
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

/**
 * Reopen admission after a successful load (Part of #278, DF-05). A verified
 * stop leaves the workload `unloaded`, so a later start is the only event that
 * returns it to open. Mirrors the #599 engine-client reopen: a single snapshot
 * drives both the phase guard and the reopen epoch, so the reopen cannot race a
 * phase change between two reads. Inert without a registry or when the load
 * did not succeed or the workload is not parked unloaded.
 */
export function reopenWorkloadAfterLoad(
  workload: string,
  loaded: boolean,
  registry?: ResidencyLeases | null,
): void {
  const reg = registry === undefined ? getResidencyLeaseRegistry() : registry;
  if (reg === null || !loaded) {
    return;
  }
  const snap = reg.snapshot(workload);
  if (snap.phase === "unloaded") {
    reg.reopen({ workload, epoch: snap.epoch });
  }
}
