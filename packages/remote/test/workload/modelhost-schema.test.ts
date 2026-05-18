import { describe, expect, test } from 'bun:test';
import { ModelHostManifestSchema } from '../../src/workload/modelhost-schema.js';

const valid = {
  apiVersion: 'llamactl/v1',
  kind: 'ModelHost',
  metadata: { name: 'mlx-host-local' },
  spec: {
    engine: 'omlx',
    node: 'local',
    enabled: true,
    binary: '/Volumes/WorkSSD/src/omlx/.venv/bin/omlx',
    resources: { expectedMemoryGiB: 12 },
    endpoint: { host: '127.0.0.1', port: 8094 },
    hostedModels: [{ rel: 'mlx-community/Qwen3-8B-MLX-4bit' }],
    extraArgs: ['--max-concurrent-requests', '4'],
    restartPolicy: 'Always',
    timeoutSeconds: 60,
  },
};

describe('ModelHostManifestSchema', () => {
  test('accepts a valid manifest', () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test('rejects engine string outside the enum', () => {
    const bad = { ...valid, spec: { ...valid.spec, engine: 'vllm-mlx' } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects missing endpoint.port (no default)', () => {
    const bad = { ...valid, spec: { ...valid.spec, endpoint: { host: '127.0.0.1' } } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects empty hostedModels (Sub A min length 1)', () => {
    const bad = { ...valid, spec: { ...valid.spec, hostedModels: [] } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects hostedModels length > 1 (Sub A max length 1)', () => {
    const bad = {
      ...valid,
      spec: {
        ...valid.spec,
        hostedModels: [
          { rel: 'mlx-community/A' },
          { rel: 'mlx-community/B' },
        ],
      },
    };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects manifest with stray `target` field (ModelRun-only)', () => {
    const bad = {
      ...valid,
      spec: { ...valid.spec, target: { kind: 'rel', value: 'foo' } },
    };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects manifest with stray `workers` field (ModelRun-only)', () => {
    const bad = { ...valid, spec: { ...valid.spec, workers: [] } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects empty binary string (no PATH fallback for ModelHost)', () => {
    const bad = { ...valid, spec: { ...valid.spec, binary: '' } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects kind other than ModelHost', () => {
    const bad = { ...valid, kind: 'ModelRun' };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
