import { applyOne, applyOneModelHost, type ApplyEvent, type ApplyResult, type WorkloadClient } from './apply.js';
import { defaultNodeBudgetGiB } from './admission.js';
import { listWorkloads, saveWorkload, defaultWorkloadsDir } from './store.js';
import { listModelHosts, saveModelHost } from './modelhost-store.js';
import { listNodeRuns } from './noderun-store.js';
import type { ModelRun } from './schema.js';
import type { ModelHostManifest } from './modelhost-schema.js';

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
  };
}

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
      const updated: ModelRun = { ...manifest, status: result.statusSection };
      saveWorkload(updated, dir);
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
        reports.push({
          name,
          node: spec.node,
          action: 'unchanged',
        });
        continue;
      }
      const persisted = manifest.status?.phase === 'Running';
      if (current.state === 'Running' && persisted && hostSpecsEqual(manifest, current as Record<string, unknown>)) {
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
      if (result.ok) {
        reports.push({
          name,
          node: spec.node,
          action: current.state === 'Running' ? 'restarted' : 'started',
        });
        saveModelHost(result.manifest, dir);
      } else {
        errors++;
        reports.push({
          name,
          node: spec.node,
          action: 'unchanged',
          error: result.error,
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
