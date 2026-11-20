/**
 * #519 — residency ranking inputs for the shared unified proxy.
 * `residencyRankingInputs` is the pure mapping from a NodeRun's
 * spec.residency plus the node-local residency-store snapshot to the
 * ranking policy and the ranking signals `rankRouteCandidates`
 * consumes; `createResidencyRankingSource` caches that mapping for
 * `LLAMACTL_NODE_NAME`-selected NodeRuns behind a ttl.
 *
 * Part of #518 (c): `switchCooldownSeconds` also feeds the ranker's
 * `cooldownUntil` signal — the absolute expiry instant of this node's
 * last succeeded profile switch (`lastSucceededAtMs` keyed by
 * `profile-switch:<nodeName>`) plus the cooldown. Its limits:
 * - peers are never charged (only ads owned by `nodeId` qualify);
 * - unknown residency — an absent, errored or lifecycle-unreadable
 *   store — charges nothing;
 * - a local workload with no `ready` lifecycle row counts as
 *   non-resident and is charged, the same limit as the resident set.
 *
 * Part of #518: `minResidencySeconds` also feeds the ranker's
 * `cooldownUntil` signal — a local candidate without a `ready`
 * lifecycle row whose exclusive residency group is held by another
 * member in `ready` is charged until that member has been `ready` for
 * `minResidencySeconds`, composed with the switch cooldown as the later
 * instant. Its limits:
 * - peers are never charged (only ads owned by `nodeId` qualify);
 * - unknown residency — an absent, errored or lifecycle-unreadable
 *   store — charges nothing;
 * - only `ready` occupants of a declared-exclusive group hold
 *   (`state === "ready"`, not `isOccupyingResidencyState`);
 * - only a candidate with a lifecycle row tagged with the group is
 *   charged; a candidate with no lifecycle row is never charged;
 * - the latest-ready occupant sets the hold (max `updatedAtMs` per
 *   model within the group);
 * - an expired hold still reports its past instant (not clamped to now);
 * - when `minResidencySeconds` is 0, the hold is absent and the switch
 *   cooldown value stands alone;
 * - it is emitted only when a ranking knob is nonzero (the store is not
 *   read otherwise) and does not need the resident set, since the
 *   ranker's cooldown charge does not consult `signals.resident`.
 *
 * The operational signal (Part of #518) maps `draining`/`unloading`
 * lifecycle rows to "draining" and `failed` rows to "failed" on the
 * ranker's `operationalState` callback. Its limits:
 * - peers are never marked (only ads owned by `nodeId` qualify);
 * - an unknown or errored store marks nothing;
 * - the store is read only when a ranking knob is nonzero.
 *
 * Part of #518 (c): the drain signal folds the profile-switch drain budget
 * (`DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs`) into the ranker's `drainMs`
 * callback — a local candidate without a `ready` lifecycle row whose
 * declared-exclusive residency group is held by another member in an
 * occupying state is charged the switch cost once. Its limits:
 * - peers are never charged (only ads owned by `nodeId` qualify);
 * - only `RESIDENCY_GROUPS` groups declared `exclusive: true` count;
 * - only a candidate with a lifecycle row tagged with the group is
 *   charged; a candidate with no lifecycle row is never charged;
 * - only `loading`, `warming` or `ready` occupants hold a group
 *   (`isOccupyingResidencyState`);
 * - nothing is charged on an absent or errored store;
 * - it is emitted only alongside the resident set, since the ranker's
 *   `drainCostMs` is inert without `signals.resident`.
 */
import type { routingRanking } from "@llamactl/core";
import type { ResidencyPolicy } from "@llamactl/core/residency/admission";

import { resolveResidencyPolicy } from "@llamactl/core/residency/admission";
import { isOccupyingResidencyState, RESIDENCY_GROUPS } from "@llamactl/core/residency/lifecycle";
import { DEFAULT_PROFILE_SWITCH_TIMEOUTS } from "@llamactl/core/residency/planner";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../residency/store.js";
import type { NodeRun, NodeRunResidency } from "../workload/noderun-schema.js";

import { defaultResidencyStorePath, readResidencyStoreSnapshot } from "../residency/store.js";
import { defaultNodeRunsDir, listNodeRuns } from "../workload/noderun-store.js";

const RESIDENCY_TTL_MS = 5_000;

/** The catalog owns the `deploy/<owner>/<workload>` shape (catalog.ts:246). */
function residentDeploymentId(nodeId: string, model: string): string {
  return `deploy/${nodeId}/${model}`;
}

// profileSwitchOperationKey (profile-transition.ts:829) owns the
// `profile-switch:<node>` store key; inlined because the #284 importer
// allowlist in profile-transition.test.ts reserves that module for the
// apply-profile caller chain.
function profileSwitchStoreKey(nodeName: string): string {
  return `profile-switch:${nodeName}`;
}

function readyDeploymentIds(
  lifecycle: readonly ResidencyStateRecord[],
  nodeId: string,
): Set<string> {
  const ready = new Set<string>();
  for (const row of lifecycle) {
    if (row.state === "ready") {
      ready.add(residentDeploymentId(nodeId, row.model));
    }
  }
  return ready;
}

function operationalStates(
  lifecycle: readonly ResidencyStateRecord[],
  nodeId: string,
): Map<string, routingRanking.OperationalState> {
  const states = new Map<string, routingRanking.OperationalState>();
  for (const row of lifecycle) {
    if (row.state === "draining" || row.state === "unloading") {
      states.set(residentDeploymentId(nodeId, row.model), "draining");
    } else if (row.state === "failed") {
      states.set(residentDeploymentId(nodeId, row.model), "failed");
    }
  }
  return states;
}

const EXCLUSIVE_RESIDENCY_GROUPS: ReadonlySet<string> = new Set(
  RESIDENCY_GROUPS.filter((group) => group.exclusive).map((group) => group.name),
);

function exclusiveGroup(group: string | null): string | undefined {
  return group !== null && EXCLUSIVE_RESIDENCY_GROUPS.has(group) ? group : undefined;
}

function occupyingModelsByGroup(
  lifecycle: readonly ResidencyStateRecord[],
): Map<string, Set<string>> {
  const byGroup = new Map<string, Set<string>>();
  for (const row of lifecycle) {
    const group = exclusiveGroup(row.group);
    if (group === undefined || !isOccupyingResidencyState(row.state)) continue;
    const models = byGroup.get(group) ?? new Set<string>();
    models.add(row.model);
    byGroup.set(group, models);
  }
  return byGroup;
}

function heldByOtherMember(occupants: ReadonlySet<string> | undefined, model: string): boolean {
  if (occupants === undefined) return false;
  for (const occupant of occupants) {
    if (occupant !== model) return true;
  }
  return false;
}

function chargedDeploymentIds(input: {
  lifecycle: readonly ResidencyStateRecord[];
  nodeId: string;
  ready: ReadonlySet<string>;
  occupantsByGroup: ReadonlyMap<string, ReadonlySet<string>>;
}): Set<string> {
  const charged = new Set<string>();
  for (const row of input.lifecycle) {
    const group = exclusiveGroup(row.group);
    if (group === undefined) continue;
    const deploymentId = residentDeploymentId(input.nodeId, row.model);
    if (input.ready.has(deploymentId)) continue;
    if (heldByOtherMember(input.occupantsByGroup.get(group), row.model)) {
      charged.add(deploymentId);
    }
  }
  return charged;
}

function exclusiveDrainSignal(input: {
  lifecycle: readonly ResidencyStateRecord[];
  nodeId: string;
  ready: ReadonlySet<string>;
}): routingRanking.RankingSignals["drainMs"] {
  const occupantsByGroup = occupyingModelsByGroup(input.lifecycle);
  const charged = chargedDeploymentIds({ ...input, occupantsByGroup });
  if (charged.size === 0) return undefined;
  const drainMs: NonNullable<routingRanking.RankingSignals["drainMs"]> = (ad) =>
    ad.ownerNodeId === input.nodeId && charged.has(ad.deploymentId)
      ? DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs
      : undefined;
  return drainMs;
}

function rankingKnobsActive(resolved: ResidencyPolicy): boolean {
  return (
    resolved.residentPreference !== 0 ||
    resolved.coldLoadPenaltyMs !== 0 ||
    resolved.switchCooldownSeconds !== 0 ||
    resolved.minResidencySeconds !== 0
  );
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

function switchCooldownSignal(input: {
  cooldownMs: number;
  nodeName: string | undefined;
  lastSucceededAtMs: Readonly<Record<string, number>> | undefined;
  nodeId: string;
  ready: ReadonlySet<string>;
}): routingRanking.RankingSignals["cooldownUntil"] {
  const nodeName = input.nodeName?.trim() ?? "";
  if (input.cooldownMs <= 0 || nodeName === "") return undefined;
  const recorded = input.lastSucceededAtMs?.[profileSwitchStoreKey(nodeName)];
  if (recorded === undefined || !Number.isFinite(recorded)) return undefined;
  const until = recorded + input.cooldownMs;
  const cooldownUntil: NonNullable<routingRanking.RankingSignals["cooldownUntil"]> = (ad) =>
    ad.ownerNodeId === input.nodeId && !input.ready.has(ad.deploymentId) ? until : undefined;
  return cooldownUntil;
}

export interface ResidencyRankingInputsResult {
  policy: NodeRunResidency | null;
  signals: routingRanking.RankingSignals;
}

function latestReadyByGroup(
  lifecycle: readonly ResidencyStateRecord[],
): Map<string, Map<string, number>> {
  const readyByGroup = new Map<string, Map<string, number>>();
  for (const row of lifecycle) {
    const group = row.state === "ready" ? exclusiveGroup(row.group) : undefined;
    if (group === undefined) continue;
    const byModel = readyByGroup.get(group) ?? new Map<string, number>();
    byModel.set(row.model, Math.max(byModel.get(row.model) ?? row.updatedAtMs, row.updatedAtMs));
    readyByGroup.set(group, byModel);
  }
  return readyByGroup;
}

function latestOtherReadyAtMs(
  byModel: ReadonlyMap<string, number> | undefined,
  model: string,
): number | undefined {
  let latest: number | undefined;
  for (const [occupant, updatedAtMs] of byModel ?? []) {
    if (occupant !== model) latest = maxDefined(latest, updatedAtMs);
  }
  return latest;
}

function minResidencyHoldSignal(input: {
  lifecycle: readonly ResidencyStateRecord[];
  nodeId: string;
  ready: ReadonlySet<string>;
  minMs: number;
}): Map<string, number> | undefined {
  if (input.minMs <= 0) return undefined;
  const readyByGroup = latestReadyByGroup(input.lifecycle);
  const holdUntil = new Map<string, number>();
  for (const row of input.lifecycle) {
    const group = exclusiveGroup(row.group);
    if (group === undefined) continue;
    const deploymentId = residentDeploymentId(input.nodeId, row.model);
    if (input.ready.has(deploymentId)) continue;
    const readyAtMs = latestOtherReadyAtMs(readyByGroup.get(group), row.model);
    if (readyAtMs === undefined) continue;
    const until = maxDefined(holdUntil.get(deploymentId), readyAtMs + input.minMs);
    if (until !== undefined) holdUntil.set(deploymentId, until);
  }
  return holdUntil.size === 0 ? undefined : holdUntil;
}

function composedCooldownSignal(input: {
  switchCooldownUntil: routingRanking.RankingSignals["cooldownUntil"];
  holdUntil: ReadonlyMap<string, number> | undefined;
  nodeId: string;
}): routingRanking.RankingSignals["cooldownUntil"] {
  const { switchCooldownUntil, holdUntil, nodeId } = input;
  if (switchCooldownUntil === undefined && holdUntil === undefined) return undefined;
  return (ad): number | undefined =>
    ad.ownerNodeId === nodeId
      ? maxDefined(switchCooldownUntil?.(ad), holdUntil?.get(ad.deploymentId))
      : undefined;
}

function operationalStateSignal(
  lifecycle: readonly ResidencyStateRecord[],
  nodeId: string,
): routingRanking.RankingSignals["operationalState"] {
  const states = operationalStates(lifecycle, nodeId);
  if (states.size === 0) return undefined;
  return (ad): routingRanking.OperationalState | undefined =>
    ad.ownerNodeId === nodeId ? states.get(ad.deploymentId) : undefined;
}

/**
 * Map a NodeRun's spec.residency plus a residency-store snapshot to the
 * ranking policy and ranking signals. The policy is the raw NodeRun value
 * (null when absent); every knob resolves to its default there. With all
 * ranking knobs at 0, or the store absent/errored/lifecycle-undefined,
 * signals stay `{}` so ranking keeps its unknown-residency behaviour.
 *
 * The resident set (residentPreference or coldLoadPenaltyMs nonzero)
 * counts only `ready` residency_states rows as resident — lifecycle rows
 * exist only for workloads moved through profile switches, so a local
 * workload started by a plain apply with no row ranks as non-resident
 * when a knob is nonzero, and peers fall outside `residencyKnown`, so
 * they are neither charged nor rewarded. A local workload with no ready
 * row is still charged, so a peer outranks it.
 *
 * The cooldown signal (switchCooldownSeconds nonzero, a non-blank
 * `nodeName`, a clean store and a finite recorded switch) reports the
 * absolute expiry instant for this node's last succeeded profile
 * switch; it charges only local ads outside the ready set — peers and
 * ready rows are never charged, and a missing recorded switch charges
 * nothing.
 *
 * The hold signal (minResidencySeconds nonzero, a clean store) reports
 * the absolute expiry instant for local candidates without a `ready`
 * lifecycle row whose exclusive residency group is held by another
 * member in `ready` — the latest-ready occupant (max `updatedAtMs` per
 * model) sets the hold; peers are never charged, an absent or errored
 * store charges nothing, and a candidate with no lifecycle row is never
 * charged. When both hold and switch cooldown exist, the later instant
 * is used; when `minResidencySeconds` is 0, the hold is absent and the
 * switch cooldown value stands alone.
 *
 * The operational signal (Part of #518) reports the node-local lifecycle
 * state of a local candidate's workload: `draining`/`unloading` rows map
 * to "draining" and `failed` rows map to "failed"; every other state and
 * every peer report undefined. The key is emitted only when at least one
 * row is marked, so unknown inputs keep `{}` signals. Peers are never
 * marked, an absent or errored store marks nothing, and the store is read
 * only when a ranking knob is nonzero.
 *
 * The drain signal (Part of #518 (c)) charges `DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs`
 * once to a local candidate without a `ready` lifecycle row whose
 * declared-exclusive residency group is held by another member in an
 * occupying state (`loading`/`warming`/`ready`). It is emitted only
 * alongside the resident set (residentPreference or coldLoadPenaltyMs
 * nonzero), since the ranker's `drainCostMs` is inert without
 * `signals.resident`; only a candidate with a lifecycle row tagged with the
 * group is charged (a candidate with no lifecycle row is never charged),
 * peers are never charged, an absent or errored store charges nothing, and
 * a candidate is never dropped — ranking only orders.
 */
export function residencyRankingInputs(input: {
  residency: NodeRunResidency | null | undefined;
  store: ResidencyStoreSnapshot;
  nodeId: string;
  nodeName?: string;
}): ResidencyRankingInputsResult {
  const policy = input.residency ?? null;
  const partial = policy === null ? null : toPartialResidencyPolicy(policy);
  const resolved = resolveResidencyPolicy(partial);
  const store = input.store.present && !("error" in input.store) ? input.store : undefined;
  const lifecycle = store?.lifecycle;
  if (!rankingKnobsActive(resolved) || lifecycle === undefined) {
    return { policy, signals: {} };
  }
  const ready = readyDeploymentIds(lifecycle, input.nodeId);
  const residentSetEmitted = resolved.residentPreference !== 0 || resolved.coldLoadPenaltyMs !== 0;
  const drainMs = residentSetEmitted
    ? exclusiveDrainSignal({ lifecycle, nodeId: input.nodeId, ready })
    : undefined;
  const switchCooldownUntil = switchCooldownSignal({
    cooldownMs: resolved.switchCooldownSeconds * 1000,
    nodeName: input.nodeName,
    lastSucceededAtMs: store?.lastSucceededAtMs,
    nodeId: input.nodeId,
    ready,
  });
  const cooldownUntil = composedCooldownSignal({
    switchCooldownUntil,
    holdUntil: minResidencyHoldSignal({
      lifecycle,
      nodeId: input.nodeId,
      ready,
      minMs: resolved.minResidencySeconds * 1000,
    }),
    nodeId: input.nodeId,
  });
  const operationalState = operationalStateSignal(lifecycle, input.nodeId);
  const residencyKnown: NonNullable<routingRanking.RankingSignals["residencyKnown"]> = (ad) =>
    ad.ownerNodeId === input.nodeId;
  const signals: routingRanking.RankingSignals = {
    ...(residentSetEmitted ? { resident: ready, residencyKnown } : {}),
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
    ...(operationalState === undefined ? {} : { operationalState }),
    ...(drainMs === undefined ? {} : { drainMs }),
  };
  return { policy, signals };
}

/**
 * Copy the NodeRun-shaped policy into the core Partial type so the strict
 * gate's exactOptionalPropertyTypes accepts it downstream. The parse-only
 * idle-eviction knob is deliberately not carried over.
 */
function toPartialResidencyPolicy(residency: NodeRunResidency | null): Partial<ResidencyPolicy> {
  if (residency === null) return {};
  return {
    ...(residency.minResidencySeconds !== undefined
      ? { minResidencySeconds: residency.minResidencySeconds }
      : {}),
    ...(residency.switchCooldownSeconds !== undefined
      ? { switchCooldownSeconds: residency.switchCooldownSeconds }
      : {}),
    ...(residency.safetyMarginRatio !== undefined
      ? { safetyMarginRatio: residency.safetyMarginRatio }
      : {}),
    ...(residency.residentPreference !== undefined
      ? { residentPreference: residency.residentPreference }
      : {}),
    ...(residency.coldLoadPenaltyMs !== undefined
      ? { coldLoadPenaltyMs: residency.coldLoadPenaltyMs }
      : {}),
  };
}

export interface ResidencyRankingSource {
  policy(): Partial<ResidencyPolicy> | null;
  signals(): routingRanking.RankingSignals;
}

interface Snapshot {
  policy: Partial<ResidencyPolicy> | null;
  signals: routingRanking.RankingSignals;
  loadedAt: number;
}

/**
 * Cached ranking-input source: policy() and signals() share one snapshot,
 * refreshed when `now() - loadedAt >= ttlMs`. The serving node name is
 * `env.LLAMACTL_NODE_NAME`; blank means no NodeRun is selected and
 * neither reader runs. The store is read only when the selected NodeRun's
 * spec.residency has a nonzero ranking knob. A throwing reader degrades
 * to a null policy and `{}` signals; values are never logged.
 */
export function createResidencyRankingSource(input: {
  env: NodeJS.ProcessEnv;
  nodeId: string;
  listNodeRuns?: () => NodeRun[];
  readStore?: () => ResidencyStoreSnapshot;
  now?: () => number;
  ttlMs?: number;
}): ResidencyRankingSource {
  const env = input.env;
  const ttlMs = input.ttlMs ?? RESIDENCY_TTL_MS;
  const now: () => number = input.now ?? ((): number => Date.now());
  const readNodeRuns: () => NodeRun[] =
    input.listNodeRuns ?? ((): NodeRun[] => listNodeRuns(defaultNodeRunsDir(env)));
  const readStore: () => ResidencyStoreSnapshot =
    input.readStore ??
    ((): ResidencyStoreSnapshot => readResidencyStoreSnapshot(defaultResidencyStorePath(env)));

  let snapshot: Snapshot | null = null;

  function readFresh(): ResidencyRankingInputsResult {
    const nodeName = env["LLAMACTL_NODE_NAME"]?.trim() ?? "";
    if (nodeName === "") return { policy: null, signals: {} };
    try {
      const nodeRun = readNodeRuns().find((run) => run.metadata.name === nodeName);
      const residency = nodeRun?.spec.residency ?? null;
      const partial = residency === null ? null : toPartialResidencyPolicy(residency);
      const resolved = resolveResidencyPolicy(partial);
      if (!rankingKnobsActive(resolved)) {
        return { policy: residency, signals: {} };
      }
      return residencyRankingInputs({
        residency,
        store: readStore(),
        nodeId: input.nodeId,
        nodeName,
      });
    } catch {
      return { policy: null, signals: {} };
    }
  }

  function current(): Snapshot {
    const at = now();
    if (snapshot !== null && at - snapshot.loadedAt < ttlMs) return snapshot;
    const inputs = readFresh();
    const fresh: Snapshot = {
      policy: inputs.policy === null ? null : toPartialResidencyPolicy(inputs.policy),
      signals: inputs.signals,
      loadedAt: at,
    };
    snapshot = fresh;
    return fresh;
  }

  return {
    policy: () => current().policy,
    signals: () => current().signals,
  };
}
