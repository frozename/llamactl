import { describe, expect, test } from 'bun:test';
import { ENGINES } from '../../src/engines/index.js';
import { formatHostForUrl, gracefulShutdown } from '../../src/engines/lifecycle.js';
import type { ModelHostSpecForEngine } from '../../src/engines/types.js';

const baseSpec: ModelHostSpecForEngine = {
  engine: 'llamacpp',
  binary: '/some/path/llama-server',
  endpoint: { host: '127.0.0.1', port: 8090 },
  hostedModels: [{ rel: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf' }],
  resources: { expectedMemoryGiB: 5 },
  extraArgs: ['--jinja'],
  timeoutSeconds: 60,
};

describe('llamacpp engine adapter', () => {
  test('validateSpec passes a well-formed spec', () => {
    const result = ENGINES.llamacpp.validateSpec(baseSpec);
    expect(result.ok).toBe(true);
  });

  test('validateSpec rejects missing binary', () => {
    const bad = { ...baseSpec, binary: '' };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary/i);
  });

  test('validateSpec rejects zero hosted models', () => {
    const bad = { ...baseSpec, hostedModels: [] };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/hostedModels/);
  });

  test('validateSpec rejects non-loopback endpoint host', () => {
    const bad = { ...baseSpec, endpoint: { host: 'example.com', port: 8090 } };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/loopback|0\.0\.0\.0/);
  });

  test('buildBootCommand includes --port and the hosted model rel', () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/tmp/models',
    } as any);
    expect(built.binary).toBe('/some/path/llama-server');
    expect(built.args).toContain('--port');
    expect(built.args).toContain('8090');
    const joined = built.args.join(' ');
    expect(joined).toMatch(/granite-4\.1-3b/);
  });

  test('buildBootCommand appends extraArgs verbatim after engine defaults', () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/tmp/models',
    } as any);
    expect(built.args).toContain('--jinja');
    const portIdx = built.args.indexOf('--port');
    const jinjaIdx = built.args.indexOf('--jinja');
    expect(jinjaIdx).toBeGreaterThan(portIdx);
  });

  test('buildBootCommand rejects hosted model rel escapes', () => {
    const bad = {
      ...baseSpec,
      hostedModels: [{ rel: '../escape.gguf' }],
    };
    expect(() => ENGINES.llamacpp.buildBootCommand(bad, { LLAMA_CPP_MODELS: '/tmp/models' } as any)).toThrow(
      /escapes models dir/,
    );
  });

  test('probeReady resolves only when /v1/models advertises a model id', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'granite-4.1-3b-Q8_0.gguf' }] }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const result = await ENGINES.llamacpp.probeReady({ host: '127.0.0.1', port: 12345 }, 1000);
    globalThis.fetch = originalFetch;
    expect(result.ready).toBe(true);
    expect(result.modelIds).toContain('granite-4.1-3b-Q8_0.gguf');
  });

  test('formatHostForUrl brackets IPv6 literals', () => {
    expect(formatHostForUrl('::1')).toBe('[::1]');
    expect(formatHostForUrl('127.0.0.1')).toBe('127.0.0.1');
  });

  test('probeReady returns ready:false without overrunning timeout', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Request | URL | string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const started = Date.now();
    const result = await ENGINES.llamacpp.probeReady({ host: '127.0.0.1', port: 12345 }, 300);
    const elapsed = Date.now() - started;
    globalThis.fetch = originalFetch;
    expect(result.ready).toBe(false);
    expect(elapsed).toBeLessThan(1200);
  });

  test('teardown returns quickly when the process exits on its own', async () => {
    const proc = Bun.spawn(['sh', '-lc', 'sleep 0.2'], { stderr: 'pipe', stdout: 'pipe' });
    const started = Date.now();
    await ENGINES.llamacpp.teardown(proc.pid!);
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
});
