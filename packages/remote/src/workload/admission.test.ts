import { expect, test } from 'bun:test';
import {
  computeNodeBudget,
  estimateWorkloadMemoryGiB,
  sumReservedForNode,
  type AdmissionInput,
} from './admission.js';
import type { ModelRun } from './schema.js';

const mkManifest = (
  name: string,
  opts: Partial<{ enabled: boolean; expectedMemoryGiB: number; node: string }> = {},
): ModelRun => ({
  apiVersion: 'llamactl/v1',
  kind: 'ModelRun',
  metadata: { name, labels: {}, annotations: {} },
  spec: {
    node: opts.node ?? 'local',
    enabled: opts.enabled ?? true,
    target: { kind: 'rel', value: 'x.gguf' },
    extraArgs: [],
    workers: [],
    restartPolicy: 'Always',
    gateway: false,
    timeoutSeconds: 60,
    resources:
      opts.expectedMemoryGiB !== undefined
        ? { expectedMemoryGiB: opts.expectedMemoryGiB }
        : undefined,
  },
});

test('sumReservedForNode sums expectedMemoryGiB for enabled manifests on the node', () => {
  const all = [
    mkManifest('a', { expectedMemoryGiB: 8 }),
    mkManifest('b', { expectedMemoryGiB: 16 }),
    mkManifest('c', { expectedMemoryGiB: 4, enabled: false }),
    mkManifest('d', { expectedMemoryGiB: 2, node: 'mac-mini' }),
  ];
  expect(sumReservedForNode(all, 'local')).toBe(24);
});

test('admission returns ok when within budget', () => {
  const input: AdmissionInput = {
    nodeName: 'local',
    nodeBudgetGiB: 36,
    livingManifests: [mkManifest('a', { expectedMemoryGiB: 8 })],
    incoming: mkManifest('b', { expectedMemoryGiB: 16 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.reservedAfter).toBe(24);
    expect(r.budget).toBe(36);
  }
});

test('admission returns over-budget when sum exceeds budget without force', () => {
  const input: AdmissionInput = {
    nodeName: 'local',
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest('a', { expectedMemoryGiB: 16 })],
    incoming: mkManifest('b', { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reservedAfter).toBe(24);
});

test('admission ok when force-admit set even if over budget', () => {
  const input: AdmissionInput = {
    nodeName: 'local',
    nodeBudgetGiB: 10,
    livingManifests: [],
    incoming: mkManifest('a', { expectedMemoryGiB: 30 }),
    forceAdmit: true,
  };
  expect(computeNodeBudget(input).ok).toBe(true);
});

test('estimateWorkloadMemoryGiB returns null for gateway workloads', () => {
  const m = mkManifest('a');
  m.spec.gateway = true;
  expect(estimateWorkloadMemoryGiB(m, { LLAMA_CPP_MODELS: '/nonexistent' } as any)).toBe(null);
});

test('estimateWorkloadMemoryGiB returns null when file is missing', () => {
  expect(
    estimateWorkloadMemoryGiB(mkManifest('a'), { LLAMA_CPP_MODELS: '/nonexistent' } as any),
  ).toBe(null);
});
