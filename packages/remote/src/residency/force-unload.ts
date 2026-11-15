// DF-05 (#278): operator forced unload — the explicit, audited override that
// drives the lease fence to completion regardless of held leases. It is the
// counterpart of stop-fence.ts: where that refuses a stop while leases are
// held, this revokes them through the fencing drain token, commits the unload
// and then stops the engine. commitUnload revokes before the engine stops, so
// an in-flight request is aborted before its server dies, and the #686 onAudit
// sink persists the entry. Note that core audits only revocations, so an idle
// force-unload (no leases held) writes no lease-audit row; a typed `source`
// column on the audit and an idle-unload audit record are follow-ups.

import type { ResidencyLeases } from "@llamactl/core/residency/leases";

export const OPERATOR_FORCE_UNLOAD_SOURCE = "operator" as const;

export type ForceUnloadKind = "modelrun" | "modelhost";

export type ForceUnloadStop = () => Promise<{ stopped: boolean; detail?: string }>;

export type ForceUnloadWorkloadOptions = {
  workload: string;
  reason: string;
  kind: ForceUnloadKind | null;
  registry: ResidencyLeases | null;
  stop: ForceUnloadStop;
};

export type ForceUnloadResult =
  | {
      ok: true;
      workload: string;
      kind: ForceUnloadKind;
      epoch: number;
      revoked: string[];
      stopped: true;
      source: typeof OPERATOR_FORCE_UNLOAD_SOURCE;
      reason: string;
    }
  | { ok: false; reason: "Unavailable"; workload: string; detail: string }
  | { ok: false; reason: "UnknownWorkload"; workload: string; detail: string }
  | { ok: false; reason: "DrainInProgress"; workload: string; detail: string }
  | { ok: false; reason: "AlreadyUnloaded"; workload: string; detail: string }
  | {
      ok: false;
      reason: "StopFailed";
      workload: string;
      revoked: string[];
      detail: string;
    };

export async function forceUnloadWorkload(
  opts: ForceUnloadWorkloadOptions,
): Promise<ForceUnloadResult> {
  const { workload, reason, kind, registry, stop } = opts;

  if (registry === null) {
    return {
      ok: false,
      reason: "Unavailable",
      workload,
      detail: "no residency lease registry installed; nothing to fence",
    };
  }

  if (kind === null) {
    return {
      ok: false,
      reason: "UnknownWorkload",
      workload,
      detail: `no ModelRun or ModelHost named ${workload}`,
    };
  }

  const d = registry.beginDrain(workload);
  if (!d.ok) {
    if (d.reason === "AlreadyDraining") {
      return {
        ok: false,
        reason: "DrainInProgress",
        workload,
        detail: "a drain is already in progress; retry after it settles",
      };
    }
    return {
      ok: false,
      reason: "AlreadyUnloaded",
      workload,
      detail: "workload is already unloaded at this epoch",
    };
  }

  const c = registry.commitUnload(d.token, { force: true, reason: `operator: ${reason}` });
  if (!c.ok) {
    // A forced commit refuses only a stale token (the epoch moved or the
    // phase left draining). cancelDrain is then a no-op that releases nothing
    // it does not own; the engine is not stopped.
    registry.cancelDrain(d.token);
    return {
      ok: false,
      reason: "DrainInProgress",
      workload,
      detail: "commitUnload refused a stale drain token; nothing was unloaded or stopped",
    };
  }

  let stopped = false;
  let detail: string | undefined;
  try {
    const r = await stop();
    stopped = r.stopped;
    detail = r.detail;
  } catch (e) {
    stopped = false;
    detail = e instanceof Error ? e.message : String(e);
  }

  if (stopped) {
    return {
      ok: true,
      workload,
      kind,
      epoch: d.token.epoch,
      revoked: c.revoked,
      stopped: true,
      source: OPERATOR_FORCE_UNLOAD_SOURCE,
      reason,
    };
  }

  // The stop failed or was unverified: the engine may still be serving, so
  // reopen admission at the committed epoch. The revoked leases stay revoked.
  registry.reopen(d.token);
  return {
    ok: false,
    reason: "StopFailed",
    workload,
    revoked: c.revoked,
    detail: detail ?? "stop not verified",
  };
}
