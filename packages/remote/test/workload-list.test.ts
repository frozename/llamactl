import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { router } from '../src/router.js';
import { parseWorkload, saveWorkload } from '../src/workload/store.js';

/**
 * E.4 — `workloadList` returns a per-row summary of each declared
 * ModelRun so the Workloads UI can show a multi-node badge on the row
 * without fetching the full manifest. We assert two new fields are
 * populated from `spec.workers[]`: `workerCount` and `workerNodes`.
 *
 * Scopes the workloads dir under a tempdir via LLAMACTL_WORKLOADS_DIR
 * so the suite never touches ~/.llamactl/workloads/. The procedure
 * also consults the kubeconfig for per-node reachability, but that
 * side-channel is irrelevant to the manifest-derived fields we test
 * here — when the node is unreachable the row still populates the
 * worker summary from the on-disk manifest.
 */
let tmp = '';
const originalEnv = { ...process.env };

const multiNodeYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: llama-70b-split
spec:
  node: coordinator
  target:
    kind: rel
    value: llama-70b.gguf
  workers:
    - node: gpu-worker-1
      rpcHost: 10.0.0.21
      rpcPort: 50052
    - node: gpu-worker-2
      rpcHost: 10.0.0.22
      rpcPort: 50052
  timeoutSeconds: 60
`;

const singleNodeYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: gemma-solo
spec:
  node: local
  target:
    kind: rel
    value: gemma.gguf
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-workload-list-'));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    // Pin the config lookup to a file that does not exist, so
    // kubecfg.loadConfig returns a fresh empty config and workloadList
    // falls through to "Unreachable" deterministically instead of
    // picking up the dev machine's real ~/.llamactl/config.
    LLAMACTL_CONFIG: join(tmp, 'config-missing'),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('workloadList', () => {
  test('populates workerCount + workerNodes for multi-node workloads', async () => {
    saveWorkload(parseWorkload(multiNodeYaml), tmp);
    saveWorkload(parseWorkload(singleNodeYaml), tmp);

    const caller = router.createCaller({});
    const rows = await caller.workloadList();

    const byName = Object.fromEntries(rows.map((r) => [r.name, r] as const));

    const multi = byName['llama-70b-split'];
    expect(multi).toBeDefined();
    expect(multi!.workerCount).toBe(2);
    expect(multi!.workerNodes).toEqual(['gpu-worker-1', 'gpu-worker-2']);
    expect(multi!.node).toBe('coordinator');
    expect(multi!.rel).toBe('llama-70b.gguf');

    const solo = byName['gemma-solo'];
    expect(solo).toBeDefined();
    expect(solo!.workerCount).toBe(0);
    expect(solo!.workerNodes).toEqual([]);
  });
});
