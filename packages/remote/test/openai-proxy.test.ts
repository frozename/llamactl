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
 *   fake llama-servers (Bun.serve in this process)
 *     ↑
 *     | plain HTTP
 *     |
 *   llamactl agent (TLS + bearer)
 *     ↑
 *     | HTTPS + bearer
 *     |
 *   test client (Bun fetch with tls.ca pinned)
 *
 * The fake llama-servers echo the request body + inferred upstream
 * identity back to the caller so we can prove model routing,
 * back-compat fallback, and streaming pass-through work. The proxy
 * also writes sidecar state files so `listOpenAIModels` reports a
 * non-empty `/v1/models` response.
 */

const ENV_LLAMA_PORT = 28840;
const WORKLOAD_A_PORT = 28841;
const WORKLOAD_B_PORT = 28842;

type UpstreamRequest = {
  path: string;
  method: string;
  body: string;
  contentType: string | null;
  hasAuth: boolean;
};

type FakeUpstream = {
  label: string;
  port: number;
  server: ReturnType<typeof Bun.serve>;
  requests: UpstreamRequest[];
};

let fakeUpstreams: FakeUpstream[] = [];
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

  const startFakeUpstream = (label: string, port: number): FakeUpstream => {
    const requests: UpstreamRequest[] = [];
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/health') return new Response('ok', { status: 200 });
        if (url.pathname.startsWith('/v1/')) {
          const body = req.method === 'POST' ? await req.text() : '';
          requests.push({
            path: url.pathname,
            method: req.method,
            body,
            contentType: req.headers.get('content-type'),
            hasAuth: req.headers.has('authorization'),
          });
          // Simulate SSE for streaming chat/completions.
          if (req.method === 'POST' && body.includes('"stream":true')) {
            const stream = new ReadableStream({
              start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(enc.encode(`data: {"label":"${label}","choices":[{"delta":{"content":"hi"}}]}\n\n`));
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
              label,
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
    return { label, port, server, requests };
  };

  // Stand up stub llama-servers. The proxy should route JSON requests
  // by model when it can, and fall back to the env port otherwise.
  fakeUpstreams = [
    startFakeUpstream('env', ENV_LLAMA_PORT),
    startFakeUpstream('workload-a', WORKLOAD_A_PORT),
    startFakeUpstream('workload-b', WORKLOAD_B_PORT),
  ];

  // Point the agent's env at the fake llama-server. The proxy reads
  // LLAMA_CPP_HOST / LLAMA_CPP_PORT via resolveEnv() on every call.
  process.env.DEV_STORAGE = devStorage;
  // The user's shell may export LOCAL_AI_RUNTIME_DIR globally. That
  // takes precedence over DEV_STORAGE in resolveEnv, so override it
  // here too — otherwise the sidecar writes we just did land in the
  // wrong directory.
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_HOST = '127.0.0.1';
  process.env.LLAMA_CPP_PORT = String(ENV_LLAMA_PORT);
  process.env.LLAMACTL_NODE_NAME = 'test-agent';

  // Write sidecar state files for two live workloads so `/v1/models`
  // still returns an entry and routing can choose between them.
  const pid = process.pid;
  const workloadA = join(runtimeDir, 'workloads', 'workload-a');
  mkdirSync(workloadA, { recursive: true });
  writeFileSync(join(workloadA, 'llama-server.pid'), String(pid));
  writeFileSync(
    join(workloadA, 'llama-server.state'),
    JSON.stringify({
      rel: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf',
      extraArgs: [],
      host: '127.0.0.1',
      port: String(WORKLOAD_A_PORT),
      pid,
      startedAt: new Date().toISOString(),
      tunedProfile: null,
    }),
  );
  const workloadB = join(runtimeDir, 'workloads', 'workload-b');
  mkdirSync(workloadB, { recursive: true });
  writeFileSync(join(workloadB, 'llama-server.pid'), String(pid));
  writeFileSync(
    join(workloadB, 'llama-server.state'),
    JSON.stringify({
      rel: 'qwen3-8b-GGUF/qwen3-8b-Q8_0.gguf',
      extraArgs: [],
      host: '127.0.0.1',
      port: String(WORKLOAD_B_PORT),
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
  for (const upstream of fakeUpstreams) upstream.server.stop(true);
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
    expect(body.data).toHaveLength(2);
    expect(body.data.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf',
        'qwen3-8b-GGUF/qwen3-8b-Q8_0.gguf',
      ]),
    );
    expect(body.data.every((entry) => entry.owned_by === 'llamactl-agent')).toBe(true);
  });

  test('POST /v1/chat/completions routes by model across workloads', async () => {
    const resA = await pinnedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf',
        messages: [{ role: 'user', content: 'hi A' }],
      }),
    });
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as {
      echoed: { label: string; path: string; method: string; body: string; contentType: string | null; hasAuth: boolean };
    };
    expect(bodyA.echoed.label).toBe('workload-a');
    expect(bodyA.echoed.path).toBe('/v1/chat/completions');
    expect(bodyA.echoed.method).toBe('POST');
    expect(bodyA.echoed.body).toContain('"messages"');
    expect(bodyA.echoed.contentType).toContain('application/json');
    expect(bodyA.echoed.hasAuth).toBe(false);

    const resB = await pinnedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-8b-GGUF/qwen3-8b-Q8_0.gguf',
        messages: [{ role: 'user', content: 'hi B' }],
      }),
    });
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as {
      echoed: { label: string; path: string; method: string; body: string; contentType: string | null; hasAuth: boolean };
    };
    expect(bodyB.echoed.label).toBe('workload-b');
    expect(bodyB.echoed.body).toContain('"messages"');
    expect(bodyB.echoed.hasAuth).toBe(false);
  });

  test('POST /v1/chat/completions falls back to the env endpoint when model is missing or unknown', async () => {
    const omitted = await pinnedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(omitted.status).toBe(200);
    const omittedBody = (await omitted.json()) as {
      echoed: { label: string };
    };
    expect(omittedBody.echoed.label).toBe('env');

    const unknown = await pinnedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'missing-model.gguf', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(unknown.status).toBe(200);
    const unknownBody = (await unknown.json()) as {
      echoed: { label: string };
    };
    expect(unknownBody.echoed.label).toBe('env');
  });

  test('POST /v1/chat/completions forwards the body to the routed llama-server', async () => {
    const res = await pinnedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      echoed: { label: string; path: string; method: string; body: string; contentType: string | null; hasAuth: boolean };
    };
    expect(body.echoed.label).toBe('workload-a');
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
      body: JSON.stringify({
        model: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf',
        stream: true,
        messages: [],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"label":"workload-a"');
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
