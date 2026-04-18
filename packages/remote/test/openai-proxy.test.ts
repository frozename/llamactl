import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';
import { generateSelfSignedCert } from '../src/server/tls.js';

/**
 * End-to-end test for the agent's OpenAI gateway. Stands up:
 *
 *   fake llama-server (Bun.serve in this process)
 *     ↑
 *     | plain HTTP
 *     |
 *   llamactl agent (TLS + bearer)
 *     ↑
 *     | HTTPS + bearer
 *     |
 *   test client (Bun fetch with tls.ca pinned)
 *
 * The fake llama-server echoes the request body + the inferred path
 * back to the caller so we can prove headers and streaming pass-
 * through work. The proxy also writes a sidecar state file so
 * `listOpenAIModels` reports a non-empty `/v1/models` response.
 */

const FAKE_LLAMA_PORT = 28840;

let fakeServer: ReturnType<typeof Bun.serve> | null = null;
let agent: RunningAgent | null = null;
let devStorage = '';
let runtimeDir = '';
let agentToken = '';
let caPem = '';
let fingerprint = '';

const originalEnv = { ...process.env };

beforeAll(async () => {
  devStorage = mkdtempSync(join(tmpdir(), 'llamactl-openai-proxy-'));
  runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  mkdirSync(runtimeDir, { recursive: true });

  // Stand up a stub llama-server. Responds to /v1/* with a JSON body
  // that echoes the inbound request so assertions can look at headers
  // and method without coupling to llama.cpp internals.
  fakeServer = Bun.serve({
    port: FAKE_LLAMA_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return new Response('ok', { status: 200 });
      if (url.pathname.startsWith('/v1/')) {
        const body = req.method === 'POST' ? await req.text() : '';
        // Simulate SSE for streaming chat/completions.
        if (req.method === 'POST' && body.includes('"stream":true')) {
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return Response.json({
          echoed: {
            path: url.pathname,
            method: req.method,
            body,
            contentType: req.headers.get('content-type'),
            hasAuth: req.headers.has('authorization'),
          },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  // Point the agent's env at the fake llama-server. The proxy reads
  // LLAMA_CPP_HOST / LLAMA_CPP_PORT via resolveEnv() on every call.
  process.env.DEV_STORAGE = devStorage;
  // The user's shell may export LOCAL_AI_RUNTIME_DIR globally. That
  // takes precedence over DEV_STORAGE in resolveEnv, so override it
  // here too — otherwise the sidecar writes we just did land in the
  // wrong directory.
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_HOST = '127.0.0.1';
  process.env.LLAMA_CPP_PORT = String(FAKE_LLAMA_PORT);
  process.env.LLAMACTL_NODE_NAME = 'test-agent';

  // Write a sidecar state file so `/v1/models` returns a model entry.
  const pid = process.pid;
  writeFileSync(join(runtimeDir, 'llama-server.pid'), String(pid));
  writeFileSync(
    join(runtimeDir, 'llama-server.state'),
    JSON.stringify({
      rel: 'test-org/test-model/model-Q4.gguf',
      extraArgs: [],
      host: '127.0.0.1',
      port: String(FAKE_LLAMA_PORT),
      pid,
      startedAt: new Date().toISOString(),
      tunedProfile: null,
    }),
  );

  const certDir = join(devStorage, 'agent');
  const cert = await generateSelfSignedCert({
    dir: certDir,
    commonName: '127.0.0.1',
    hostnames: ['127.0.0.1', 'localhost'],
  });
  caPem = cert.certPem;
  fingerprint = cert.fingerprint;

  const token = generateToken();
  agentToken = token.token;
  agent = startAgentServer({
    bindHost: '127.0.0.1',
    port: 0,
    tokenHash: token.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
  });
});

afterAll(async () => {
  await agent?.stop();
  fakeServer?.stop(true);
  rmSync(devStorage, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

afterEach(() => {
  void fingerprint; // pinned fingerprint currently unused below; keep for future assertions
});

function pinnedFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${agent!.url}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${agentToken}`,
    },
    ...({ tls: { ca: caPem } } as Record<string, unknown>),
  } as RequestInit);
}

describe('agent OpenAI proxy', () => {
  test('GET /v1/models lists the tracked rel', async () => {
    const res = await pinnedFetch('/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; owned_by: string }>;
    };
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe('test-org/test-model/model-Q4.gguf');
    expect(body.data[0]!.owned_by).toBe('llamactl');
  });

  test('POST /v1/chat/completions forwards the body to llama-server', async () => {
    const res = await pinnedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      echoed: { path: string; method: string; body: string; contentType: string | null; hasAuth: boolean };
    };
    expect(body.echoed.path).toBe('/v1/chat/completions');
    expect(body.echoed.method).toBe('POST');
    expect(body.echoed.body).toContain('"messages"');
    expect(body.echoed.contentType).toContain('application/json');
    // The proxy must strip the agent's bearer header before forwarding;
    // llama-server has no auth and would reject unknown tokens.
    expect(body.echoed.hasAuth).toBe(false);
  });

  test('streaming chat/completions passes SSE through', async () => {
    const res = await pinnedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"delta":{"content":"hi"}');
    expect(text).toContain('[DONE]');
  });

  test('missing bearer token yields 401', async () => {
    const res = await fetch(`${agent!.url}/v1/models`, {
      ...({ tls: { ca: caPem } } as Record<string, unknown>),
    } as RequestInit);
    expect(res.status).toBe(401);
  });

  test('unknown /v1/* path still forwards (llama-server owns 404s)', async () => {
    const res = await pinnedFetch('/v1/nonexistent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Fake llama-server returns a JSON echo for every /v1/* path, so
    // a 200 here proves the proxy forwarded rather than short-circuiting.
    expect(res.status).toBe(200);
  });
});
