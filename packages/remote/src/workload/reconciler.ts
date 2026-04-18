import type { NodeClient } from '../client/node-client.js';
import { applyOne, type ApplyEvent, type ApplyResult } from './apply.js';
import { listWorkloads, saveWorkload, defaultWorkloadsDir } from './store.js';
import type { ModelRun } from './schema.js';

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
  /** Resolve a NodeClient for a given node name (injected for tests). */
  getClient: (nodeName: string) => NodeClient;
  /** Bubble up per-workload progress for logging. */
  onEvent?: (e: ApplyEvent & { name: string }) => void;
  /** Optional filter to only reconcile a subset. */
  filter?: (m: ModelRun) => boolean;
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
  const manifests = opts.filter ? all.filter(opts.filter) : all;
  const reports: ReconcileNodeReport[] = [];
  let errors = 0;

  for (const manifest of manifests) {
    const name = manifest.metadata.name;
    const { spec } = manifest;
    try {
      const client = opts.getClient(spec.node);
      const result = await applyOne(manifest, client, (e) => {
        opts.onEvent?.({ ...e, name });
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

  return { reports, errors };
}
