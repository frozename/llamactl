// #284 (DF-11): pure assembly of the read-only residencyStatus and
// residencyPlan payloads. No IO lives here — the router gathers the NodeRun
// manifest, the budget, the store snapshot and the observed workload state and
// hands them in, so this module stays testable in isolation.
//
// Provenance split: the nodeRun, policy and budget sections come from the
// serving process's NodeRun manifest selected by `node`. The store section and
// the ModelHost pid status are attributed to `node` only when `node` is the
// serving process's own identity (servingNode === node); for any other `node`
// the store echo is the serving process's, never `node`'s coordinator state.
// The leases section is the serving process's in-memory lease/drain registry:
// per-workload phase, epoch, active lease count and waiters plus the recent
// forced-unload audit, reported "unavailable" when no registry is installed.
// recentAudit merges the node-local store rows (which survive a restart) with
// any live in-memory entries the store is missing (a sink write that failed
// quietly), so neither source can hide an entry the other holds.
// The omlxNative section (scope "serving-process") is the serving process's
// oMLX native residency capability probe, per oMLX ModelHost on `node`:
// native, a declared process-fallback, or unknown with a reason. It is only
// probed on the serving process; off it every row is unknown/NotServingNode.
//
// The lifecycle section (scope "serving-process", Part of #517) is the serving
// process's node-local residency_states rows: per-model state, group, whether
// the state occupies capacity, and any exclusive-group violation computed with
// findExclusiveGroupViolations. It is attributed to `node` under the same
// serving-process caveat as the store: for any other `node` these are the
// serving process's rows, never `node`'s coordinator state. A lifecycle-row
// read failure is isolated here as unavailable/LifecycleUnreadable and never
// turns the store section into an error.
//
// The NodeRun residency supplies the planner policy (Part of #519).
// switchCooldownSeconds is measured from the last succeeded
// `profile-switch:<node>` operation recorded in the serving node's store
// snapshot (input.store.lastSucceededAtMs); an explicit lastSwitchAtMs from the
// caller, including null, still wins. minResidencySeconds is measured from the
// time the victim's residency_states row entered `ready` in the serving node's
// store, under the same serving-node and clean-store scoping as the cooldown.
// Loads made outside the fenced profile-switch executor write no lifecycle row
// and are not protected.
//
// The idleEviction section (scope "serving-process", Part of #519) is an
// advisory read-out of the NodeRun idle-evict window against the serving
// process's ready lifecycle rows and serving-process lease activity, only when
// `node` is the serving node. It never evicts, sleeps or schedules anything; a
// 0 knob (or no policy) reports disabled without reading the registry or the
// lifecycle, and lease activity resets when the serving process restarts.
//
// The switchGates section (scope "serving-process", Part of #519) is an
// advisory read-out of the enforced NodeRun switch gates against the serving
// process's store, only when `node` is the serving node: the
// switchCooldownSeconds countdown from the last succeeded `profile-switch:<node>`
// operation, and — when minResidencySeconds is set — one row per ready lifecycle
// row that is still inside its minimum residency. A 0 on both knobs (or no
// policy) reports disabled; `held` is advisory for each resident — the resident
// blocks a switch only if the target profile would evict it, so it is not a
// prediction for a specific profile. Nothing is refused, switched or scheduled.
//
// The ranking section (scope "serving-process", Part of #519) is a read-only
// read-out of the NodeRun ranking knobs against the serving node's lifecycle
// rows: the resolved residentPreference and coldLoadPenaltyMs plus the resident
// (ready lifecycle rows), drain-charged (exclusive-group drain), cooldown-charged
// (active switch-cooldown/min-residency instants per non-ready row), the
// in-flight load credits and the operational drain and degraded tier model
// lists, computed by the same residencyRankingReadout the unified proxy's
// ranking signals derive from. Every
// ranking knob 0 (residentPreference, coldLoadPenaltyMs, switchCooldownSeconds,
// minResidencySeconds), or no policy, reports disabled without reading the store;
// off the serving node, with the unified proxy off, or with an absent,
// unreadable or lifecycle-unreadable store it reports unavailable. It never
// ranks or mutates anything.
//
// `runIdleEviction` (Part of #519) is the operator-triggered mutation built on
// that same snapshot: a dry run reports would-evict rows, a targeted run re-checks
// against the live registry and stops each target through the fenced stop the
// router supplies. It evicts only on an explicit call, never on a timer. The dry
// run and the pre-stop re-check also consult the installed session registry
// (#520): a workload bound to a session, idle within its timeout or in flight,
// is skipped SessionsActive with the ids as detail; a throwing registry is
// SessionsUnknown (fail closed); sessions are never released. The node stop
// fence's own SessionsActive check (stop-fence.ts) remains as defence in depth
// for a session that arrives between the re-check and the drain.
import type { ResidencyAuditEntry, ResidencyLeases } from "@llamactl/core/residency/leases";
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";
import type { PlannerWorkload, ProfileSwitchPlan } from "@llamactl/core/residency/planner";
import type { SessionRefcounts, SessionUnloadCheck } from "@llamactl/core/residency/sessions";

import { resolveResidencyPolicy } from "@llamactl/core/residency/admission";
import {
  findExclusiveGroupViolations,
  isOccupyingResidencyState,
  RESIDENCY_GROUPS,
} from "@llamactl/core/residency/lifecycle";
import { planProfileSwitch } from "@llamactl/core/residency/planner";

import type { ResidencyRankingReadout } from "../proxy/residency-ranking.js";
import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type { NodeRun } from "../workload/noderun-schema.js";
import type { InvalidNodeRunFile } from "../workload/noderun-store.js";
import type { ModelRun } from "../workload/schema.js";
import type { ManagedLaunchAdmission } from "./managed-launch-admission.js";
import type { OmlxNativeStatusRow } from "./omlx-capability.js";
import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "./store.js";

import { residencyRankingReadout } from "../proxy/residency-ranking.js";
import { nodeRunKnobScopeMismatch } from "../workload/noderun-schema.js";
import { buildProfileSwitchRequest, type ObservedWorkloadState } from "./coordinator.js";
import { profileSwitchOperationKey } from "./profile-transition.js";

type ResidencyPolicy = NonNullable<NodeRun["spec"]["residency"]>;

export const RESIDENCY_POLICY_KNOBS = [
  "idleEvictSeconds",
  "minResidencySeconds",
  "switchCooldownSeconds",
  "safetyMarginRatio",
  "residentPreference",
  "coldLoadPenaltyMs",
] as const;

export type ResidencyPolicyKnob = (typeof RESIDENCY_POLICY_KNOBS)[number];

export type ResidencyStatusEffectivePolicy = {
  knobs: { name: ResidencyPolicyKnob; value: number; defaulted: boolean }[];
};

// Pure projection: each NodeRun whose metadata.name equals `node` or whose
// spec.node equals `node` is mapped through `nodeRunKnobScopeMismatch`; nulls
// (correctly scoped or infra-only) are dropped, and the remaining strings are
// ordered by metadata.name with compareStrings.  Returns an empty list when
// nothing is mis-scoped (Part of #519).
export function nodeRunKnobScopeWarnings(node: string, nodeRuns: readonly NodeRun[]): string[] {
  const matches: { name: string; warning: string }[] = [];
  for (const run of nodeRuns) {
    if (run.metadata.name === node || run.spec.node === node) {
      const warning = nodeRunKnobScopeMismatch(run);
      if (warning !== null) matches.push({ name: run.metadata.name, warning });
    }
  }
  matches.sort((a, b) => compareStrings(a.name, b.name));
  return matches.map((m) => m.warning);
}

// Pure projection: each invalid NodeRun file whose metadata.name, spec.node,
// or file name matches the query or owner is mapped to the failure text.
// Entries are ordered by file with compareStrings. Returns an empty list when
// nothing matches (Part of #519).
export function invalidNodeRunWarnings(
  node: string,
  invalid: readonly InvalidNodeRunFile[],
  ownerNodeId = node,
): string[] {
  const names = [node, ownerNodeId];
  const matches: { file: string; warning: string }[] = [];
  for (const entry of invalid) {
    if (
      names.some(
        (name) => entry.name === name || entry.node === name || entry.file === `${name}.yaml`,
      )
    ) {
      matches.push({
        file: entry.file,
        warning: `NodeRun file '${entry.file}' (metadata.name '${entry.name ?? "?"}', spec.node '${entry.node ?? "?"}') failed validation: ${entry.error}. Its declared budget and residency policy are unavailable. Fix the file and re-apply it with llamactl apply -f`,
      });
    }
  }
  matches.sort((a, b) => compareStrings(a.file, b.file));
  return matches.map((m) => m.warning);
}

// Spread helper: only sets the key when there is something to warn about.
function warningsFor(node: string, nodeRuns: readonly NodeRun[]): { knobScopeWarnings?: string[] } {
  const warnings = nodeRunKnobScopeWarnings(node, nodeRuns);
  return warnings.length > 0 ? { knobScopeWarnings: warnings } : {};
}

export function effectiveResidencyPolicy(
  residency: ResidencyPolicy | null | undefined,
): ResidencyStatusEffectivePolicy {
  const overrides: Partial<ReturnType<typeof resolveResidencyPolicy>> = {};
  for (const knob of RESIDENCY_POLICY_KNOBS) {
    const v = residency?.[knob];
    if (v !== undefined) overrides[knob] = v;
  }
  const resolved = resolveResidencyPolicy(overrides);
  return {
    knobs: RESIDENCY_POLICY_KNOBS.map((name) => ({
      name,
      value: resolved[name],
      defaulted: residency?.[name] === undefined || resolved[name] !== residency[name],
    })),
  };
}

export type ResidencyStatusNonterminalOperation = {
  operationId: string;
  model: string;
  phase: string;
  targetState: string;
  reservationGiB: number;
};

export const RESIDENCY_STATUS_AUDIT_LIMIT = 20;

export type ResidencyStatusLeaseWorkload = {
  workload: string;
  phase: "open" | "draining" | "unloaded";
  epoch: number;
  activeLeaseCount: number;
  waiters: number;
};

// `reason` is `string | null` rather than optional: tRPC output typing strips
// `| undefined` from optional props, which breaks assignment in the CLI under
// exactOptionalPropertyTypes (see the comment in cli residency.ts).
export type ResidencyStatusLeaseAuditEntry = {
  workload: string;
  epoch: number;
  forced: true;
  revokedCount: number;
  reason: string | null;
};

export type ResidencyStatusLeases =
  | { status: "unavailable"; scope: "serving-process" }
  | {
      status: "available";
      scope: "serving-process";
      workloads: ResidencyStatusLeaseWorkload[];
      auditCount: number;
      recentAudit: ResidencyStatusLeaseAuditEntry[];
    };

export type ResidencyStatusSessionRow = {
  sessionId: string;
  workload: string;
  refs: number;
  idleMs: number;
  expiresInMs: number | null;
};

export type ResidencyStatusSessionsUnavailableReason =
  | "NoRegistry"
  | "SessionsUnknown"
  | "SnapshotUnsupported";

export type ResidencyStatusSessions =
  | {
      status: "unavailable";
      scope: "serving-process";
      reason: ResidencyStatusSessionsUnavailableReason;
    }
  | {
      status: "available";
      scope: "serving-process";
      idleTimeoutMs: number;
      sessions: ResidencyStatusSessionRow[];
    };

// The lease-registry surface the status builder reads (Part of #519): the
// snapshot/audit pair the leases section needs, plus the optional
// `lastActivityAtMs` read-out the idleEviction advisory consults. Optional so a
// registry (or fake) without it still type-checks.
export type ResidencyStatusLeaseRegistry = Pick<
  ResidencyLeases,
  "snapshot" | "audit" | "lastActivityAtMs"
>;

// Epochs and lease ids restart per process, so (workload, epoch, revoked,
// reason) alone collides across a restart: the incarnation of the registry that
// wrote the entry is part of the key. An entry without one (a legacy row
// persisted before the incarnation column) has no key and never matches, since
// every live entry carries an incarnation.
function auditEntryKey(entry: ResidencyAuditEntry): string | null {
  if (entry.incarnation === undefined) {
    return null;
  }
  return JSON.stringify([
    entry.incarnation,
    entry.workload,
    entry.epoch,
    entry.revoked,
    entry.reason ?? null,
  ]);
}

// Merge the persisted forced-unload audit with the live in-memory one. The
// sink writes live entries in order, so the persisted copies of live entries
// form a subsequence of the persisted rows. Live entries are matched to
// persisted rows on (incarnation, workload, epoch, revoked, reason), newest
// first, each persisted row used at most once and match positions
// strictly decreasing. An unmatched live entry (its sink write failed) is
// inserted just before the persisted row of the next later live entry that
// did persist, or appended when none did, which keeps chronological order.
// An entry held by both sources appears once.
export function mergeResidencyLeaseAudit(
  persisted: readonly ResidencyAuditEntry[],
  live: readonly ResidencyAuditEntry[],
): ResidencyAuditEntry[] {
  if (persisted.length === 0 || live.length === 0) {
    return [...persisted, ...live];
  }
  const matches = matchLiveToPersisted(persisted, live);
  const insertBefore = new Map<number, ResidencyAuditEntry[]>();
  let pending: ResidencyAuditEntry[] = [];
  for (const [i, entry] of live.entries()) {
    const p = matches[i] ?? -1;
    if (p === -1) {
      pending.push(entry);
    } else if (pending.length > 0) {
      insertBefore.set(p, pending);
      pending = [];
    }
  }
  const merged: ResidencyAuditEntry[] = [];
  for (const [p, row] of persisted.entries()) {
    merged.push(...(insertBefore.get(p) ?? []), row);
  }
  merged.push(...pending);
  return merged;
}

// For each live entry, the index of the persisted row it matched, or -1.
// Newest first, so match positions strictly decrease.
function matchLiveToPersisted(
  persisted: readonly ResidencyAuditEntry[],
  live: readonly ResidencyAuditEntry[],
): number[] {
  const persistedKeys = persisted.map(auditEntryKey);
  const matches = live.map(() => -1);
  let bound = persisted.length;
  for (const [i, entry] of [...live.entries()].reverse()) {
    if (bound === 0) {
      break;
    }
    const key = auditEntryKey(entry);
    if (key === null) {
      continue;
    }
    const p = persistedKeys.lastIndexOf(key, bound - 1);
    if (p !== -1) {
      matches[i] = p;
      bound = p;
    }
  }
  return matches;
}

export function buildResidencyLeaseSnapshot(
  registry: Pick<ResidencyLeases, "snapshot" | "audit"> | null,
  workloads: readonly string[],
): ResidencyStatusLeases {
  if (registry === null) {
    return { status: "unavailable", scope: "serving-process" };
  }
  const audit = registry.audit();
  const names = new Set<string>(workloads);
  for (const entry of audit) {
    names.add(entry.workload);
  }
  const rows = [...names].sort(compareStrings).map((name) => {
    const s = registry.snapshot(name);
    return {
      workload: name,
      phase: s.phase,
      epoch: s.epoch,
      activeLeaseCount: s.active.length,
      waiters: s.waiters,
    };
  });
  const recentAudit = audit.slice(-RESIDENCY_STATUS_AUDIT_LIMIT).map((e) => ({
    workload: e.workload,
    epoch: e.epoch,
    forced: true as const,
    revokedCount: e.revoked.length,
    reason: e.reason ?? null,
  }));
  return {
    status: "available",
    scope: "serving-process",
    workloads: rows,
    auditCount: audit.length,
    recentAudit,
  };
}

// null: no session registry installed in the serving process. undefined:
// the caller did not ask for the section, so it is omitted.
export function buildResidencySessionSnapshot(
  registry: Pick<SessionRefcounts, "snapshot"> | null | undefined,
): ResidencyStatusSessions | undefined {
  if (registry === undefined) {
    return undefined;
  }
  if (registry === null) {
    return { status: "unavailable", scope: "serving-process", reason: "NoRegistry" };
  }
  if (registry.snapshot === undefined) {
    return { status: "unavailable", scope: "serving-process", reason: "SnapshotUnsupported" };
  }
  try {
    const snap = registry.snapshot();
    const sessions = snap.sessions.map(
      (r): ResidencyStatusSessionRow => ({
        sessionId: r.sessionId,
        workload: r.workload,
        refs: r.refs,
        idleMs: r.idleMs,
        expiresInMs: r.expiresInMs,
      }),
    );
    return {
      status: "available",
      scope: "serving-process",
      idleTimeoutMs: snap.idleTimeoutMs,
      sessions,
    };
  } catch {
    return { status: "unavailable", scope: "serving-process", reason: "SessionsUnknown" };
  }
}

// Public lifecycle projection of one residency_states row. Fence identity
// (ownerId, incarnation, fenceToken) is deliberately excluded: status is a
// read-out, not an authority claim.
export type ResidencyStatusLifecycleRow = {
  model: string;
  group: string | null;
  state: ResidencyState;
  occupying: boolean;
  version: number;
  updatedAtMs: number;
};

export type ResidencyStatusLifecycle =
  | {
      status: "available";
      scope: "serving-process";
      workloads: ResidencyStatusLifecycleRow[];
      exclusiveViolations: { group: string; members: string[] }[];
    }
  | {
      status: "unavailable";
      scope: "serving-process";
      reason: "StoreUnreadable" | "LifecycleUnreadable";
    };

export type ResidencyStatusIdleEvictionRow = {
  workload: string;
  readySinceMs: number;
  lastActivityAtMs: number | null;
  idleSinceMs: number | null;
  activeLeaseCount: number;
  dueAtMs: number | null;
  due: boolean;
  // Present only while the row is idle-due but held short of eviction because
  // its resident has not yet been ready for `minResidencySeconds` (Part of #519).
  minResidencyUntilMs?: number;
  // Present only while the row is otherwise due but a session holds its
  // workload (#520). The status read-out carries the reason and the bound ids,
  // never the eviction's mutable detail text.
  sessionHold?: { reason: "SessionsActive" | "SessionsUnknown"; sessions: string[] };
};

// Advisory read-out of NodeRun `idleEvictSeconds` (Part of #519): for each
// `ready` lifecycle row on the serving node, when it last went idle and whether
// it would now be due for an idle eviction. Nothing evicts here — this is a
// status, never a trigger. `scope` is always "serving-process": it reflects
// this process's lifecycle rows and lease activity, never `node`'s coordinator
// state.
export type ResidencyStatusIdleEviction =
  | { status: "disabled"; scope: "serving-process" }
  | {
      status: "unavailable";
      scope: "serving-process";
      reason: "NotServingNode" | "LeasesUnavailable" | "StoreUnreadable" | "LifecycleUnreadable";
    }
  | {
      status: "available";
      scope: "serving-process";
      advisory: true;
      idleEvictSeconds: number;
      workloads: ResidencyStatusIdleEvictionRow[];
    };

export type ResidencyStatusSwitchGateRow = {
  workload: string;
  readySinceMs: number;
  minResidencyUntilMs: number;
  held: boolean;
};

// Advisory read-out of the enforced NodeRun switch gates (Part of #519): the
// switchCooldownSeconds countdown from the last succeeded `profile-switch:<node>`
// operation in the serving node's store, and — when minResidencySeconds is set —
// one row per `ready` lifecycle row still inside its minimum residency. Nothing
// is refused, switched or scheduled here — this is a status, never enforcement.
// `scope` is always "serving-process". `held` is advisory for each resident: the
// resident blocks a switch only if the target profile would evict it, so it is
// not a prediction for a specific profile.
export type ResidencyStatusSwitchGates =
  | { status: "disabled"; scope: "serving-process" }
  | {
      status: "unavailable";
      scope: "serving-process";
      reason: "NotServingNode" | "StoreUnreadable" | "LifecycleUnreadable";
    }
  | {
      status: "available";
      scope: "serving-process";
      advisory: true;
      switchCooldownSeconds: number;
      minResidencySeconds: number;
      lastSwitchAtMs: number | null;
      cooldownUntilMs: number | null;
      cooldownActive: boolean;
      workloads: ResidencyStatusSwitchGateRow[];
    };

// Read-only ranking-knob read-out (Part of #519): the resolved
// `residentPreference` and `coldLoadPenaltyMs`, plus the resident,
// drain-charged, cooldown-charged, drain-tier, degraded-tier and
// load-credited model lists exactly as the unified proxy's ranker sees
// them, computed by `residencyRankingReadout`. It mirrors the gating of
// `createResidencyRankingSource`/`residencyRankingInputs` and never ranks
// or mutates anything. `scope` is always "serving-process".
export type ResidencyStatusRanking =
  | { status: "disabled"; scope: "serving-process" }
  | {
      status: "unavailable";
      scope: "serving-process";
      reason:
        | "NotServingNode"
        | "UnifiedProxyOff"
        | "StoreAbsent"
        | "StoreUnreadable"
        | "LifecycleUnreadable";
    }
  | {
      status: "available";
      scope: "serving-process";
      advisory: true;
      residentPreference: number;
      coldLoadPenaltyMs: number;
      resident: string[];
      drainCharged: string[];
      cooldownCharged: { model: string; untilMs: number }[];
      drainTier: string[];
      degradedTier: string[];
      loadCredited: { model: string; expectedReadyAtMs: number }[];
    };

export type ResidencyStatus = {
  node: string;
  nodeRun: { present: boolean };
  policy: { present: false } | { present: true; residency: ResidencyPolicy };
  budget: { memoryGiB: number; source: "noderun" | "computed" };
  store:
    | { path: string; present: false; scope: "serving-process" }
    | { path: string; present: true; error: string; scope: "serving-process" }
    | {
        path: string;
        present: true;
        nonterminalCount: number;
        nonterminal: ResidencyStatusNonterminalOperation[];
        scope: "serving-process";
      };
  // Optional like omlxNative so older payloads and fixtures still type;
  // buildResidencyStatus always sets it.
  lifecycle?: ResidencyStatusLifecycle;
  // Optional like lifecycle so older payloads and fixtures still type;
  // buildResidencyStatus always sets it (Part of #519).
  idleEviction?: ResidencyStatusIdleEviction;
  // Optional like idleEviction so older payloads and fixtures still type;
  // buildResidencyStatus always sets it (Part of #519).
  switchGates?: ResidencyStatusSwitchGates;
  // Optional like switchGates so older payloads and fixtures still type;
  // buildResidencyStatus always sets it (Part of #519).
  ranking?: ResidencyStatusRanking;
  // Optional like ranking so older payloads and fixtures still type;
  // buildResidencyStatus always sets it (Part of #519).
  effectivePolicy?: ResidencyStatusEffectivePolicy;
  // Omitted when no NodeRun selected by or targeting `node` is mis-scoped,
  // so older payloads and fixtures still type (Part of #519).
  knobScopeWarnings?: string[];
  // Omitted when no invalid NodeRun file matches `node`, so older payloads
  // and fixtures still type (Part of #519).
  invalidNodeRunWarnings?: string[];
  leases: ResidencyStatusLeases;
  omlxNative?: { scope: "serving-process"; workloads: OmlxNativeStatusRow[] };
  sessions?: ResidencyStatusSessions;
};

export function buildResidencyStatus(input: {
  node: string;
  nodeRun: NodeRun | undefined;
  budgetGiB: number;
  budgetSource: "noderun" | "computed";
  store: ResidencyStoreSnapshot;
  leaseRegistry?: ResidencyStatusLeaseRegistry | null | undefined;
  leaseWorkloads?: readonly string[] | undefined;
  omlxNative?: readonly OmlxNativeStatusRow[] | undefined;
  sessionRegistry?:
    | (Pick<SessionRefcounts, "snapshot"> & Partial<Pick<SessionRefcounts, "checkUnload">>)
    | null
    | undefined;
  nowMs?: number | undefined;
  servingNode?: string | null | undefined;
  unifiedProxy?: boolean | undefined;
  nodeRuns?: readonly NodeRun[] | undefined;
  invalidNodeRuns?: readonly InvalidNodeRunFile[] | undefined;
  ownerNodeId?: string | undefined;
}): ResidencyStatus {
  const residency = input.nodeRun?.spec.residency;
  const sessions = buildResidencySessionSnapshot(input.sessionRegistry);
  // The idle-evict read-out consults checkUnload too (#520). Bound explicitly:
  // a truthiness check on an optional property does not narrow it under
  // exactOptionalPropertyTypes.
  const reg = input.sessionRegistry ?? null;
  const check = reg?.checkUnload;
  const sessionProbe: IdleEvictSessionProbe | null =
    reg !== null && check !== undefined ? { checkUnload: (w) => check.call(reg, w) } : null;
  const warnings = warningsFor(input.node, input.nodeRuns ?? []);
  const invalidWarnings = invalidNodeRunWarnings(
    input.node,
    input.invalidNodeRuns ?? [],
    input.ownerNodeId,
  );
  return {
    node: input.node,
    nodeRun: { present: input.nodeRun !== undefined },
    policy: residency !== undefined ? { present: true, residency } : { present: false },
    effectivePolicy: effectiveResidencyPolicy(residency),
    budget: { memoryGiB: input.budgetGiB, source: input.budgetSource },
    store: storeWithScope(input.store),
    lifecycle: buildResidencyLifecycleSnapshot(input.store),
    idleEviction: buildIdleEvictionSnapshot({
      residency,
      servingNode: input.servingNode ?? null,
      node: input.node,
      store: input.store,
      leaseRegistry: input.leaseRegistry ?? null,
      nowMs: input.nowMs ?? Date.now(),
      sessions: sessionProbe,
    }),
    switchGates: buildSwitchGatesSnapshot({
      residency,
      servingNode: input.servingNode ?? null,
      node: input.node,
      store: input.store,
      nowMs: input.nowMs ?? Date.now(),
    }),
    ranking: buildRankingSnapshot({
      residency,
      servingNode: input.servingNode ?? null,
      node: input.node,
      store: input.store,
      unifiedProxy: input.unifiedProxy ?? false,
      nowMs: input.nowMs ?? Date.now(),
    }),
    leases: buildResidencyLeaseSnapshot(input.leaseRegistry ?? null, input.leaseWorkloads ?? []),
    omlxNative: { scope: "serving-process", workloads: [...(input.omlxNative ?? [])] },
    ...(sessions !== undefined ? { sessions } : {}),
    ...warnings,
    ...(invalidWarnings.length > 0 ? { invalidNodeRunWarnings: invalidWarnings } : {}),
  };
}

// Pure projection of the store snapshot's lifecycle rows (Part of #517). An
// absent store is an empty healthy lifecycle; an unreadable store or a
// lifecycle read failure degrades only this section, never the store section.
export function buildResidencyLifecycleSnapshot(
  store: ResidencyStoreSnapshot,
): ResidencyStatusLifecycle {
  const scope = "serving-process" as const;
  if (!store.present) {
    return { status: "available", scope, workloads: [], exclusiveViolations: [] };
  }
  if ("error" in store) {
    return { status: "unavailable", scope, reason: "StoreUnreadable" };
  }
  if (store.lifecycleError !== undefined) {
    return { status: "unavailable", scope, reason: "LifecycleUnreadable" };
  }
  const rows = [...(store.lifecycle ?? [])].sort((a, b) => compareStrings(a.model, b.model));
  const workloads = rows.map(
    (row): ResidencyStatusLifecycleRow => ({
      model: row.model,
      group: row.group,
      state: row.state,
      occupying: isOccupyingResidencyState(row.state),
      version: row.version,
      updatedAtMs: row.updatedAtMs,
    }),
  );
  const exclusiveViolations = findExclusiveGroupViolations(
    RESIDENCY_GROUPS,
    rows.map((row) => ({
      id: row.model,
      ...(row.group === null ? {} : { group: row.group }),
      state: row.state,
    })),
  );
  return { status: "available", scope, workloads, exclusiveViolations };
}

// One advisory row per ready lifecycle record, or null when the record is not a
// ready row with a finite timestamp. Idle-since is the later of ready-since and
// lease activity, clamped to nowMs; a registry without `lastActivityAtMs`, or
// one returning a non-finite value, yields null time fields and due false. When
// `minResidencySeconds` is positive it also holds an idle-due resident: the
// ready-since (clamped to nowMs, as the planner does, Part of #735) plus the
// window is `minResidencyUntilMs`, and `dueAtMs` becomes the later of the idle
// window and that hold, so a resident still inside its minimum residency reports
// due false with the hold field set. With 0 or absent min-residency the row is
// byte-identical to the idle-only computation. A resident that is idle-due and
// not min-residency-held also consults the session registry (#520): a bound
// session, or a session check that throws, reports the row due false with
// `sessionHold` set and an unchanged `dueAtMs`. Rows that are not idle-due never
// consult it, and nothing releases a session here.
function idleEvictionRowFor(
  row: ResidencyStateRecord,
  registry: ResidencyStatusLeaseRegistry,
  idleEvictSeconds: number,
  minResidencySeconds: number,
  nowMs: number,
  sessions?: IdleEvictSessionProbe | null,
): ResidencyStatusIdleEvictionRow | null {
  if (row.state !== "ready" || !Number.isFinite(row.updatedAtMs)) {
    return null;
  }
  const snap = registry.snapshot(row.model);
  const activeLeaseCount = snap.active.length;
  const activityOf = registry.lastActivityAtMs;
  const lastActivityMs = activityOf === undefined ? undefined : activityOf(row.model);
  if (lastActivityMs === undefined || !Number.isFinite(lastActivityMs)) {
    return {
      workload: row.model,
      readySinceMs: row.updatedAtMs,
      lastActivityAtMs: null,
      idleSinceMs: null,
      activeLeaseCount,
      dueAtMs: null,
      due: false,
    };
  }
  const idleSinceMs = Math.min(nowMs, Math.max(row.updatedAtMs, lastActivityMs));
  const idleDueAtMs = idleSinceMs + idleEvictSeconds * 1000;
  const minResidencyUntilMs =
    minResidencySeconds > 0 ? Math.min(nowMs, row.updatedAtMs) + minResidencySeconds * 1000 : 0;
  const dueAtMs =
    minResidencySeconds > 0 ? Math.max(idleDueAtMs, minResidencyUntilMs) : idleDueAtMs;
  const idleDue = snap.phase === "open" && activeLeaseCount === 0 && nowMs >= idleDueAtMs;
  const held = minResidencySeconds > 0 && idleDue && nowMs < minResidencyUntilMs;
  const base: ResidencyStatusIdleEvictionRow = {
    workload: row.model,
    readySinceMs: row.updatedAtMs,
    lastActivityAtMs: lastActivityMs,
    idleSinceMs,
    activeLeaseCount,
    dueAtMs,
    due: idleDue && !held,
    ...(held ? { minResidencyUntilMs } : {}),
  };
  if (!idleDue || held) {
    return base;
  }
  const hold = probeSessionHold(row.model, sessions);
  return hold === null
    ? base
    : { ...base, due: false, sessionHold: { reason: hold.reason, sessions: hold.sessions } };
}

// Advisory idle-eviction read-out (Part of #519). Resolves the NodeRun policy
// then checks, in a fixed order, why it cannot answer: 0 disables (reads
// neither the registry nor the lifecycle); off the serving node is
// NotServingNode (the same `applies` gate the omlxNative/store sections use — a
// peer's policy is not a policy here); a missing registry is LeasesUnavailable;
// an unreadable store is StoreUnreadable; a lifecycle read failure is
// LifecycleUnreadable; an absent store is an empty healthy listing. Otherwise
// one row per `ready` lifecycle row with a finite updatedAtMs, sorted by model,
// reporting when it went idle (the later of ready-since and lease activity,
// clamped to nowMs) and whether it is due. due requires the lease phase to be
// open with no active leases and nowMs at or past dueAtMs. `minResidencySeconds`
// is resolved alongside `idleEvictSeconds` and holds an idle-due resident short
// of eviction: while the resident has not yet been ready for the window the row
// reports due false with `minResidencyUntilMs` set and a `dueAtMs` that is the
// later of the idle window and the hold. A registry without `lastActivityAtMs`,
// or one returning a non-finite value, yields null time fields and due false.
// With a session registry supplied (#520) an idle-due, non-min-residency-held
// resident also reports `sessionHold` instead of `due`. This module never
// evicts, sleeps, schedules anything or releases a session.
export function buildIdleEvictionSnapshot(input: {
  residency: ResidencyPolicy | null | undefined;
  servingNode: string | null;
  node: string;
  store: ResidencyStoreSnapshot;
  leaseRegistry: ResidencyStatusLeaseRegistry | null;
  nowMs: number;
  sessions?: IdleEvictSessionProbe | null | undefined;
}): ResidencyStatusIdleEviction {
  const scope = "serving-process" as const;
  const policy = resolveResidencyPolicy({
    ...(input.residency?.idleEvictSeconds !== undefined
      ? { idleEvictSeconds: input.residency.idleEvictSeconds }
      : {}),
    ...(input.residency?.minResidencySeconds !== undefined
      ? { minResidencySeconds: input.residency.minResidencySeconds }
      : {}),
  });
  const idleEvictSeconds = policy.idleEvictSeconds;
  const minResidencySeconds = policy.minResidencySeconds;
  if (idleEvictSeconds === 0) {
    return { status: "disabled", scope };
  }
  if (input.servingNode === null || input.servingNode !== input.node) {
    return { status: "unavailable", scope, reason: "NotServingNode" };
  }
  const registry = input.leaseRegistry;
  if (registry === null) {
    return { status: "unavailable", scope, reason: "LeasesUnavailable" };
  }
  const store = input.store;
  if (!store.present) {
    return { status: "available", scope, advisory: true, idleEvictSeconds, workloads: [] };
  }
  if ("error" in store) {
    return { status: "unavailable", scope, reason: "StoreUnreadable" };
  }
  if (store.lifecycleError !== undefined) {
    return { status: "unavailable", scope, reason: "LifecycleUnreadable" };
  }
  const workloads: ResidencyStatusIdleEvictionRow[] = [];
  for (const row of store.lifecycle ?? []) {
    const mapped = idleEvictionRowFor(
      row,
      registry,
      idleEvictSeconds,
      minResidencySeconds,
      input.nowMs,
      input.sessions,
    );
    if (mapped !== null) {
      workloads.push(mapped);
    }
  }
  workloads.sort((a, b) => compareStrings(a.workload, b.workload));
  return { status: "available", scope, advisory: true, idleEvictSeconds, workloads };
}

// One advisory row per ready lifecycle record still inside its minimum residency,
// or nothing when the knob is off. A row maps only when it is `ready` with a
// finite updatedAtMs; `readySinceMs` is that raw timestamp, `minResidencyUntilMs`
// the ready-since clamped to nowMs (as the planner does, Part of #519) plus the
// window, and `held` says nowMs has not yet reached it.
function switchGateRows(
  lifecycle: readonly ResidencyStateRecord[] | undefined,
  minResidencySeconds: number,
  nowMs: number,
): ResidencyStatusSwitchGateRow[] {
  if (minResidencySeconds === 0) {
    return [];
  }
  const rows = [...(lifecycle ?? [])]
    .filter((row) => row.state === "ready" && Number.isFinite(row.updatedAtMs))
    .sort((a, b) => compareStrings(a.model, b.model));
  const workloads: ResidencyStatusSwitchGateRow[] = [];
  for (const row of rows) {
    const minResidencyUntilMs = Math.min(nowMs, row.updatedAtMs) + minResidencySeconds * 1000;
    workloads.push({
      workload: row.model,
      readySinceMs: row.updatedAtMs,
      minResidencyUntilMs,
      held: nowMs < minResidencyUntilMs,
    });
  }
  return workloads;
}

// The cooldown triple for one switch-gates report. `lastSwitchAtMs` is the last
// succeeded `profile-switch:<node>` operation (a missing or non-finite record is
// null); `cooldownUntilMs` is that plus the window only when both a window and a
// switch exist; `cooldownActive` matches the planner's checkCooldown,
// `nowMs - lastSwitchAtMs < switchCooldownSeconds * 1000`.
function switchCooldownFields(
  store: ResidencyStoreSnapshot,
  node: string,
  switchCooldownSeconds: number,
  nowMs: number,
): { lastSwitchAtMs: number | null; cooldownUntilMs: number | null; cooldownActive: boolean } {
  const lastSwitchAtMs = recordedSwitchAtMs(store, true, profileSwitchOperationKey(node)) ?? null;
  const cooldownMs = switchCooldownSeconds * 1000;
  const cooldownUntilMs =
    cooldownMs > 0 && lastSwitchAtMs !== null ? lastSwitchAtMs + cooldownMs : null;
  const cooldownActive =
    lastSwitchAtMs !== null && cooldownMs > 0 && nowMs - lastSwitchAtMs < cooldownMs;
  return { lastSwitchAtMs, cooldownUntilMs, cooldownActive };
}

// Advisory switch-gate read-out (Part of #519). Resolves the NodeRun policy then
// checks, in a fixed order, why it cannot answer: both knobs 0 disables; off the
// serving node is NotServingNode (the same `applies` gate the idleEviction,
// omlxNative and store sections use — a peer's policy is not a policy here); an
// absent store is available with null switch fields and no rows; an unreadable
// store is StoreUnreadable; a lifecycle read failure is LifecycleUnreadable only
// when minResidencySeconds reads those rows (a cooldown-only report never does).
// Otherwise the cooldown fields come from `switchCooldownFields` and one row is
// built per ready lifecycle row when minResidencySeconds is positive. This module
// never refuses, switches or schedules anything.
export function buildSwitchGatesSnapshot(input: {
  residency: ResidencyPolicy | null | undefined;
  servingNode: string | null;
  node: string;
  store: ResidencyStoreSnapshot;
  nowMs: number;
}): ResidencyStatusSwitchGates {
  const scope = "serving-process" as const;
  const policy = resolveResidencyPolicy({
    ...(input.residency?.switchCooldownSeconds !== undefined
      ? { switchCooldownSeconds: input.residency.switchCooldownSeconds }
      : {}),
    ...(input.residency?.minResidencySeconds !== undefined
      ? { minResidencySeconds: input.residency.minResidencySeconds }
      : {}),
  });
  const switchCooldownSeconds = policy.switchCooldownSeconds;
  const minResidencySeconds = policy.minResidencySeconds;
  if (switchCooldownSeconds === 0 && minResidencySeconds === 0) {
    return { status: "disabled", scope };
  }
  if (input.servingNode === null || input.servingNode !== input.node) {
    return { status: "unavailable", scope, reason: "NotServingNode" };
  }
  const store = input.store;
  if (!store.present) {
    return {
      status: "available",
      scope,
      advisory: true,
      switchCooldownSeconds,
      minResidencySeconds,
      lastSwitchAtMs: null,
      cooldownUntilMs: null,
      cooldownActive: false,
      workloads: [],
    };
  }
  if ("error" in store) {
    return { status: "unavailable", scope, reason: "StoreUnreadable" };
  }
  if (minResidencySeconds > 0 && store.lifecycleError !== undefined) {
    return { status: "unavailable", scope, reason: "LifecycleUnreadable" };
  }
  const cooldown = switchCooldownFields(store, input.node, switchCooldownSeconds, input.nowMs);
  return {
    status: "available",
    scope,
    advisory: true,
    switchCooldownSeconds,
    minResidencySeconds,
    ...cooldown,
    workloads: switchGateRows(store.lifecycle, minResidencySeconds, input.nowMs),
  };
}

function rankingAvailable(readout: ResidencyRankingReadout): ResidencyStatusRanking {
  return {
    status: "available",
    scope: "serving-process",
    advisory: true,
    residentPreference: readout.residentPreference,
    coldLoadPenaltyMs: readout.coldLoadPenaltyMs,
    resident: readout.resident,
    drainCharged: readout.drainCharged,
    cooldownCharged: readout.cooldownCharged,
    drainTier: readout.drainTier,
    degradedTier: readout.degradedTier,
    loadCredited: readout.loadCredited,
  };
}

// Advisory ranking-knob read-out (Part of #519). It mirrors the gating of
// `createResidencyRankingSource`/`residencyRankingInputs` and never ranks or
// mutates anything. Resolves the NodeRun policy then checks, in a fixed
// order, why it cannot answer: every ranking knob 0 (or no policy) disables
// without reading the store; off the serving node is NotServingNode (the same
// `applies` gate the idleEviction, switchGates, omlxNative and store sections
// use); the unified proxy off is UnifiedProxyOff (the ranker consumes these
// signals only under LLAMACTL_UNIFIED_PROXY=1); an absent store is StoreAbsent
// (the ranker emits {} signals there, so residency is unknown); an unreadable
// store is StoreUnreadable; a lifecycle read failure (or an undefined
// lifecycle) is LifecycleUnreadable. Otherwise available, from the same
// `residencyRankingReadout` mapping the live ranker's signals come from, with
// the node name, the store's last succeeded switches and the clock handed in
// so the cooldown charges resolve exactly as the live ranker prices them.
export function buildRankingSnapshot(input: {
  residency: ResidencyPolicy | null | undefined;
  servingNode: string | null;
  node: string;
  store: ResidencyStoreSnapshot;
  unifiedProxy: boolean;
  nowMs: number;
}): ResidencyStatusRanking {
  const scope = "serving-process" as const;
  if (residencyRankingReadout({ residency: input.residency, lifecycle: [] }) === null) {
    return { status: "disabled", scope };
  }
  if (input.servingNode === null || input.servingNode !== input.node) {
    return { status: "unavailable", scope, reason: "NotServingNode" };
  }
  if (!input.unifiedProxy) {
    return { status: "unavailable", scope, reason: "UnifiedProxyOff" };
  }
  const store = input.store;
  if (!store.present) {
    return { status: "unavailable", scope, reason: "StoreAbsent" };
  }
  if ("error" in store) {
    return { status: "unavailable", scope, reason: "StoreUnreadable" };
  }
  if (store.lifecycleError !== undefined || store.lifecycle === undefined) {
    return { status: "unavailable", scope, reason: "LifecycleUnreadable" };
  }
  const readout = residencyRankingReadout({
    residency: input.residency,
    lifecycle: store.lifecycle,
    nodeName: input.node,
    ...(store.lastSucceededAtMs !== undefined
      ? { lastSucceededAtMs: store.lastSucceededAtMs }
      : {}),
    nowMs: input.nowMs,
  });
  return readout === null ? { status: "disabled", scope } : rankingAvailable(readout);
}

// Operator-triggered idle eviction (Part of #519). Where the idleEviction status
// section above is an advisory read-out, this is the mutation entry point. It is
// pure: the router hands in the idleEviction snapshot it built, the live lease
// registry (or null), the installed session registry (or null), a clock, the
// targets (null = dry run) and a `stop` closure that runs the fenced
// ModelRun/ModelHost stop. `targets: null` reports would-evict/NotDue without
// stopping; a target array restricts a wet run to those workloads, iterated in
// snapshot order with each stop awaited before the next. A row the snapshot
// marks not-due but still inside its minimum residency (its
// `minResidencyUntilMs` is set) is skipped `MinResidency` rather than `NotDue`,
// in both the dry run and a targeted wet run, so a resident that is idle-due
// but has not yet been ready for `minResidencySeconds` is never stopped. Both
// the dry run and the wet pre-stop re-check consult the session registry
// (#520): a bound session, idle within its timeout or in flight, is skipped
// SessionsActive with the ids as detail, a registry whose checkUnload throws is
// skipped SessionsUnknown (fail closed), and sessions are never released. A wet
// target is also re-checked against the live lease registry immediately before
// its stop: any activity the snapshot could not see (a fresh lease, a drain, a
// clock that has not reached dueAtMs, a registry that cannot confirm idle)
// reports NoLongerIdle instead of stopping. A refused stop reports StopRefused
// with the fence detail; a throwing stop reports StopFailed, and later targets
// still run.
export type IdleEvictKind = "modelrun" | "modelhost";

export type IdleEvictTarget = { workload: string; kind: IdleEvictKind };

export type IdleEvictStopResult = { stopped: boolean; detail?: string };

export type IdleEvictRow = {
  workload: string;
  action: "would-evict" | "evicted" | "skipped";
  kind?: IdleEvictKind;
  idleSinceMs?: number;
  dueAtMs?: number;
  reason?: string;
  detail?: string;
};

export type IdleEvictResult =
  | { ok: false; reason: string }
  | { ok: true; dryRun: boolean; windowSeconds: number; rows: IdleEvictRow[] };

// The lease-registry surface the pre-stop re-check reads: the per-workload
// phase/active snapshot plus the optional last-activity read-out. Optional so a
// registry (or fake) without it can never confirm idle and is held.
type IdleEvictLeaseProbe = Pick<ResidencyLeases, "snapshot" | "lastActivityAtMs">;

// The session-registry surface the dry run and the pre-stop re-check read
// (#520): checkUnload alone, called without force so a bound session is
// reported and never released.
type IdleEvictSessionProbe = Pick<SessionRefcounts, "checkUnload">;

function idleEvictSkipped(workload: string, reason: string, detail?: string): IdleEvictRow {
  return { workload, action: "skipped", reason, ...(detail !== undefined ? { detail } : {}) };
}

function idleEvictWouldEvict(row: ResidencyStatusIdleEvictionRow): IdleEvictRow {
  return {
    workload: row.workload,
    action: "would-evict",
    ...(row.idleSinceMs !== null ? { idleSinceMs: row.idleSinceMs } : {}),
    ...(row.dueAtMs !== null ? { dueAtMs: row.dueAtMs } : {}),
  };
}

// What one session probe answers: why a workload is held, the bound session ids
// (empty when the registry could not answer) and the eviction-side detail text.
// The status read-out uses only `reason` and `sessions`; `detail` stays on the
// evict-idle output.
type SessionHoldProbe =
  | { reason: "SessionsActive"; sessions: string[]; detail: string }
  | { reason: "SessionsUnknown"; sessions: string[]; detail: string };

// The one session probe both the idle-evict mutation and the status read-out go
// through (#520). A bound session — idle within its timeout or in flight — holds
// the workload as SessionsActive with the ids; a registry whose checkUnload
// throws holds it as SessionsUnknown (fail closed). checkUnload is called
// WITHOUT force: sessions are never released here, the overrides are `residency
// release-session` and `residency force-unload`.
function probeSessionHold(
  workload: string,
  sessions: IdleEvictSessionProbe | null | undefined,
): SessionHoldProbe | null {
  if (sessions === null || sessions === undefined) {
    return null;
  }
  let check: SessionUnloadCheck;
  try {
    check = sessions.checkUnload(workload);
  } catch (err) {
    return {
      reason: "SessionsUnknown",
      sessions: [],
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!check.ok) {
    return {
      reason: "SessionsActive",
      sessions: [...check.sessions],
      detail: check.sessions.join(", "),
    };
  }
  return null;
}

// The evict-idle row form of `probeSessionHold`, byte-identical to the skip the
// mutation has always reported.
function idleEvictSessionHold(
  workload: string,
  sessions: IdleEvictSessionProbe | null | undefined,
): IdleEvictRow | null {
  const hold = probeSessionHold(workload, sessions);
  return hold === null ? null : idleEvictSkipped(workload, hold.reason, hold.detail);
}

// Re-reads the live registry to confirm the row is still idle at `nowMs` before
// its stop. Any condition the snapshot could not have captured — no registry, a
// registry that cannot report activity, a clock that has not reached dueAtMs, a
// non-open phase or active lease, or activity newer than the snapshot idle-since
// — returns false so the target is held rather than evicted on stale evidence.
function idleStillConfirmed(
  row: ResidencyStatusIdleEvictionRow,
  registry: IdleEvictLeaseProbe | null,
  nowMs: number,
): boolean {
  if (registry === null) {
    return false;
  }
  const activityOf = registry.lastActivityAtMs;
  if (activityOf === undefined) {
    return false;
  }
  if (row.idleSinceMs === null || row.dueAtMs === null) {
    return false;
  }
  if (nowMs < row.dueAtMs) {
    return false;
  }
  const snap = registry.snapshot(row.workload);
  if (snap.phase !== "open" || snap.active.length > 0) {
    return false;
  }
  const lastActivity = activityOf(row.workload);
  if (!Number.isFinite(lastActivity) || lastActivity > row.idleSinceMs) {
    return false;
  }
  return true;
}

async function idleEvictTarget(
  row: ResidencyStatusIdleEvictionRow,
  kind: IdleEvictKind,
  input: {
    leaseRegistry: IdleEvictLeaseProbe | null;
    sessions?: IdleEvictSessionProbe | null;
    nowMs: number;
    stop: (workload: string, kind: IdleEvictKind) => Promise<IdleEvictStopResult>;
  },
): Promise<IdleEvictRow> {
  if (!row.due) {
    return idleEvictSkipped(
      row.workload,
      row.minResidencyUntilMs !== undefined ? "MinResidency" : "NotDue",
    );
  }
  if (!idleStillConfirmed(row, input.leaseRegistry, input.nowMs)) {
    return idleEvictSkipped(row.workload, "NoLongerIdle");
  }
  const sessionHold = idleEvictSessionHold(row.workload, input.sessions);
  if (sessionHold !== null) {
    return sessionHold;
  }
  try {
    const outcome = await input.stop(row.workload, kind);
    return outcome.stopped
      ? { workload: row.workload, action: "evicted", kind }
      : idleEvictSkipped(row.workload, "StopRefused", outcome.detail);
  } catch (err) {
    return idleEvictSkipped(
      row.workload,
      "StopFailed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function runIdleEviction(input: {
  idleEviction: ResidencyStatusIdleEviction;
  leaseRegistry: IdleEvictLeaseProbe | null;
  sessions?: IdleEvictSessionProbe | null;
  nowMs: number;
  targets: readonly IdleEvictTarget[] | null;
  stop: (workload: string, kind: IdleEvictKind) => Promise<IdleEvictStopResult>;
}): Promise<IdleEvictResult> {
  const snapshot = input.idleEviction;
  if (snapshot.status === "disabled") {
    return { ok: false, reason: "Disabled" };
  }
  if (snapshot.status === "unavailable") {
    return { ok: false, reason: snapshot.reason };
  }
  if (input.targets === null) {
    return {
      ok: true,
      dryRun: true,
      windowSeconds: snapshot.idleEvictSeconds,
      rows: snapshot.workloads.map((row) =>
        row.due
          ? (idleEvictSessionHold(row.workload, input.sessions) ?? idleEvictWouldEvict(row))
          : idleEvictSkipped(
              row.workload,
              row.minResidencyUntilMs !== undefined ? "MinResidency" : "NotDue",
            ),
      ),
    };
  }
  const kindByWorkload = new Map(input.targets.map((t) => [t.workload, t.kind] as const));
  const rows: IdleEvictRow[] = [];
  const handled = new Set<string>();
  for (const row of snapshot.workloads) {
    const kind = kindByWorkload.get(row.workload);
    if (kind === undefined) {
      continue;
    }
    handled.add(row.workload);
    rows.push(
      await idleEvictTarget(row, kind, {
        leaseRegistry: input.leaseRegistry,
        sessions: input.sessions ?? null,
        nowMs: input.nowMs,
        stop: input.stop,
      }),
    );
  }
  for (const target of input.targets) {
    if (!handled.has(target.workload)) {
      rows.push(idleEvictSkipped(target.workload, "NotReady"));
    }
  }
  return { ok: true, dryRun: false, windowSeconds: snapshot.idleEvictSeconds, rows };
}

function storeWithScope(store: ResidencyStoreSnapshot): ResidencyStatus["store"] {
  const scope = "serving-process" as const;
  if (!store.present) {
    return { path: store.path, present: false, scope };
  }
  if ("error" in store) {
    return { path: store.path, present: true, error: store.error, scope };
  }
  return {
    path: store.path,
    present: true,
    nonterminalCount: store.nonterminal.length,
    nonterminal: store.nonterminal.map((record) => ({
      operationId: record.operationId,
      model: record.model,
      phase: record.phase,
      targetState: record.targetState,
      reservationGiB: record.reservationGiB,
    })),
    scope,
  };
}

type ModelHostStatusProbe = {
  state: "Running" | "Stopped";
  identityUnknown?: boolean | undefined;
};

export function observedFromModelRun(m: ModelRun): ObservedWorkloadState {
  const phase = m.status?.phase;
  if (phase !== undefined) {
    if (phase === "Running") return "running";
    if (phase === "Stopped") return "stopped";
    // Failed/Pending fail closed as UnknownState for the whole node, even when
    // unrelated to the switch. This is deliberate in this PR: a recorded phase
    // we cannot interpret must not be read as free memory or as a loadable
    // replacement.
    return "unknown";
  }
  return m.spec.enabled ? "unknown" : "stopped";
}

export function observedFromModelHostStatus(s: ModelHostStatusProbe): ObservedWorkloadState {
  if (s.identityUnknown === true) return "unknown";
  // statusModelHost reports recorded-pid liveness only. "starting" (planner
  // state loading) still occupies memory but does not claim readiness, so a
  // live pid is never misread as a serving, ready-probed host.
  return s.state === "Running" ? "starting" : "stopped";
}

function observedAllocation(
  managed: ReturnType<NonNullable<ManagedLaunchAdmission["observeProfileWorkload"]>>,
  fallback: () => number | null,
): number | null {
  return managed?.state === "running" ? managed.allocationGiB : fallback();
}

export function collectResidencyObservations(input: {
  node: string;
  servingNode: string | null;
  modelRuns: readonly ModelRun[];
  modelHosts: readonly ModelHostManifest[];
  modelHostStatus: (name: string) => ModelHostStatusProbe;
  observeManaged?: ManagedLaunchAdmission["observeProfileWorkload"];
  estimateModelRunGiB: (m: ModelRun) => number | null;
  estimateModelHostGiB: (m: ModelHostManifest) => number | null;
}): {
  modelRuns: ModelRun[];
  observed: Map<string, ObservedWorkloadState>;
  memoryGiB: Map<string, number | null>;
} {
  // Gateway registrations have no local process or memory, so excluding them
  // counts them as 0 GiB against the switch budget.
  const modelRuns = input.modelRuns.filter((m) => !m.spec.gateway);
  const observed = new Map<string, ObservedWorkloadState>();
  const memoryGiB = new Map<string, number | null>();

  for (const m of modelRuns) {
    if (m.spec.node !== input.node) continue;
    const managed = input.observeManaged?.(m.metadata.name, m.kind);
    observed.set(m.metadata.name, managed?.state ?? observedFromModelRun(m));
    memoryGiB.set(
      m.metadata.name,
      observedAllocation(
        managed,
        () => m.spec.resources?.expectedMemoryGiB ?? input.estimateModelRunGiB(m),
      ),
    );
  }

  const hostIsLocal = input.servingNode !== null && input.servingNode === input.node;
  const observeHost = hostIsLocal ? input.observeManaged : undefined;
  for (const m of input.modelHosts) {
    if (m.spec.node !== input.node) continue;
    const managed = observeHost?.(m.metadata.name, m.kind);
    memoryGiB.set(
      m.metadata.name,
      observedAllocation(managed, () => input.estimateModelHostGiB(m)),
    );
    // Local pid files say nothing about another node, so leave observed unset
    // (which the coordinator reads as "unknown") unless this node is serving.
    if (hostIsLocal) {
      observed.set(
        m.metadata.name,
        managed?.state ?? observedFromModelHostStatus(input.modelHostStatus(m.metadata.name)),
      );
    }
  }

  return { modelRuns, observed, memoryGiB };
}

export type ResidencyPlanRefusalReason =
  | "StoreUnreadable"
  | "NotOptedIn"
  | "UnknownState"
  | "DuplicateId"
  | "UnknownMemory"
  | "LifecycleUnreadable";

export type ResidencyPlan = ProfileSwitchPlan & {
  dryRun?: true;
  inFlightOperationId?: string | null;
  storeAppliesToNode?: boolean;
  servingNode?: string | null;
  budget?: ResidencyStatus["budget"];
  store?: ResidencyStatus["store"];
};

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function refusal(
  reason: ResidencyPlanRefusalReason,
  detail: string,
  workloads: readonly string[],
): ResidencyPlan {
  return {
    ok: false,
    reason,
    detail,
    workloads: [...workloads].sort(compareStrings),
    retryAfterMs: null,
    steps: [],
  };
}

// The last succeeded profile switch recorded in the serving node's store, read
// from the unscoped snapshot. Defined only when the store applies to this node
// and reads cleanly; the value is kept only when finite (Part of #519).
function recordedSwitchAtMs(
  store: ResidencyStoreSnapshot,
  applies: boolean,
  operationKey: string,
): number | undefined {
  if (!applies || !store.present || "error" in store) {
    return undefined;
  }
  const recorded = store.lastSucceededAtMs?.[operationKey];
  return recorded !== undefined && Number.isFinite(recorded) ? recorded : undefined;
}

// The time each model's residency_states row entered `ready`, read from the
// unscoped snapshot. Defined only when the store applies to this node, reads
// cleanly and carries lifecycle rows; a model maps only when its row is `ready`
// with a finite updatedAtMs (Part of #519). When lifecycle rows are unreadable
// and `minResidencySeconds` is above 0, `buildResidencyPlan` refuses a switch
// that has victims with `LifecycleUnreadable` rather than protecting nothing.
function recordedReadySinceMs(
  store: ResidencyStoreSnapshot,
  applies: boolean,
): ReadonlyMap<string, number> | undefined {
  if (!applies || !store.present || "error" in store || store.lifecycle === undefined) {
    return undefined;
  }
  const readySince = new Map<string, number>();
  for (const row of store.lifecycle) {
    if (row.state === "ready" && Number.isFinite(row.updatedAtMs)) {
      readySince.set(row.model, row.updatedAtMs);
    }
  }
  return readySince;
}

// When the serving node's lifecycle rows are unreadable and `minResidencySeconds`
// is above 0, refuse a switch that has victims: the victims' ready-since times
// cannot be verified (Part of #519). Returns null when the knob is disabled,
// the plan is not ok, the store does not serve, or there are no victims.
function minResidencyLifecycleRefusal(
  snapshot: ResidencyStoreSnapshot,
  applies: boolean,
  minResidencySeconds: number,
  plan: ProfileSwitchPlan,
): ResidencyPlan | null {
  if (
    !applies ||
    minResidencySeconds <= 0 ||
    !plan.ok ||
    !snapshot.present ||
    "error" in snapshot ||
    snapshot.lifecycleError === undefined ||
    plan.victims.length === 0
  ) {
    return null;
  }
  return refusal(
    "LifecycleUnreadable",
    `residency plan refused: lifecycle rows unreadable (${snapshot.lifecycleError}); minResidencySeconds of ${String(minResidencySeconds)} cannot be verified for ${plan.victims.join(", ")}`,
    plan.victims,
  );
}

export function buildResidencyPlan(input: {
  node: string;
  to: string;
  from?: string | null;
  nowMs: number;
  servingNode: string | null;
  budgetGiB: number;
  budgetSource: "noderun" | "computed";
  modelRuns: readonly ModelRun[];
  modelHosts: readonly ModelHostManifest[];
  observed: ReadonlyMap<string, ObservedWorkloadState>;
  memoryGiB: ReadonlyMap<string, number | null>;
  store: ResidencyStoreSnapshot;
  residency?: ResidencyPolicy | null | undefined;
  lastSwitchAtMs?: number | null | undefined;
}): ResidencyPlan {
  const store = storeWithScope(input.store);
  const applies = input.servingNode !== null && input.servingNode === input.node;

  if (applies && store.present && "error" in store) {
    const withStore: ResidencyPlan = {
      ...refusal("StoreUnreadable", `residency store unreadable: ${store.error}`, []),
      store,
    };
    return withStore;
  }

  const inFlightOperationId =
    applies && store.present && !("error" in store)
      ? (store.nonterminal[0]?.operationId ?? null)
      : null;

  const recorded = recordedSwitchAtMs(input.store, applies, profileSwitchOperationKey(input.node));
  const lastSwitchAtMs = input.lastSwitchAtMs !== undefined ? input.lastSwitchAtMs : recorded;

  const resolvedPolicy = resolveResidencyPolicy({
    ...(input.residency?.minResidencySeconds !== undefined
      ? { minResidencySeconds: input.residency.minResidencySeconds }
      : {}),
    ...(input.residency?.switchCooldownSeconds !== undefined
      ? { switchCooldownSeconds: input.residency.switchCooldownSeconds }
      : {}),
  });

  const built = buildProfileSwitchRequest({
    node: input.node,
    to: input.to,
    from: input.from ?? null,
    nowMs: input.nowMs,
    budgetGiB: input.budgetGiB,
    modelRuns: input.modelRuns,
    modelHosts: input.modelHosts,
    observed: input.observed,
    memoryGiBOf: (name) => input.memoryGiB.get(name) ?? Number.NaN,
    policy: {
      minResidencySeconds: resolvedPolicy.minResidencySeconds,
      switchCooldownSeconds: resolvedPolicy.switchCooldownSeconds,
    },
    ...(lastSwitchAtMs !== undefined ? { lastSwitchAtMs } : {}),
  });
  if (!built.ok) {
    return refusal(built.reason, `residency plan refused: ${built.reason}`, built.workloads);
  }

  const counted = (w: PlannerWorkload): boolean =>
    isOccupyingResidencyState(w.state) ||
    (w.state === "downloaded" && w.disabled !== true && w.profiles.includes(input.to));

  const unknownMemory = built.request.workloads
    .filter((w) => counted(w) && !Number.isFinite(w.expectedMemoryGiB))
    .map((w) => w.id);
  if (unknownMemory.length > 0) {
    return refusal(
      "UnknownMemory",
      `${String(unknownMemory.length)} counted workload(s) have unknown memory`,
      unknownMemory,
    );
  }

  // The planner's checkInvalidMemory validates all workloads, so an uncounted
  // workload with unknown memory is charged 0 rather than refused: it is
  // neither retained nor loaded by this switch. An occupying workload with no
  // loadedAtMs is stamped with the ready-since of its lifecycle row, clamped to
  // nowMs so a future-dated row never yields retryAfterMs above the minimum.
  const readySince = recordedReadySinceMs(input.store, applies);
  const patched = built.request.workloads.map((w) => {
    const memoryPatched =
      counted(w) || Number.isFinite(w.expectedMemoryGiB) ? w : { ...w, expectedMemoryGiB: 0 };
    if (
      readySince === undefined ||
      memoryPatched.loadedAtMs !== undefined ||
      !isOccupyingResidencyState(memoryPatched.state)
    ) {
      return memoryPatched;
    }
    const since = readySince.get(memoryPatched.id);
    return since === undefined
      ? memoryPatched
      : { ...memoryPatched, loadedAtMs: Math.min(since, input.nowMs) };
  });

  const plan = planProfileSwitch({
    ...built.request,
    workloads: patched,
    inFlightOperationId,
  });

  const lifecycleRefusal = minResidencyLifecycleRefusal(
    input.store,
    applies,
    resolvedPolicy.minResidencySeconds,
    plan,
  );
  if (lifecycleRefusal !== null) return { ...lifecycleRefusal, store };

  return {
    ...plan,
    dryRun: true,
    inFlightOperationId,
    storeAppliesToNode: applies,
    servingNode: input.servingNode,
    budget: { memoryGiB: input.budgetGiB, source: input.budgetSource },
    store,
  };
}
