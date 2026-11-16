// DF-05 (#278): operator forced unload — the explicit, audited override that
// drives the lease fence to completion regardless of held leases. It is the
// counterpart of stop-fence.ts: where that refuses a stop while leases are
// held, this revokes them through the fencing drain token, commits the unload
// and then stops the engine. commitUnload revokes before the engine stops, so
// an in-flight request is aborted before its server dies, and the #686 onAudit
// sink persists the entry. Note that core audits only revocations, so an idle
// force-unload (no leases held) writes no lease-audit row; a typed `source`
// column on the audit and an idle-unload audit record are follow-ups.
//
// #520: the same drain also drops the workload's session refcounts — the
// explicit force is the override for the stop fence's SessionsActive
// refusal. forceRelease runs under the drain before commitUnload, and a
// failed stop leaves the sessions dropped, like the revoked leases staying
// revoked.

import type { ResidencyLeases } from "@llamactl/core/residency/leases";

import { currentSessionRefcounts, type SessionRefcounts } from "@llamactl/core/residency/sessions";

export const OPERATOR_FORCE_UNLOAD_SOURCE = "operator" as const;

export type ForceUnloadKind = "modelrun" | "modelhost";

export type ForceUnloadStop = () => Promise<{ stopped: boolean; detail?: string }>;

export type ForceUnloadWorkloadOptions = {
  workload: string;
  reason: string;
  kind: ForceUnloadKind | null;
  registry: ResidencyLeases | null;
  stop: ForceUnloadStop;
  sessions?: SessionRefcounts | null;
};

export type ForceUnloadResult =
  | {
      ok: true;
      workload: string;
      kind: ForceUnloadKind;
      epoch: number;
      revoked: string[];
      releasedSessions: string[];
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
      releasedSessions: string[];
      detail: string;
    };

/** Drops the workload's session refcounts under the caller's drain. An
 * explicit `null` skips the release; `undefined` resolves the installed
 * process-wide registry. A throwing registry is reported, never swallowed. */
function forceReleaseSessions(
  sessions: SessionRefcounts | null | undefined,
  workload: string,
): { ok: true; sessions: string[] } | { ok: false; error: string } {
  const registry = sessions === undefined ? currentSessionRefcounts() : sessions;
  if (registry === null) return { ok: true, sessions: [] };
  try {
    return { ok: true, sessions: registry.forceRelease(workload) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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

  const released = forceReleaseSessions(opts.sessions, workload);
  if (!released.ok) {
    registry.cancelDrain(d.token);
    return {
      ok: false,
      reason: "Unavailable",
      workload,
      detail: `session registry could not release ${workload} (${released.error}); nothing was unloaded or stopped`,
    };
  }
  const releasedSessions = released.sessions;

  const c = registry.commitUnload(d.token, { force: true, reason: `operator: ${reason}` });
  if (!c.ok) {
    // Unreachable in-tick: nothing between beginDrain and commitUnload
    // yields, so the drain token cannot go stale. Kept as a guard —
    // cancelDrain is then a no-op that releases nothing it does not own;
    // the engine is not stopped.
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
      releasedSessions,
      stopped: true,
      source: OPERATOR_FORCE_UNLOAD_SOURCE,
      reason,
    };
  }

  // The stop failed or was unverified: the engine may still be serving, so
  // reopen admission at the committed epoch. The revoked leases and the
  // released sessions stay released.
  registry.reopen(d.token);
  return {
    ok: false,
    reason: "StopFailed",
    workload,
    revoked: c.revoked,
    releasedSessions,
    detail: detail ?? "stop not verified",
  };
}
