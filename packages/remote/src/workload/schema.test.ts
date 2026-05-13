import { expect, test } from 'bun:test';
import { ModelRunSchema } from './schema.js';
import { NodeRunSchema } from './noderun-schema.js';

test('ModelRun parses spec.enabled defaulting to true', () => {
  const m = ModelRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'a' },
    spec: { node: 'local', target: { kind: 'rel', value: 'm.gguf' } },
  });
  expect(m.spec.enabled).toBe(true);
});

test('ModelRun accepts spec.enabled=false', () => {
  const m = ModelRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'a' },
    spec: {
      node: 'local',
      target: { kind: 'rel', value: 'm.gguf' },
      enabled: false,
    },
  });
  expect(m.spec.enabled).toBe(false);
});

test('ModelRun parses spec.resources.expectedMemoryGiB', () => {
  const m = ModelRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'a' },
    spec: {
      node: 'local',
      target: { kind: 'rel', value: 'm.gguf' },
      resources: { expectedMemoryGiB: 8.5 },
    },
  });
  expect(m.spec.resources?.expectedMemoryGiB).toBe(8.5);
});

test('ModelRun parses metadata.annotations defaulting to {}', () => {
  const m = ModelRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'a', annotations: { 'llamactl.io/evict': 'old' } },
    spec: { node: 'local', target: { kind: 'rel', value: 'm.gguf' } },
  });
  expect(m.metadata.annotations).toEqual({ 'llamactl.io/evict': 'old' });
});

test('NodeRun parses spec.budget.memoryGiB', () => {
  const n = NodeRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'NodeRun',
    metadata: { name: 'a' },
    spec: {
      node: 'local',
      budget: { memoryGiB: 16 },
    },
  });
  expect(n.spec.budget?.memoryGiB).toBe(16);
});
