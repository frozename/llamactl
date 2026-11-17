/**
 * #519 — residency ranking inputs for the shared unified proxy.
 * `residencyRankingInputs` is the pure mapping from a NodeRun's
 * spec.residency plus the node-local residency-store snapshot to the
 * ranking policy and the resident deploymentIds `rankRouteCandidates`
 * consumes; `createResidencyRankingSource` caches that mapping for
 * `LLAMACTL_NODE_NAME`-selected NodeRuns behind a ttl.
 */
import type { routingRanking } from "@llamactl/core";
import type { ResidencyPolicy } from "@llamactl/core/residency/admission";

import { resolveResidencyPolicy } from "@llamactl/core/residency/admission";

import type { ResidencyStoreSnapshot } from "../residency/store.js";
import type { NodeRun, NodeRunResidency } from "../workload/noderun-schema.js";

import { defaultResidencyStorePath, readResidencyStoreSnapshot } from "../residency/store.js";
import { defaultNodeRunsDir, listNodeRuns } from "../workload/noderun-store.js";

const RESIDENCY_TTL_MS = 5_000;

/** The catalog owns the `deploy/<owner>/<workload>` shape (catalog.ts:246). */
function residentDeploymentId(nodeId: string, model: string): string {
  return `deploy/${nodeId}/${model}`;
}

export interface ResidencyRankingInputsResult {
  policy: NodeRunResidency | null;
  signals: routingRanking.RankingSignals;
}

/**
 * Map a NodeRun's spec.residency plus a residency-store snapshot to the
 * ranking policy and resident set. The policy is the raw NodeRun value
 * (null when absent); both ranking knobs resolve to 0 there, or the store
 * is absent/errored/lifecycle-undefined, signals stay `{}` with no
 * `resident` key so ranking keeps its unknown-residency behaviour.
 *
 * Two limits of the resident set:
 * - Only workloads with a `ready` residency_states row count as resident.
 *   Lifecycle rows exist only for workloads moved through profile
 *   switches, so a local workload started by a plain apply with no row
 *   ranks as non-resident when a knob is nonzero.
 * - Peers are never in the set, so they also rank as non-resident.
 */
export function residencyRankingInputs(input: {
  residency: NodeRunResidency | null | undefined;
  store: ResidencyStoreSnapshot;
  nodeId: string;
}): ResidencyRankingInputsResult {
  const policy = input.residency ?? null;
  const resolved = resolveResidencyPolicy(
    policy === null ? null : toPartialResidencyPolicy(policy),
  );
  if (resolved.residentPreference === 0 && resolved.coldLoadPenaltyMs === 0) {
    return { policy, signals: {} };
  }
  if (!input.store.present || "error" in input.store || input.store.lifecycle === undefined) {
    return { policy, signals: {} };
  }
  const resident = new Set<string>();
  for (const row of input.store.lifecycle) {
    if (row.state === "ready") {
      resident.add(residentDeploymentId(input.nodeId, row.model));
    }
  }
  return { policy, signals: { resident } };
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
      if (resolved.residentPreference === 0 && resolved.coldLoadPenaltyMs === 0) {
        return { policy: residency, signals: {} };
      }
      return residencyRankingInputs({
        residency,
        store: readStore(),
        nodeId: input.nodeId,
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
