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
//
// The NodeRun residency supplies the planner policy (Part of #519); switch/load
// timing (lastSwitchAtMs, loadedAtMs) is not persisted yet, so those checks stay
// inert unless a caller supplies them (#279).
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type { PlannerWorkload, ProfileSwitchPlan } from "@llamactl/core/residency/planner";

import { resolveResidencyPolicy } from "@llamactl/core/residency/admission";
import { isOccupyingResidencyState } from "@llamactl/core/residency/lifecycle";
import { planProfileSwitch } from "@llamactl/core/residency/planner";

import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type { NodeRun } from "../workload/noderun-schema.js";
import type { ModelRun } from "../workload/schema.js";
import type { ResidencyStoreSnapshot } from "./store.js";

import { buildProfileSwitchRequest, type ObservedWorkloadState } from "./coordinator.js";

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
  leases: ResidencyStatusLeases;
};

export function buildResidencyStatus(input: {
  node: string;
  nodeRun: NodeRun | undefined;
  budgetGiB: number;
  budgetSource: "noderun" | "computed";
  store: ResidencyStoreSnapshot;
  leaseRegistry?: Pick<ResidencyLeases, "snapshot" | "audit"> | null | undefined;
  leaseWorkloads?: readonly string[] | undefined;
}): ResidencyStatus {
  const residency = input.nodeRun?.spec.residency;
  return {
    node: input.node,
    nodeRun: { present: input.nodeRun !== undefined },
    policy: residency !== undefined ? { present: true, residency } : { present: false },
    budget: { memoryGiB: input.budgetGiB, source: input.budgetSource },
    store: storeWithScope(input.store),
    leases: buildResidencyLeaseSnapshot(input.leaseRegistry ?? null, input.leaseWorkloads ?? []),
  };
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
    ...(input.lastSwitchAtMs !== undefined ? { lastSwitchAtMs: input.lastSwitchAtMs } : {}),
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
  // neither retained nor loaded by this switch.
  const patched = built.request.workloads.map((w) =>
    counted(w) || Number.isFinite(w.expectedMemoryGiB) ? w : { ...w, expectedMemoryGiB: 0 },
  );

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
