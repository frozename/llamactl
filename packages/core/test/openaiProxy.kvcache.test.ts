import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openaiProxy } from '../src/index.js';
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

async function startUpstream(opts?: {
  saveMode?: 'ok' | 'invalid';
  restoreMode?: 'ok' | 'http_error';
  chatMode?: 'json' | 'sse';
  firstJsonToken?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}): Promise<TestUpstream> {
  const events: string[] = [];
  const saveMode = opts?.saveMode ?? 'ok';
  const restoreMode = opts?.restoreMode ?? 'ok';
  const chatMode = opts?.chatMode ?? 'json';
  const firstJsonToken = opts?.firstJsonToken ?? 'Hello';
  const toolCalls = opts?.toolCalls ?? [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname.startsWith('/slots/')) {
      const action = url.searchParams.get('action');
      const filename = url.searchParams.get('filename') ?? '';
      if (action === 'restore') {
        events.push('slot-restore');
        if (restoreMode === 'http_error') return json(res, 500, { error: 'restore-fail' });
        if (!existsSync(filename)) return json(res, 404, { error: 'missing' });
        return json(res, 200, { n_restored: 123 });
      }
      if (action === 'save') {
        events.push('slot-save');
        mkdirSync(dirname(filename), { recursive: true });
        writeFileSync(filename, 'slot');
        if (saveMode === 'invalid') return json(res, 200, { ok: true });
        return json(res, 200, { n_saved: 321 });
      }
      return json(res, 400, { error: 'bad action' });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      events.push('chat-forward');
      const body = await readBody(req);
      if (chatMode === 'sse') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ id: 'evt', body })}\n\n`);
        return;
      }
      return json(res, 200, {
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
    events,
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

afterEach(() => {
  if (originalBudget === undefined) delete process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB;
  else process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB = originalBudget;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

test('cold miss saves a new idle kv entry', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream();
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

test('anthropic cold save writes trailer toolMap and ext_flags when upstream returns tool_calls', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream({
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
  const upstream = await startUpstream();
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

test('anthropic warm hit replays with trailer toolMap bytes and keeps warm path when sha matches', async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream();
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
  const upstream = await startUpstream();
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
  const upstream = await startUpstream({ firstJsonToken: 'Goodbye' });
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
  const upstream = await startUpstream({ firstJsonToken: 'Hello' });
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
  const upstream = await startUpstream({ firstJsonToken: 'Goodbye' });
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
  const upstream = await startUpstream({ firstJsonToken: 'Goodbye' });
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
  const upstream = await startUpstream({ saveMode: 'invalid', restoreMode: 'http_error' });
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
  const upstream = await startUpstream();
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
  const upstream = await startUpstream();
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
  const upstream = await startUpstream();
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
  const upstream = await startUpstream({ chatMode: 'sse' });
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
