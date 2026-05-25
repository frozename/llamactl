import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiProxy } from '../../src/index.js';
import { ResponseCacheRegistry, canonicalRequestSha, openResponseCacheStorage } from '../../src/responsecache/index.js';

interface TempRuntime {
  root: string;
  env: { LOCAL_AI_RUNTIME_DIR: string };
  cleanup: () => void;
}

interface TestUpstream {
  baseUrl: string;
  calls: number;
  close: () => Promise<void>;
}

function makeTempRuntime(): TempRuntime {
  const root = mkdtempSync(join(tmpdir(), 'llamactl-responsecache-proxy-'));
  return {
    root,
    env: { LOCAL_AI_RUNTIME_DIR: root },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeModelRunWorkload(
  runtimeRoot: string,
  workload: string,
  port: number,
  rel = 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
): void {
  const dir = join(runtimeRoot, 'workloads', workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'llama-server.pid'), `${process.pid}\n`);
  writeFileSync(
    join(dir, 'llama-server.state'),
    JSON.stringify({
      rel,
      extraArgs: [],
      host: '127.0.0.1',
      port,
      binary: '/x/llama-server',
      pid: process.pid,
      startedAt: '2026-05-24T00:00:00.000Z',
      tunedProfile: null,
    }),
  );
}

async function startUpstream(mode: 'json' | 'sse' | 'json_error' | 'sse_partial'): Promise<TestUpstream> {
  let calls = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      calls += 1;
      const body = await readBody(req);
      if (mode === 'sse') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ id: calls, echoed: body })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (mode === 'sse_partial') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ id: calls, echoed: body })}\n\n`);
        return;
      }
      if (mode === 'json_error') {
        return json(res, 200, {
          error: {
            message: 'upstream failure',
            type: 'upstream_error',
          },
        });
      }
      return json(res, 200, {
        id: `chatcmpl-${calls}`,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: [{ type: 'text', text: `hit-${calls}` }] } }],
        echoed: body,
      });
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind upstream');
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    get calls() {
      return calls;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const originalBudget = process.env.LLAMACTL_RESPONSE_CACHE_BUDGET_MB;
const originalMaxEntry = process.env.LLAMACTL_RESPONSE_CACHE_MAX_ENTRY_MB;
const originalTtlHours = process.env.LLAMACTL_RESPONSE_CACHE_TTL_HOURS;

afterEach(() => {
  if (originalBudget === undefined) delete process.env.LLAMACTL_RESPONSE_CACHE_BUDGET_MB;
  else process.env.LLAMACTL_RESPONSE_CACHE_BUDGET_MB = originalBudget;
  if (originalMaxEntry === undefined) delete process.env.LLAMACTL_RESPONSE_CACHE_MAX_ENTRY_MB;
  else process.env.LLAMACTL_RESPONSE_CACHE_MAX_ENTRY_MB = originalMaxEntry;
  if (originalTtlHours === undefined) delete process.env.LLAMACTL_RESPONSE_CACHE_TTL_HOURS;
  else process.env.LLAMACTL_RESPONSE_CACHE_TTL_HOURS = originalTtlHours;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

test('cold miss saves and warm hit serves cached JSON without upstream call', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream('json');
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'cached json' }],
      temperature: 0,
    });

    const first = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    expect(first.status).toBe(200);
    expect(upstream.calls).toBe(1);

    const second = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    const secondJson = await second.json() as { id: string };
    expect(second.status).toBe(200);
    expect(secondJson.id).toBe('chatcmpl-1');
    expect(upstream.calls).toBe(1);
    expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env as any)).toBe(1);

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const entry = registry.findBySha(canonicalRequestSha(body));
    expect(entry).not.toBeNull();
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('SSE responses are cached and replayed on warm hit', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream('sse');
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'cached sse' }],
      stream: true,
      temperature: 0,
    });

    const first = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    const firstText = await first.text();
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    expect(firstText).toContain('[DONE]');
    expect(upstream.calls).toBe(1);

    const second = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    const secondText = await second.text();
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toContain('text/event-stream');
    expect(secondText).toBe(firstText);
    expect(upstream.calls).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('non-deterministic request bypasses response cache', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream('json');
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'sampled' }],
      temperature: 0.7,
    });

    const first = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    const second = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(upstream.calls).toBe(2);

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    expect(registry.findBySha(canonicalRequestSha(body))).toBeNull();
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('eviction trims entries under configured response-cache budget', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream('json');
  process.env.LLAMACTL_RESPONSE_CACHE_BUDGET_MB = '1';
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now() - 20_000_000;
    const blobA = new Uint8Array(450_000);
    const blobB = new Uint8Array(420_000);
    registry.insert({
      sha: 'old-a',
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      contentType: 'application/json',
      statusCode: 200,
      responseBody: blobA,
      requestBodyBytes: 120_000,
      responseBodyBytes: blobA.byteLength,
      createdAt: now,
      lastUsed: now,
      hits: 0,
    });
    registry.insert({
      sha: 'old-b',
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      contentType: 'application/json',
      statusCode: 200,
      responseBody: blobB,
      requestBodyBytes: 100_000,
      responseBodyBytes: blobB.byteLength,
      createdAt: now,
      lastUsed: now,
      hits: 0,
    });
    storage.close();

    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'evict if needed' }],
      temperature: 0,
    });
    const response = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    expect(response.status).toBe(200);

    const afterStorage = openResponseCacheStorage(runtime.root);
    const afterRegistry = new ResponseCacheRegistry(afterStorage);
    const entries = afterRegistry.listForModel('Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf');
    const totalBytes = entries.reduce((sum, entry) => sum + entry.requestBodyBytes + entry.responseBodyBytes, 0);
    expect(totalBytes).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(afterRegistry.findBySha(canonicalRequestSha(body))).not.toBeNull();
    expect(openaiProxy.__getOpenAIProxyResponseCacheEvictTotalForTests(runtime.env as any)).toBeGreaterThan(0);
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('error-envelope JSON responses are not cached and emit skip log', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream('json_error');
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'error envelope' }],
      temperature: 0,
    });
    const response = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('"event":"response_cache_skip_error_envelope"'))).toBe(true);

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    expect(registry.findBySha(canonicalRequestSha(body))).toBeNull();
    storage.close();
  } finally {
    warnSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test('partial SSE responses are not cached and emit skip log', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream('sse_partial');
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'partial sse' }],
      stream: true,
      temperature: 0,
    });
    const response = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('"event":"response_cache_skip_partial_sse"'))).toBe(true);

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    expect(registry.findBySha(canonicalRequestSha(body))).toBeNull();
    storage.close();
  } finally {
    warnSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test('TTL-expired response-cache entries are treated as misses and deleted', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream('json_error');
  process.env.LLAMACTL_RESPONSE_CACHE_TTL_HOURS = '24';
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'ttl expired' }],
      temperature: 0,
    });
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now();
    registry.insert({
      sha: canonicalRequestSha(body),
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      contentType: 'application/json',
      statusCode: 200,
      responseBody: new Uint8Array(Buffer.from('{"ok":true}', 'utf8')),
      requestBodyBytes: Buffer.byteLength(body, 'utf8'),
      responseBodyBytes: Buffer.byteLength('{"ok":true}', 'utf8'),
      createdAt: now - 25 * 60 * 60 * 1000,
      lastUsed: now - 25 * 60 * 60 * 1000,
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env as any)).toBe(0);
    expect(openaiProxy.__getOpenAIProxyResponseCacheMissTotalForTests(runtime.env as any)).toBe(1);

    const afterStorage = openResponseCacheStorage(runtime.root);
    const afterRegistry = new ResponseCacheRegistry(afterStorage);
    expect(afterRegistry.findBySha(canonicalRequestSha(body))).toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('fresh response-cache entries are served as hits before TTL expiry', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream('json');
  process.env.LLAMACTL_RESPONSE_CACHE_TTL_HOURS = '24';
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'ttl fresh' }],
      temperature: 0,
    });
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now();
    registry.insert({
      sha: canonicalRequestSha(body),
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      contentType: 'application/json',
      statusCode: 200,
      responseBody: new Uint8Array(Buffer.from('{"id":"cached"}', 'utf8')),
      requestBodyBytes: Buffer.byteLength(body, 'utf8'),
      responseBodyBytes: Buffer.byteLength('{"id":"cached"}', 'utf8'),
      createdAt: now - 60 * 60 * 1000,
      lastUsed: now - 60 * 60 * 1000,
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      runtime.env as any,
    );
    const payload = await response.json() as { id?: string };
    expect(response.status).toBe(200);
    expect(payload.id).toBe('cached');
    expect(upstream.calls).toBe(0);
    expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env as any)).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});
