import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';
import { generateSelfSignedCert } from '../src/server/tls.js';

/**
 * Scrapes the agent's `/metrics` endpoint and asserts the expected
 * llamactl_* counters appear in the output. Also verifies that
 * hitting the OpenAI gateway bumps the request and duration series.
 */

const FAKE_LLAMA_PORT = 28941;

let fakeServer: ReturnType<typeof Bun.serve> | null = null;
let agent: RunningAgent | null = null;
let devStorage = '';
let agentToken = '';
let caPem = '';
const originalEnv = { ...process.env };

beforeAll(async () => {
  devStorage = mkdtempSync(join(tmpdir(), 'llamactl-metrics-'));
  const runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'llama-server.pid'), String(process.pid));
  writeFileSync(
    join(runtimeDir, 'llama-server.state'),
    JSON.stringify({
      rel: 'metrics-test/model.gguf',
      extraArgs: [],
      host: '127.0.0.1',
      port: String(FAKE_LLAMA_PORT),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      tunedProfile: null,
    }),
  );

  fakeServer = Bun.serve({
    port: FAKE_LLAMA_PORT,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return new Response('ok', { status: 200 });
      if (url.pathname === '/v1/chat/completions') return Response.json({ ok: true });
      return new Response('stub', { status: 200 });
    },
  });

  process.env.DEV_STORAGE = devStorage;
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_HOST = '127.0.0.1';
  process.env.LLAMA_CPP_PORT = String(FAKE_LLAMA_PORT);
  process.env.LLAMACTL_NODE_NAME = 'metrics-test-node';

  const cert = await generateSelfSignedCert({
    dir: join(devStorage, 'agent'),
    commonName: '127.0.0.1',
    hostnames: ['127.0.0.1', 'localhost'],
  });
  caPem = cert.certPem;

  const token = generateToken();
  agentToken = token.token;
  agent = startAgentServer({
    bindHost: '127.0.0.1',
    port: 0,
    tokenHash: token.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    nodeName: 'metrics-test-node',
    version: '1.2.3',
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

function pinnedFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${agent!.url}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${agentToken}`,
    },
    ...({ tls: { ca: caPem } } as Record<string, unknown>),
  } as RequestInit);
}

describe('agent /metrics endpoint', () => {
  test('requires bearer auth', async () => {
    const res = await fetch(`${agent!.url}/metrics`, {
      ...({ tls: { ca: caPem } } as Record<string, unknown>),
    } as RequestInit);
    expect(res.status).toBe(401);
  });

  test('returns Prometheus text and core llamactl_* series', async () => {
    const res = await pinnedFetch('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    // Default Node metrics are present (proves collectDefaultMetrics
    // registered on our registry).
    expect(text).toContain('process_cpu_user_seconds_total');
    // Agent-identity label carries the node_name + version. The
    // registry is module-global, so when other test files also start
    // agent servers we may see multiple agent_info series — look for
    // the one whose labels match this test's agent.
    const infoLine = text
      .split('\n')
      .find(
        (l) =>
          l.startsWith('llamactl_agent_info{') &&
          l.includes('node_name="metrics-test-node"') &&
          l.includes('version="1.2.3"'),
      );
    expect(infoLine).toBeTruthy();
    expect(infoLine).toMatch(/\s1\s*$/);
  });

  test('OpenAI requests bump the request + duration counters', async () => {
    // Scrape twice — before and after — and diff the counter values.
    async function scrape(): Promise<string> {
      const r = await pinnedFetch('/metrics');
      return r.text();
    }

    function countChatSeries(text: string): number {
      const line = text
        .split('\n')
        .find(
          (l) =>
            l.startsWith('llamactl_openai_requests_total{') &&
            l.includes('path="/v1/chat/completions"') &&
            l.includes('status_class="2xx"'),
        );
      if (!line) return 0;
      const n = Number(line.trim().split(/\s+/).pop());
      return Number.isFinite(n) ? n : 0;
    }

    const before = countChatSeries(await scrape());
    const res = await pinnedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(200);
    const after = countChatSeries(await scrape());
    expect(after).toBe(before + 1);
  });

  test('GET /v1/models flips llama_server_up to 1', async () => {
    await pinnedFetch('/v1/models');
    const res = await pinnedFetch('/metrics');
    const text = await res.text();
    const line = text
      .split('\n')
      .find((l) => l.startsWith('llamactl_llama_server_up'));
    expect(line).toBeTruthy();
    expect(line).toMatch(/llamactl_llama_server_up.*\s1\s*$/);
  });
});
