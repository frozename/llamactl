import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiProxy } from '../src/index.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'llamactl-openai-proxy-core-'));
  return {
    env: { LOCAL_AI_RUNTIME_DIR: dir } as any,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('routes chat completions to a ModelHost by rel alias', async () => {
  const t = tempEnv();
  try {
    const workload = join(t.dir, 'workloads', 'mlx-host');
    mkdirSync(workload, { recursive: true });
    writeFileSync(join(workload, 'modelhost.pid'), `${process.pid}\n`);
    writeFileSync(
      join(workload, 'modelhost.state'),
      JSON.stringify({
        kind: 'ModelHost',
        engine: 'omlx',
        pid: process.pid,
        host: '127.0.0.1',
        port: 8123,
        modelAliases: ['mlx-community/Qwen3-8B-MLX-4bit', 'Qwen3-8B-MLX-4bit'],
        startedAt: new Date().toISOString(),
      }),
    );

    const calls: Array<{ url: string; body: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : null });
      return Response.json({ echoed: { url } });
    }) as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mlx-community/Qwen3-8B-MLX-4bit',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8123/v1/chat/completions');
    expect(calls[0]!.body).toContain('"model":"mlx-community/Qwen3-8B-MLX-4bit"');
  } finally {
    t.cleanup();
  }
});

test('routes chat completions to a ModelHost by basename alias', async () => {
  const t = tempEnv();
  try {
    const workload = join(t.dir, 'workloads', 'mlx-host');
    mkdirSync(workload, { recursive: true });
    writeFileSync(join(workload, 'modelhost.pid'), `${process.pid}\n`);
    writeFileSync(
      join(workload, 'modelhost.state'),
      JSON.stringify({
        kind: 'ModelHost',
        engine: 'omlx',
        pid: process.pid,
        host: '127.0.0.1',
        port: 8124,
        modelAliases: ['mlx-community/Qwen3-8B-MLX-4bit', 'Qwen3-8B-MLX-4bit'],
        startedAt: new Date().toISOString(),
      }),
    );

    const calls: Array<{ url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'Qwen3-8B-MLX-4bit',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8124/v1/chat/completions');
  } finally {
    t.cleanup();
  }
});

test('listOpenAIModels differentiates host and agent ownership', () => {
  const t = tempEnv();
  try {
    const run = join(t.dir, 'workloads', 'run');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'llama-server.pid'), `${process.pid}\n`);
    writeFileSync(
      join(run, 'llama-server.state'),
      JSON.stringify({
        rel: 'org/model.gguf',
        extraArgs: [],
        host: '127.0.0.1',
        port: 8111,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );

    const host = join(t.dir, 'workloads', 'host');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, 'modelhost.pid'), `${process.pid}\n`);
    writeFileSync(
      join(host, 'modelhost.state'),
      JSON.stringify({
        kind: 'ModelHost',
        engine: 'omlx',
        pid: process.pid,
        host: '127.0.0.1',
        port: 8112,
        modelAliases: ['mlx-community/Qwen3-8B-MLX-4bit'],
        startedAt: new Date().toISOString(),
      }),
    );

    const models = openaiProxy.listOpenAIModels(t.env);
    expect(models.data).toHaveLength(2);
    expect(models.data.find((entry) => entry.id === 'org/model.gguf')?.owned_by).toBe('llamactl-agent');
    expect(models.data.find((entry) => entry.id === 'mlx-community/Qwen3-8B-MLX-4bit')?.owned_by).toBe(
      'llamactl-host',
    );
  } finally {
    t.cleanup();
  }
});

test('basename alias collision prefers ModelRun over ModelHost and warns', () => {
  const t = tempEnv();
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const run = join(t.dir, 'workloads', 'run');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'llama-server.pid'), `${process.pid}\n`);
    writeFileSync(
      join(run, 'llama-server.state'),
      JSON.stringify({
        rel: 'Qwen3-8B-MLX-4bit',
        extraArgs: [],
        host: '127.0.0.1',
        port: 8113,
        binary: '/x/llama-server',
        pid: process.pid,
        startedAt: '2026-05-19T00:00:00Z',
        tunedProfile: null,
      }),
    );

    const host = join(t.dir, 'workloads', 'host');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, 'modelhost.pid'), `${process.pid}\n`);
    writeFileSync(
      join(host, 'modelhost.state'),
      JSON.stringify({
        kind: 'ModelHost',
        engine: 'omlx',
        pid: process.pid,
        host: '127.0.0.1',
        port: 8114,
        modelAliases: ['Qwen3-8B-MLX-4bit'],
        startedAt: '2026-05-19T00:00:00Z',
      }),
    );

    const models = openaiProxy.listOpenAIModels(t.env);
    expect(models.data).toHaveLength(1);
    expect(models.data[0]?.owned_by).toBe('llamactl-agent');
    expect(warnSpy).toHaveBeenCalledWith(
      "[openaiProxy] route-map collision on model='Qwen3-8B-MLX-4bit': keeping ModelRun:run, ignoring ModelHost:host",
    );
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

test('same-kind alias collision keeps the alphabetically earlier workload', async () => {
  const t = tempEnv();
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const alpha = join(t.dir, 'workloads', 'alpha');
    mkdirSync(alpha, { recursive: true });
    writeFileSync(join(alpha, 'modelhost.pid'), `${process.pid}\n`);
    writeFileSync(
      join(alpha, 'modelhost.state'),
      JSON.stringify({
        kind: 'ModelHost',
        engine: 'omlx',
        pid: process.pid,
        host: '127.0.0.1',
        port: 8115,
        modelAliases: ['Qwen3-8B-MLX-4bit'],
        startedAt: '2026-05-19T00:00:00Z',
      }),
    );

    const beta = join(t.dir, 'workloads', 'beta');
    mkdirSync(beta, { recursive: true });
    writeFileSync(join(beta, 'modelhost.pid'), `${process.pid}\n`);
    writeFileSync(
      join(beta, 'modelhost.state'),
      JSON.stringify({
        kind: 'ModelHost',
        engine: 'omlx',
        pid: process.pid,
        host: '127.0.0.1',
        port: 8116,
        modelAliases: ['Qwen3-8B-MLX-4bit'],
        startedAt: '2026-05-19T00:00:00Z',
      }),
    );

    const calls: Array<{ url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'Qwen3-8B-MLX-4bit',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8115/v1/chat/completions');
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});
