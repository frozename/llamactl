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
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
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
    globalThis.fetch = (async (input: Request | URL | string) => {
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

test('forwards chat completions with the current request shape intact', async () => {
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
        port: 8125,
        modelAliases: ['mlx-community/Qwen3-8B-MLX-4bit'],
        startedAt: new Date('2026-05-23T00:00:00Z').toISOString(),
      }),
    );

    let observedRequest: Request | null = null;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      observedRequest =
        typeof input === 'string'
          ? new Request(input, init)
          : input instanceof URL
            ? new Request(input.toString(), init)
            : new Request(input, init);
      return Response.json(
        {
          ok: true,
          url: observedRequest.url,
          method: observedRequest.method,
          headers: [...observedRequest.headers.entries()].sort(),
          body: await observedRequest.clone().text(),
        },
        {
          headers: { 'x-upstream': 'llama-server' },
        },
      );
    }) as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions?foo=bar', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          connection: 'keep-alive',
          'content-length': '999',
          'content-type': 'application/json',
          host: 'localhost',
          'x-test': 'preserved',
        },
        body: JSON.stringify({
          model: 'mlx-community/Qwen3-8B-MLX-4bit',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "body": "{\"model\":\"mlx-community/Qwen3-8B-MLX-4bit\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
        "headers": [
          [
            "content-type",
            "application/json",
          ],
          [
            "x-test",
            "preserved",
          ],
        ],
        "method": "POST",
        "ok": true,
        "url": "http://127.0.0.1:8125/v1/chat/completions?foo=bar",
      }
    `);
    expect(res.headers.get('x-upstream')).toBe('llama-server');
    expect(observedRequest).not.toBeNull();
    expect(observedRequest!.headers.get('authorization')).toBeNull();
    expect(observedRequest!.headers.get('connection')).toBeNull();
    expect(observedRequest!.headers.get('content-length')).toBeNull();
    expect(observedRequest!.headers.get('host')).toBeNull();
  } finally {
    t.cleanup();
  }
});

test('/v1/messages translates into /v1/chat/completions and forwards upstream', async () => {
  const t = tempEnv();
  try {
    const calls: Array<{ url: string; body: string | null }> = [];
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : null });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/messages?foo=bar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-7-sonnet',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 64,
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/v1/chat/completions?foo=bar');
    expect(calls[0]!.body).toBe(
      JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
      }),
    );
  } finally {
    t.cleanup();
  }
});

test('/v1/messages translator errors return anthropic_translation_error with status 400', async () => {
  const t = tempEnv();
  try {
    globalThis.fetch = (async () => {
      throw new Error('upstream should not be called');
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-7-sonnet',
          messages: [
            {
              role: 'user',
              content: [{ type: 'video', src: 'x' }],
            },
          ],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        message: 'unsupported content block type: video',
        type: 'anthropic_translation_error',
      },
    });
  } finally {
    t.cleanup();
  }
});

test('route map cache build count stays stable across identical requests', async () => {
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
        port: 8126,
        modelAliases: ['mlx-community/Qwen3-8B-MLX-4bit'],
        startedAt: new Date().toISOString(),
      }),
    );

    const seen: string[] = [];
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seen.push(url);
      return Response.json({ ok: true });
    }) as typeof fetch;

    const before = openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests();
    for (let i = 0; i < 5; i += 1) {
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
    }
    expect(seen).toHaveLength(5);
    expect(openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests()).toBe(before + 1);
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
    globalThis.fetch = (async (input: Request | URL | string) => {
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
