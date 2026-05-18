import { afterAll, describe, expect, test } from 'bun:test';
import { ENGINES } from '../../src/engines/index.js';
import type { ModelHostSpecForEngine } from '../../src/engines/types.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeFakeBinary(): string {
  const dir = join(tmpdir(), `omlx-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'omlx');
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return path;
}

const goodBinary = makeFakeBinary();

const baseSpec: ModelHostSpecForEngine = {
  engine: 'omlx',
  binary: goodBinary,
  endpoint: { host: '127.0.0.1', port: 8094 },
  hostedModels: [{ rel: 'mlx-community/Qwen3-8B-MLX-4bit' }],
  resources: { expectedMemoryGiB: 12 },
  extraArgs: ['--max-concurrent-requests', '4'],
  timeoutSeconds: 60,
};

describe('omlx engine adapter', () => {
  test('validateSpec passes when binary exists', () => {
    const result = ENGINES.omlx.validateSpec(baseSpec);
    expect(result.ok).toBe(true);
  });

  test('validateSpec rejects missing binary file', () => {
    const bad = { ...baseSpec, binary: '/this/path/does/not/exist/omlx' };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary not found/);
  });

  test('validateSpec rejects empty binary string (no PATH fallback)', () => {
    const bad = { ...baseSpec, binary: '' };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary/i);
  });

  test('validateSpec rejects zero hosted models', () => {
    const bad = { ...baseSpec, hostedModels: [] };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
  });

  test('buildBootCommand uses serve subcommand + --model-dir + --port', () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/Volumes/WorkSSD/ai-models/llama.cpp/models',
    } as any);
    expect(built.binary).toBe(goodBinary);
    expect(built.args[0]).toBe('serve');
    expect(built.args).toContain('--model-dir');
    expect(built.args).toContain('/Volumes/WorkSSD/ai-models/llama.cpp/models');
    expect(built.args).toContain('--port');
    expect(built.args).toContain('8094');
    expect(built.args).toContain('--host');
    expect(built.args).toContain('127.0.0.1');
  });

  test('buildBootCommand passes --max-model-memory when resources set', () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, { LLAMA_CPP_MODELS: '/tmp' } as any);
    expect(built.args).toContain('--max-model-memory');
    expect(built.args).toContain('12GB');
  });

  test('buildBootCommand appends extraArgs verbatim', () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, { LLAMA_CPP_MODELS: '/tmp' } as any);
    expect(built.args).toContain('--max-concurrent-requests');
    expect(built.args).toContain('4');
  });

  test('probeReady returns matching modelIds when /v1/models contains the rel basename', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'Qwen3-8B-MLX-4bit', object: 'model' }],
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const result = await ENGINES.omlx.probeReady(
      { host: '127.0.0.1', port: 54321 },
      3000,
    );
    globalThis.fetch = originalFetch;
    expect(result.ready).toBe(true);
    expect(result.modelIds).toContain('Qwen3-8B-MLX-4bit');
  });

  test('probeReady returns ready:false on timeout', async () => {
    const result = await ENGINES.omlx.probeReady(
      { host: '127.0.0.1', port: 1 },
      500,
    );
    expect(result.ready).toBe(false);
  });

  afterAll(() => {
    try { rmSync(goodBinary, { force: true }); } catch {}
  });
});
