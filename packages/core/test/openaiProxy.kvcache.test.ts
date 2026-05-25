import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openaiProxy } from '../src/index.js';
import { isRouteKvEligible } from '../src/openaiProxy.js';
import {
  EXT_FLAG_TOOL_MAP,
  KvRegistry,
  openKvStorage,
  readTrailer,
  readWorkloadEpoch,
  writeTrailer,
  type KvEntry,
} from '../src/kvstore/index.js';

interface TempRuntime {
  root: string;
  env: { LOCAL_AI_RUNTIME_DIR: string };
  cleanup: () => void;
}

interface TestUpstream {
  baseUrl: string;
  events: string[];
  close: () => Promise<void>;
}

function makeTempRuntime(): TempRuntime {
  const root = mkdtempSync(join(tmpdir(), 'llamactl-openai-proxy-kv-'));
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

function writeModelHostWorkload(
  runtimeRoot: string,
  workload: string,
  port: number,
  engine: 'omlx' | 'llamacpp',
  modelAliases: string[] = ['Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf'],
): void {
  const dir = join(runtimeRoot, 'workloads', workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'modelhost.pid'), `${process.pid}\n`);
  writeFileSync(
    join(dir, 'modelhost.state'),
    JSON.stringify({
      kind: 'ModelHost',
      engine,
      pid: process.pid,
      host: '127.0.0.1',
      port,
      modelAliases,
      startedAt: '2026-05-24T00:00:00.000Z',
    }),
  );
}

async function startUpstream(opts: {
  slotBaseDir: string;
  saveMode?: 'ok' | 'invalid';
  restoreMode?: 'ok' | 'http_error';
  supportsRequestHandle?: boolean;
  restoreEpoch?: string | null;
  chatMode?: 'json' | 'sse';
  firstJsonToken?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}): Promise<TestUpstream> {
  const events: string[] = [];
  const saveMode = opts.saveMode ?? 'ok';
  const restoreMode = opts.restoreMode ?? 'ok';
  const supportsRequestHandle = opts.supportsRequestHandle ?? false;
  const restoreEpoch = opts.restoreEpoch ?? null;
  const chatMode = opts.chatMode ?? 'json';
  const firstJsonToken = opts.firstJsonToken ?? 'Hello';
  const toolCalls = opts.toolCalls ?? [];
  const slotBaseDir = opts.slotBaseDir;
  const baseUrl = 'http://127.0.0.1:19502';
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET');
    const parsed = new URL(url);
    if (method === 'POST' && parsed.pathname.startsWith('/slots/')) {
      const action = parsed.searchParams.get('action');
      const body = typeof init?.body === 'string' ? init.body : '';
      const filename = body ? JSON.parse(body).filename : '';
      const absPath = join(slotBaseDir, filename);
      if (action === 'restore') {
        events.push('slot-restore');
        if (restoreMode === 'http_error') return Response.json({ error: 'restore-fail' }, { status: 500 });
        if (!existsSync(absPath)) return Response.json({ error: 'missing' }, { status: 404 });
        return Response.json({ n_restored: 123, restore_epoch: restoreEpoch });
      }
      if (action === 'save') {
        events.push('slot-save');
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, 'slot');
        if (saveMode === 'invalid') return Response.json({ ok: true });
        return Response.json({ n_saved: 321 });
      }
      return Response.json({ error: 'bad action' }, { status: 400 });
    }
    if (method === 'POST' && parsed.pathname === '/v1/chat/completions') {
      events.push('chat-forward');
      const body = typeof init?.body === 'string' ? init.body : '';
      if (chatMode === 'sse') {
        return new Response(`data: ${JSON.stringify({ id: 'evt', body })}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return Response.json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `${firstJsonToken} world` }],
              ...(toolCalls.length > 0
                ? {
                    tool_calls: toolCalls.map((call) => ({
                      id: call.id,
                      type: 'function',
                      function: {
                        name: call.name,
                        arguments: call.arguments,
                      },
                    })),
                  }
                : {}),
            },
            finish_reason: 'stop',
          },
        ],
        echoed: body,
      });
    }
    if (method === 'GET' && parsed.pathname === '/props') {
      return Response.json({
        slots: {
          api_version: supportsRequestHandle ? 2 : 1,
          supports_request_handle: supportsRequestHandle,
        },
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  return {
    baseUrl,
    events,
    close: async () => {},
  };
}

function shaForBody(body: string): string {
  return createHash('sha1').update(body).digest('hex');
}

function entryTemplate(overrides: Partial<KvEntry>): KvEntry {
  return {
    sha: 'sha',
    workload: 'wl-a',
    upstreamSlotFile: '/tmp/file.kvslot',
    quantBits: 8,
    tokens: 128,
    ctxSize: 32768,
    hits: 0,
    createdAt: 1716576000000,
    lastUsed: 1716576000000,
    payloadBytes: 1024,
    textBytes: 1024,
    reason: 'cold',
    prefixByteLength: 128,
    workloadEpoch: 'epoch',
    quarantined: 0,
    state: 'idle',
    firstResponseToken: null,
    extFlags: 0,
    ...overrides,
  };
}

const originalBudget = process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBudget === undefined) delete process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB;
  else process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB = originalBudget;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

test('cold miss saves a new idle kv entry', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));

    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'hello' }],
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

    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    const entry = registry.get(shaForBody(body));
    expect(entry).not.toBeNull();
    expect(entry?.state).toBe('idle');
    expect(entry?.workload).toBe('wl-a');
    expect(entry?.firstResponseToken).toBe('Hello world');
    storage.close();

    expect(upstream.events).toEqual(['chat-forward', 'slot-save']);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('cold miss saves a new idle kv entry for ModelHost omxl', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelHostWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10), 'omlx', [
      'mlx-community/Qwen3-8B-MLX-4bit',
    ]);
    writeFileSync(
      join(runtime.root, 'workloads', 'wl-a', 'modelhost.state'),
      JSON.stringify({
        kind: 'ModelHost',
        engine: 'omlx',
        pid: process.pid,
        host: '127.0.0.1',
        port: Number.parseInt(url.port, 10),
        modelAliases: ['mlx-community/Qwen3-8B-MLX-4bit'],
        startedAt: '2026-05-24T00:00:00.000Z',
        rel: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      }),
    );

    const body = JSON.stringify({
      model: 'mlx-community/Qwen3-8B-MLX-4bit',
      messages: [{ role: 'user', content: 'hello' }],
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

    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    const entry = registry.get(shaForBody(body));
    expect(entry).not.toBeNull();
    expect(entry?.state).toBe('idle');
    expect(entry?.workload).toBe('wl-a');
    storage.close();

    expect(upstream.events).toEqual(['chat-forward', 'slot-save']);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('kv eligibility admits ModelRun llamacpp and ModelHost omlx only', () => {
  expect(isRouteKvEligible({ kind: 'ModelRun', engine: 'llamacpp' })).toBe(true);
  expect(isRouteKvEligible({ kind: 'ModelHost', engine: 'omlx' })).toBe(true);
  expect(isRouteKvEligible({ kind: 'ModelHost', engine: 'llamacpp' })).toBe(false);
  expect(isRouteKvEligible({ kind: 'ModelRun', engine: 'omlx' })).toBe(false);
});

test('anthropic cold save writes trailer toolMap and ext_flags when upstream returns tool_calls', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({
    slotBaseDir,
    toolCalls: [
      {
        id: 'toolu_1',
        name: 'lookup_weather',
        arguments: '{\n  "city": "Sao Paulo",\n  "units": "c"\n}',
      },
    ],
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const anthropicBody = {
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Use a tool' }] }],
      max_tokens: 32,
    };
    const response = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(anthropicBody),
      }),
      runtime.env as any,
    );
    expect(response.status).toBe(200);

    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    const entries = registry.listAll();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect((entry.extFlags & EXT_FLAG_TOOL_MAP) !== 0).toBe(true);
    const trailer = readTrailer(entry.upstreamSlotFile);
    expect(trailer?.toolMap?.toolu_1).toBe(
      '{"id":"toolu_1","type":"function","function":{"name":"lookup_weather","arguments":"{\\n  \\"city\\": \\"Sao Paulo\\",\\n  \\"units\\": \\"c\\"\\n}"}}',
    );
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('warm hit restores slot before upstream forward', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'warm' }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      lastUsed: Date.now() - 10_000,
      createdAt: Date.now() - 10_000,
      firstResponseToken: 'Hello world',
    }));
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
    expect(upstream.events.indexOf('slot-restore')).toBeLessThan(upstream.events.indexOf('chat-forward'));
    expect(upstream.events).toEqual(['slot-restore', 'chat-forward']);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('proxy injects x_omlx_request_handle and x_omlx_restore_epoch after successful restore', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, supportsRequestHandle: true, restoreEpoch: 'abc' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'warm inject' }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    const responseJson = await response.json() as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? '{}') as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBe(sha);
    expect(echoed.x_omlx_restore_epoch).toBe('abc');
    expect(upstream.events).toEqual(['slot-restore', 'chat-forward']);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('proxy does not inject vendor fields when request-handle capability is unsupported', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, supportsRequestHandle: false, restoreEpoch: 'abc' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'warm unsupported' }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    const responseJson = await response.json() as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? '{}') as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBeUndefined();
    expect(echoed.x_omlx_restore_epoch).toBeUndefined();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('proxy does not inject vendor fields when restore fails', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({
    slotBaseDir,
    restoreMode: 'http_error',
    supportsRequestHandle: true,
    restoreEpoch: 'abc',
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'restore fail no inject' }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    const responseJson = await response.json() as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? '{}') as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBeUndefined();
    expect(echoed.x_omlx_restore_epoch).toBeUndefined();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('proxy does not inject vendor fields when restore_epoch is null', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, supportsRequestHandle: true, restoreEpoch: null });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'restore epoch null' }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    const responseJson = await response.json() as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? '{}') as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBeUndefined();
    expect(echoed.x_omlx_restore_epoch).toBeUndefined();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('proxy injects vendor fields at top-level only', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, supportsRequestHandle: true, restoreEpoch: 'abc' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'top-level only' }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    const responseJson = await response.json() as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? '{}') as {
      x_omlx_request_handle?: unknown;
      x_omlx_restore_epoch?: unknown;
      messages?: Array<{ x_omlx_request_handle?: unknown; x_omlx_restore_epoch?: unknown }>;
    };
    expect(echoed.x_omlx_request_handle).toBe(sha);
    expect(echoed.x_omlx_restore_epoch).toBe('abc');
    expect(Array.isArray(echoed.messages)).toBe(true);
    expect(echoed.messages?.[0]?.x_omlx_request_handle).toBeUndefined();
    expect(echoed.messages?.[0]?.x_omlx_restore_epoch).toBeUndefined();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('proxy injection overwrites user supplied vendor fields', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, supportsRequestHandle: true, restoreEpoch: 'abc' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'overwrite handle' }],
      x_omlx_request_handle: 'user-handle',
      x_omlx_restore_epoch: 'user-epoch',
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    const responseJson = await response.json() as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? '{}') as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBe(sha);
    expect(echoed.x_omlx_restore_epoch).toBe('abc');
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('warm-hit lease is released when response-cache buffering throws before kv persist', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  const nativeFetch = globalThis.fetch;
  const nativeArrayBuffer = Response.prototype.arrayBuffer;
  const arrayBufferSpy = spyOn(Response.prototype, 'arrayBuffer').mockImplementation(function (
    this: Response,
  ): Promise<ArrayBuffer> {
    if (this.headers.get('x-fail-buffer') === '1') {
      return Promise.reject(new Error('simulated arrayBuffer failure'));
    }
    return nativeArrayBuffer.call(this);
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (target.includes('/v1/chat/completions')) {
      const failing = new Response('{"id":"chatcmpl-throw"}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-fail-buffer': '1' },
      });
      return Promise.resolve(failing);
    }
    return nativeFetch(input, init);
  }) as typeof fetch);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'lease release on throw' }],
      temperature: 0,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
    storage.close();

    await expect(
      openaiProxy.proxyOpenAI(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
        runtime.env as any,
      ),
    ).rejects.toThrow('simulated arrayBuffer failure');

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)?.state).toBe('idle');
    afterStorage.close();
  } finally {
    arrayBufferSpy.mockRestore();
    fetchSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test('anthropic warm hit replays with trailer toolMap bytes and keeps warm path when sha matches', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const anthropicBody = {
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'tool call' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'lookup_weather',
              input: { city: 'Sao Paulo' },
            },
          ],
        },
      ],
      max_tokens: 16,
    };
    const translatedBody = JSON.stringify({
      model: anthropicBody.model,
      messages: [
        {
          role: 'assistant',
          content: 'tool call',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: {
                name: 'lookup_weather',
                arguments: '{"city":"Sao Paulo"}',
              },
            },
          ],
        },
      ],
      max_tokens: 16,
    });
    const sha = shaForBody(translatedBody);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(translatedBody, 'utf8'),
      prefixByteLength: Buffer.byteLength(translatedBody, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(translatedBody, 'utf8'),
      textBytes: Buffer.byteLength(translatedBody, 'utf8'),
      firstResponseToken: 'Hello world',
      extFlags: EXT_FLAG_TOOL_MAP,
    }));
    expect(
      writeTrailer(slotFile, {
        extFlags: EXT_FLAG_TOOL_MAP,
        toolMap: {
          toolu_1:
            '{"id":"toolu_1","type":"function","function":{"name":"lookup_weather","arguments":"{\\"city\\":\\"Sao Paulo\\"}"}}',
        },
      }),
    ).toEqual({ ok: true });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(anthropicBody),
      }),
      runtime.env as any,
    );
    expect(response.status).toBe(200);
    expect(upstream.events).toEqual(['slot-restore', 'chat-forward']);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('anthropic warm-hit trailer mismatch falls back to cold prefill and increments replay-mismatch counter', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const anthropicBody = {
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'tool call' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'lookup_weather',
              input: { city: 'Sao Paulo' },
            },
          ],
        },
      ],
      max_tokens: 16,
    };
    const translatedBody = JSON.stringify({
      model: anthropicBody.model,
      messages: [
        {
          role: 'assistant',
          content: 'tool call',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: {
                name: 'lookup_weather',
                arguments: '{"city":"Sao Paulo"}',
              },
            },
          ],
        },
      ],
      max_tokens: 16,
    });
    const sha = shaForBody(translatedBody);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(translatedBody, 'utf8'),
      prefixByteLength: Buffer.byteLength(translatedBody, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(translatedBody, 'utf8'),
      textBytes: Buffer.byteLength(translatedBody, 'utf8'),
      firstResponseToken: 'Hello world',
      extFlags: EXT_FLAG_TOOL_MAP,
    }));
    expect(
      writeTrailer(slotFile, {
        extFlags: EXT_FLAG_TOOL_MAP,
        toolMap: {
          toolu_1:
            '{"id":"toolu_1","type":"function","function":{"name":"lookup_weather","arguments":"{\\n  \\"city\\": \\"Sao Paulo\\"\\n}"}}',
        },
      }),
    ).toEqual({ ok: true });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(anthropicBody),
      }),
      runtime.env as any,
    );
    expect(response.status).toBe(200);
    expect(openaiProxy.__getOpenAIProxyKvReplayMismatchTotalForTests(runtime.env as any)).toBe(1);
    expect(upstream.events).toEqual(['slot-restore', 'chat-forward', 'slot-save']);
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('"event":"kv_replay_mismatch"'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test('warm-hit mismatch on deterministic request increments false-hit counter and invalidates entry', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, firstJsonToken: 'Goodbye' });
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'deterministic false-hit' }],
      temperature: 0,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    expect(openaiProxy.__getOpenAIProxyKvFalseHitTotalForTests(runtime.env as any)).toBe(1);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).toBeNull();
    afterStorage.close();
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes('"event":"kv_false_hit"')),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test('warm-hit match on deterministic request keeps entry and counter unchanged', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, firstJsonToken: 'Hello' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'deterministic match' }],
      temperature: 0,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    expect(openaiProxy.__getOpenAIProxyKvFalseHitTotalForTests(runtime.env as any)).toBe(0);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).not.toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('warm-hit mismatch skips check when request is sampled and seed is missing', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, firstJsonToken: 'Goodbye' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'sampled request' }],
      temperature: 0.7,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: 'Hello world',
    }));
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
    expect(openaiProxy.__getOpenAIProxyKvFalseHitTotalForTests(runtime.env as any)).toBe(0);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).not.toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('warm-hit skip when legacy entry has null fingerprint', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, firstJsonToken: 'Goodbye' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'legacy null fingerprint' }],
      temperature: 0,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
      firstResponseToken: null,
    }));
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
    expect(openaiProxy.__getOpenAIProxyKvFalseHitTotalForTests(runtime.env as any)).toBe(0);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).not.toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('restore failure downgrades to cold prefill and deletes broken entry', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, saveMode: 'invalid', restoreMode: 'http_error' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'broken restore' }],
    });
    const sha = shaForBody(body);
    const missingSlotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(missingSlotFile), { recursive: true });
    writeFileSync(missingSlotFile, 'slot');
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: missingSlotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: workloadEpoch!,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
    }));
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
    expect(upstream.events).toEqual(['slot-restore', 'chat-forward', 'slot-save']);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('epoch mismatch rejects stale hit and proceeds as cold prefill', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'stale epoch' }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, 'slot');
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(entryTemplate({
      sha,
      workload: 'wl-a',
      upstreamSlotFile: slotFile,
      tokens: Buffer.byteLength(body, 'utf8'),
      prefixByteLength: Buffer.byteLength(body, 'utf8'),
      workloadEpoch: 'stale-epoch',
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      textBytes: Buffer.byteLength(body, 'utf8'),
    }));
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
    expect(upstream.events).toEqual(['chat-forward', 'slot-save']);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('eviction trims over-budget workload entries and keeps new cold entry', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB = '1';
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    for (const [idx, sha] of ['old-a', 'old-b', 'old-c'].entries()) {
      const slotFile = join(runtime.root, 'kvstore', 'slots', 'wl-a', `${sha}.kvslot`);
      mkdirSync(dirname(slotFile), { recursive: true });
      writeFileSync(slotFile, 'slot');
      registry.insert(entryTemplate({
        sha,
        workload: 'wl-a',
        upstreamSlotFile: slotFile,
        workloadEpoch: workloadEpoch!,
        payloadBytes: 420_000 + idx * 10_000,
        textBytes: 200_000,
        lastUsed: Date.now() - 10_000_000 - idx * 1_000,
      }));
    }
    storage.close();

    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'evict me not' }],
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

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    const entries = afterRegistry.listAll().filter((entry) => entry.workload === 'wl-a');
    const totalBytes = entries.reduce((sum, entry) => sum + entry.payloadBytes, 0);
    expect(totalBytes).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(afterRegistry.get(shaForBody(body))).not.toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test('eviction blocked by active entry keeps active row and emits debug event', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir });
  process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB = '1';
  const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const workloadEpoch = readWorkloadEpoch({ name: 'wl-a' }, runtime.env as any);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);

    const activeSlot = join(runtime.root, 'kvstore', 'slots', 'wl-a', 'active.kvslot');
    mkdirSync(dirname(activeSlot), { recursive: true });
    writeFileSync(activeSlot, 'slot');
    registry.insert(entryTemplate({
      sha: 'active',
      workload: 'wl-a',
      upstreamSlotFile: activeSlot,
      workloadEpoch: workloadEpoch!,
      payloadBytes: 900_000,
      state: 'active',
      lastUsed: Date.now() - 9_000_000,
    }));

    const idleSlot = join(runtime.root, 'kvstore', 'slots', 'wl-a', 'idle.kvslot');
    writeFileSync(idleSlot, 'slot');
    registry.insert(entryTemplate({
      sha: 'idle',
      workload: 'wl-a',
      upstreamSlotFile: idleSlot,
      workloadEpoch: workloadEpoch!,
      payloadBytes: 700_000,
      state: 'idle',
      lastUsed: Date.now() - 8_000_000,
    }));
    storage.close();

    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'active stays' }],
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
    expect(debugSpy).toHaveBeenCalled();
    expect(
      debugSpy.mock.calls.some((call) => String(call[0]).includes('slot_eviction_blocked_active_request')),
    ).toBe(true);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get('active')?.state).toBe('active');
    afterStorage.close();
  } finally {
    debugSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test('sse response skips kv save', async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, 'kvstore', 'slots', 'wl-a');
  const upstream = await startUpstream({ slotBaseDir, chatMode: 'sse' });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, 'wl-a', Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf',
      messages: [{ role: 'user', content: 'stream it' }],
      stream: true,
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
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    expect(registry.get(shaForBody(body))).toBeNull();
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});
