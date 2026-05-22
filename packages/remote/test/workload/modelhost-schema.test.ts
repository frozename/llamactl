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

  test('accepts engine=llamacpp (registry-wired engine)', () => {
    const llamacppManifest = {
      ...valid,
      spec: {
        ...valid.spec,
        engine: 'llamacpp',
        binary: '/usr/local/bin/llama-server',
        hostedModels: [{ rel: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf' }],
      },
    };
    const result = ModelHostManifestSchema.safeParse(llamacppManifest);
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

  test('accepts spec.env with string values', () => {
    const manifest = { ...valid, spec: { ...valid.spec, env: { FOO: 'bar', MLX_METAL_MAX_INFLIGHT_PER_STREAM: '1' } } };
    const result = ModelHostManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec.env).toEqual({ FOO: 'bar', MLX_METAL_MAX_INFLIGHT_PER_STREAM: '1' });
    }
  });

  test('rejects spec.env with non-string values', () => {
    const bad = { ...valid, spec: { ...valid.spec, env: { FOO: 123 } } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('accepts manifest without spec.env (back-compat)', () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec.env).toBeUndefined();
    }
  });

  test('accepts optional priority in 0-100 range', () => {
    const result = ModelHostManifestSchema.safeParse({ ...valid, spec: { ...valid.spec, priority: 80 } });
    expect(result.success).toBe(true);
  });

  test('rejects priority above 100', () => {
    const result = ModelHostManifestSchema.safeParse({ ...valid, spec: { ...valid.spec, priority: 101 } });
    expect(result.success).toBe(false);
  });

  test('rejects priority below 0', () => {
    const result = ModelHostManifestSchema.safeParse({ ...valid, spec: { ...valid.spec, priority: -1 } });
    expect(result.success).toBe(false);
  });

  test('omitting priority leaves it undefined (no forced default)', () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.spec.priority).toBeUndefined();
  });
});
