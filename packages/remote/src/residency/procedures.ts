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
import type { ResidencyAuditEntry, ResidencyLeases } from "@llamactl/core/residency/leases";
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";
import type { PlannerWorkload, ProfileSwitchPlan } from "@llamactl/core/residency/planner";

import { resolveResidencyPolicy } from "@llamactl/core/residency/admission";
import {
  findExclusiveGroupViolations,
  isOccupyingResidencyState,
  RESIDENCY_GROUPS,
} from "@llamactl/core/residency/lifecycle";
import { planProfileSwitch } from "@llamactl/core/residency/planner";

import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type { NodeRun } from "../workload/noderun-schema.js";
import type { ModelRun } from "../workload/schema.js";
import type { OmlxNativeStatusRow } from "./omlx-capability.js";
import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "./store.js";

import { buildProfileSwitchRequest, type ObservedWorkloadState } from "./coordinator.js";
import { profileSwitchOperationKey } from "./profile-transition.js";

type ResidencyPolicy = NonNullable<NodeRun["spec"]["residency"]>;

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
  leases: ResidencyStatusLeases;
  omlxNative?: { scope: "serving-process"; workloads: OmlxNativeStatusRow[] };
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
  nowMs?: number | undefined;
  servingNode?: string | null | undefined;
}): ResidencyStatus {
  const residency = input.nodeRun?.spec.residency;
  return {
    node: input.node,
    nodeRun: { present: input.nodeRun !== undefined },
    policy: residency !== undefined ? { present: true, residency } : { present: false },
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
    }),
    leases: buildResidencyLeaseSnapshot(input.leaseRegistry ?? null, input.leaseWorkloads ?? []),
    omlxNative: { scope: "serving-process", workloads: [...(input.omlxNative ?? [])] },
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
// one returning a non-finite value, yields null time fields and due false.
function idleEvictionRowFor(
  row: ResidencyStateRecord,
  registry: ResidencyStatusLeaseRegistry,
  idleEvictSeconds: number,
  nowMs: number,
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
  const dueAtMs = idleSinceMs + idleEvictSeconds * 1000;
  return {
    workload: row.model,
    readySinceMs: row.updatedAtMs,
    lastActivityAtMs: lastActivityMs,
    idleSinceMs,
    activeLeaseCount,
    dueAtMs,
    due: snap.phase === "open" && activeLeaseCount === 0 && nowMs >= dueAtMs,
  };
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
// open with no active leases and nowMs at or past dueAtMs. A registry without
// `lastActivityAtMs`, or one returning a non-finite value, yields null time
// fields and due false. This module never evicts, sleeps or schedules anything.
export function buildIdleEvictionSnapshot(input: {
  residency: ResidencyPolicy | null | undefined;
  servingNode: string | null;
  node: string;
  store: ResidencyStoreSnapshot;
  leaseRegistry: ResidencyStatusLeaseRegistry | null;
  nowMs: number;
}): ResidencyStatusIdleEviction {
  const scope = "serving-process" as const;
  const idleEvictSeconds = resolveResidencyPolicy(
    input.residency?.idleEvictSeconds === undefined
      ? null
      : { idleEvictSeconds: input.residency.idleEvictSeconds },
  ).idleEvictSeconds;
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
    const mapped = idleEvictionRowFor(row, registry, idleEvictSeconds, input.nowMs);
    if (mapped !== null) {
      workloads.push(mapped);
    }
  }
  workloads.sort((a, b) => compareStrings(a.workload, b.workload));
  return { status: "available", scope, advisory: true, idleEvictSeconds, workloads };
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

export function collectResidencyObservations(input: {
  node: string;
  servingNode: string | null;
  modelRuns: readonly ModelRun[];
  modelHosts: readonly ModelHostManifest[];
  modelHostStatus: (name: string) => ModelHostStatusProbe;
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
    observed.set(m.metadata.name, observedFromModelRun(m));
    memoryGiB.set(
      m.metadata.name,
      m.spec.resources?.expectedMemoryGiB ?? input.estimateModelRunGiB(m),
    );
  }

  const hostIsLocal = input.servingNode !== null && input.servingNode === input.node;
  for (const m of input.modelHosts) {
    if (m.spec.node !== input.node) continue;
    memoryGiB.set(m.metadata.name, input.estimateModelHostGiB(m));
    // Local pid files say nothing about another node, so leave observed unset
    // (which the coordinator reads as "unknown") unless this node is serving.
    if (hostIsLocal) {
      observed.set(
        m.metadata.name,
        observedFromModelHostStatus(input.modelHostStatus(m.metadata.name)),
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
  | "UnknownMemory";

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
// with a finite updatedAtMs (Part of #519).
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
