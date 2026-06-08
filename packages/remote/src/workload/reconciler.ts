import { applyOne, applyOneModelHost, type ApplyEvent, type ApplyResult, type WorkloadClient } from './apply.js';
import { computeModelHostSpecHash, readModelHostState, removeModelHostState } from '../../../core/src/engines/state.js';
import { resolveEnv } from '../../../core/src/env.js';
import { defaultNodeBudgetGiB } from './admission.js';
import { listWorkloads, loadWorkloadByName, saveWorkload, defaultWorkloadsDir } from './store.js';
import { listModelHosts, saveModelHost } from './modelhost-store.js';
import { listNodeRuns } from './noderun-store.js';
import type { ModelRun } from './schema.js';
import { LOCAL_NODE_ID, type ModelHostManifest } from './modelhost-schema.js';

export interface ReconcileNodeReport {
  name: string;
  node: string;
  action: ApplyResult['action'];
  error?: string;
}

export interface ReconcileResult {
  reports: ReconcileNodeReport[];
  errors: number;
}

export interface ReconcileOptions {
  workloadsDir?: string;
  /** Resolve a workload client for a given node name. Structural so
   *  router.ts can satisfy it without importing NodeClient (which
   *  would re-trigger the AppRouter circular-type alias). */
  getClient: (nodeName: string) => WorkloadClient;
  /** Forwarded to applyOne so the per-workload port-collision
   *  preflight detects aliases that resolve to the same physical node. */
  resolveNodeIdentity?: (nodeName: string) => string | null;
  /** Bubble up per-workload progress for logging. */
  onEvent?: (e: ApplyEvent & { name: string }) => void;
  /** Optional filter to only reconcile a subset. */
  filter?: (m: ModelRun) => boolean;
}

function hostSpecSnapshot(manifest: ModelHostManifest): Record<string, unknown> {
  const { spec } = manifest;
  return {
    engine: spec.engine,
    binary: spec.binary,
    endpoint: spec.endpoint,
    hostedModels: spec.hostedModels,
    extraArgs: spec.extraArgs,
    resources: spec.resources,
    restartPolicy: spec.restartPolicy,
    timeoutSeconds: spec.timeoutSeconds,
    env: spec.env,
  };
}

function liveHostSpecSnapshot(current: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: current.engine,
    binary: current.binary,
    endpoint: current.endpoint,
    hostedModels: current.hostedModels,
    extraArgs: current.extraArgs,
    resources: current.resources,
    restartPolicy: current.restartPolicy,
    timeoutSeconds: current.timeoutSeconds,
    env: current.env,
  };
}

// Retained for future use when modelHostStatus surfaces launch args
// and reconcile can detect spec drift on-tick rather than only on the
// explicit `apply -f` path.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function hostSpecsEqual(manifest: ModelHostManifest, current: Record<string, unknown>): boolean {
  return JSON.stringify(hostSpecSnapshot(manifest)) === JSON.stringify(liveHostSpecSnapshot(current));
}

/**
 * One reconciliation pass across every workload in the store. Each
 * workload is applied in sequence (avoids N parallel serverStart
 * subscriptions competing for the same port on a shared node). The
 * persisted manifest's status section is updated in place so
 * `llamactl get workloads` reflects the latest pass.
 */
export async function reconcileOnce(opts: ReconcileOptions): Promise<ReconcileResult> {
  const dir = opts.workloadsDir ?? defaultWorkloadsDir();
  const all = listWorkloads(dir);
  const hosts = listModelHosts(dir);
  const nodeBudgetByName = new Map<string, number>(
    listNodeRuns(dir).map((nodeRun) => [
      nodeRun.metadata.name,
      defaultNodeBudgetGiB(nodeRun.spec.budget?.memoryGiB),
    ]),
  );
  const manifests = opts.filter ? all.filter(opts.filter) : all;
  const reports: ReconcileNodeReport[] = [];
  let errors = 0;

  for (const manifest of manifests) {
    const name = manifest.metadata.name;
    const { spec } = manifest;
    try {
      const result = await applyOne(manifest, opts.getClient, (e) => {
        opts.onEvent?.({ ...e, name });
      }, undefined, {
        workloadsDir: dir,
        ...(opts.resolveNodeIdentity && { resolveNodeIdentity: opts.resolveNodeIdentity }),
        getNodeBudgetGiB: (nodeName) =>
          nodeBudgetByName.get(nodeName) ?? defaultNodeBudgetGiB(),
      });
      if (result.error) errors++;
      reports.push({
        name,
        node: spec.node,
        action: result.action,
        ...(result.error ? { error: result.error } : {}),
      });
      // Persist status WITHOUT clobbering a concurrent spec edit. A reconcile
      // pass snapshots every manifest up-front (listWorkloads) and can run for
      // minutes when a serverStart on another workload is slow or times out. If
      // `llamactl enable/disable` (or a manual edit) writes spec.enabled to disk
      // during that window, writing back the pass-start snapshot would silently
      // revert it. Re-read the current on-disk manifest and merge only our
      // status; the next pass observes the new spec and converges.
      let toPersist: ModelRun = { ...manifest, status: result.statusSection };
      try {
        toPersist = { ...loadWorkloadByName(name, dir), status: result.statusSection };
      } catch {
        // Manifest deleted/renamed mid-pass — fall back to snapshot + status.
      }
      saveWorkload(toPersist, dir);
    } catch (err) {
      errors++;
      const message = (err as Error).message;
      reports.push({ name, node: spec.node, action: 'unchanged', error: message });
    }
  }

  for (const manifest of hosts) {
    const name = manifest.metadata.name;
    const { spec } = manifest;
    try {
      const client = opts.getClient(spec.node);
      const current = await client.modelHostStatus.query({ workload: name });
      if (spec.enabled === false && current.state !== 'Running') {
        // A disabled host that isn't Running may still have a stale sidecar
        // (e.g. a dead-pid sidecar left by an out-of-band exit). statusModelHost
        // reports Stopped for a dead pid, so this short-circuit now runs before
        // the apply path that would otherwise remove it — sweep it here so the
        // sidecar does not leak. No-op when the sidecar is already absent.
        if (spec.node === LOCAL_NODE_ID) {
          removeModelHostState({ name }, resolveEnv(process.env));
        }
        reports.push({
          name,
          node: spec.node,
          action: 'unchanged',
        });
        continue;
      }
      // Idempotent reconcile with spec-drift detection. For local
      // workloads, the controller-owned sidecar is the source of truth
      // for observed specHash. For remote workloads, trust the remote
      // modelHostStatus.specHash surfaced by the node dispatcher. Skip
      // restart iff Running and observedHash matches desiredHash.
      const desiredHash = computeModelHostSpecHash(spec);
      const observedHash = spec.node === LOCAL_NODE_ID
        ? readModelHostState({ name }, resolveEnv(process.env))?.specHash
        : current.specHash;
      if (current.state === 'Running' && observedHash === desiredHash) {
        reports.push({
          name,
          node: spec.node,
          action: 'unchanged',
        });
        continue;
      }
      const result = await applyOneModelHost(manifest, opts.getClient, (e) => {
        opts.onEvent?.({ ...e, name });
      }, {
        env: process.env,
        workloadsDir: dir,
        getNodeBudgetGiB: (nodeName) =>
          nodeBudgetByName.get(nodeName) ?? defaultNodeBudgetGiB(),
      });
      if (result.ok && result.kind === 'ModelHost') {
        reports.push({
          name,
          node: spec.node,
          action: current.state === 'Running' ? 'restarted' : 'started',
        });
        saveModelHost(result.manifest, dir);
      } else {
        // applyOneModelHost only emits {ok:true, kind:'ModelHost'} or
        // {ok:false, error}; the ModelRun shape can't arrive here, but
        // narrow defensively for TS.
        const errMsg = result.ok ? 'unexpected non-ModelHost outcome' : result.error;
        errors++;
        reports.push({
          name,
          node: spec.node,
          action: 'unchanged',
          error: errMsg,
        });
      }
    } catch (err) {
      errors++;
      const message = (err as Error).message;
      reports.push({ name, node: spec.node, action: 'unchanged', error: message });
    }
  }

  return { reports, errors };
}
