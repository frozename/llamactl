import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { router } from '../src/router.js';
import { saveNodeRun } from '../src/workload/noderun-store.js';
import { parseWorkload, saveWorkload } from '../src/workload/store.js';

const originalEnv = { ...process.env };
let tmp = '';

const nodeRunYaml = `
apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: budget-node
spec:
  node: local
  budget:
    memoryGiB: 36
  infra: []
`;

const workloadA = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: granite41-8b-long-lived
spec:
  node: local
  target:
    kind: rel
    value: granite41-8b.gguf
  enabled: true
  resources:
    expectedMemoryGiB: 8
  endpoint:
    host: 127.0.0.1
    port: 8181
`;

const workloadB = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: gemma4-26b-a4b-mtp
spec:
  node: local
  target:
    kind: rel
    value: gemma4-26b.gguf
  enabled: true
  resources:
    expectedMemoryGiB: 16
  endpoint:
    host: 127.0.0.1
    port: 8090
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-router-node-budget-'));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, 'config-missing'),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('nodeBudget', () => {
  test('rolls up budget and reserved memory for workloads on a node', async () => {
    saveNodeRun(
      {
        apiVersion: 'llamactl/v1',
        kind: 'NodeRun',
        metadata: { name: 'budget-node', labels: {} },
        spec: {
          node: 'local',
          budget: { memoryGiB: 36 },
          infra: [],
        },
      },
      tmp,
    );
    saveWorkload(parseWorkload(workloadA), tmp);
    saveWorkload(parseWorkload(workloadB), tmp);

    const caller = router.createCaller({});
    const result = await caller.nodeBudget({ node: 'local' });

    expect(result.budget).toBe(36);
    expect(result.reserved).toBe(24);
    expect(result.workloads.length).toBe(2);
    expect(result.workloads.map((w) => w.name)).toEqual([
      'gemma4-26b-a4b-mtp',
      'granite41-8b-long-lived',
    ]);
  });
});
