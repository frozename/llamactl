import { afterAll, describe, expect, test } from 'bun:test';
import { ENGINES } from '../../src/engines/index.js';
import { gracefulShutdown } from '../../src/engines/lifecycle.js';
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

  test('validateSpec rejects non-loopback endpoint host', () => {
    const bad = { ...baseSpec, endpoint: { host: 'example.com', port: 8094 } };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/loopback|0\.0\.0\.0/);
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

  test('buildBootCommand prefers LLAMACTL_MODELS_DIR over LLAMA_CPP_MODELS', () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMACTL_MODELS_DIR: '/neutral/models',
      LLAMA_CPP_MODELS: '/legacy/models',
    } as any);
    expect(built.args).toContain('/neutral/models');
    expect(built.args).not.toContain('/legacy/models');
  });

  test('buildBootCommand rejects hosted model rel escapes', () => {
    const bad = {
      ...baseSpec,
      hostedModels: [{ rel: '../../escape' }],
    };
    expect(() => ENGINES.omlx.buildBootCommand(bad, { LLAMA_CPP_MODELS: '/tmp/models' } as any)).toThrow(
      /escapes models dir/,
    );
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

  test('probeReady times out cleanly without overrunning the deadline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const started = Date.now();
    const result = await ENGINES.omlx.probeReady({ host: '127.0.0.1', port: 54321 }, 300);
    const elapsed = Date.now() - started;
    globalThis.fetch = originalFetch;
    expect(result.ready).toBe(false);
    expect(elapsed).toBeLessThan(1200);
  });

  test('teardown returns quickly when the process exits on its own', async () => {
    const proc = Bun.spawn(['sh', '-lc', 'sleep 0.2'], { stderr: 'pipe', stdout: 'pipe' });
    const started = Date.now();
    await ENGINES.omlx.teardown(proc.pid!);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });

  test('teardown escalates to SIGKILL after grace expires', async () => {
    const proc = Bun.spawn(
      [
        'python3',
        '-c',
        'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)',
      ],
      { stderr: 'pipe', stdout: 'pipe' },
    );
    const started = Date.now();
    await gracefulShutdown(proc.pid!, 250);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(() => process.kill(proc.pid!, 0)).toThrow();
  });

  afterAll(() => {
    try { rmSync(goodBinary, { force: true }); } catch {}
  });
});
