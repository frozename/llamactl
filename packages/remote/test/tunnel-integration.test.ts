import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createTunnelClient,
  encodeTunnelMessage,
  parseTunnelMessage,
  type TunnelReq,
} from '../src/tunnel/index.js';
import { generateToken, hashToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';

/**
 * Phase I.3.1 — agent-side mounting of tunnelServer + /tunnel-relay.
 *
 * These tests boot startAgentServer over plain HTTP (test-only mode)
 * with a tunnelCentral option, exercise the /tunnel WS upgrade and
 * the /tunnel-relay HTTP bridge end-to-end, and confirm the
 * non-tunnelCentral path is unchanged.
 */

interface AgentHandle {
  agent: RunningAgent;
  agentToken: string;
  tunnelBearer: string;
  baseUrl: string;
  port: number;
  wsUrl: string;
}

function bootAgentWithTunnel(): AgentHandle {
  const { token: agentToken, hash: agentHash } = generateToken();
  const tunnelBearer = `tun_${Math.random().toString(36).slice(2)}`;
  const agent = startAgentServer({
    bindHost: '127.0.0.1',
    port: 0,
    tokenHash: agentHash,
    tunnelCentral: { expectedBearerHash: hashToken(tunnelBearer) },
  });
  return {
    agent,
    agentToken,
    tunnelBearer,
    baseUrl: agent.url,
    port: agent.port,
    wsUrl: `ws://127.0.0.1:${agent.port}/tunnel`,
  };
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let handles: AgentHandle[] = [];

beforeEach(() => {
  handles = [];
});
afterEach(async () => {
  for (const h of handles) await h.agent.stop().catch(() => {});
  handles = [];
});

describe('startAgentServer with tunnelCentral', () => {
  test('accepts a /tunnel ws upgrade and registers the node', async () => {
    const h = bootAgentWithTunnel();
    handles.push(h);

    // Use a raw WebSocket so we can drive the hello handshake by
    // hand and confirm the registry from the server side.
    const ws = new WebSocket(h.wsUrl);
    let ackSeen = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ack timeout')), 2000);
      ws.onopen = () => {
        ws.send(
          encodeTunnelMessage({
            type: 'hello',
            bearer: h.tunnelBearer,
            nodeName: 'gpu-alpha',
          }),
        );
      };
      ws.onmessage = (ev: MessageEvent) => {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        const msg = parseTunnelMessage(raw);
        if (msg?.type === 'hello-ack') {
          ackSeen = true;
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(err as unknown as Error);
      };
    });
    expect(ackSeen).toBe(true);
    expect(h.agent.tunnelServer).toBeDefined();
    await waitFor(() => h.agent.tunnelServer!.registry().length === 1);
    const reg = h.agent.tunnelServer!.registry();
    expect(reg.map((e) => e.nodeName)).toEqual(['gpu-alpha']);
    ws.close();
  });

  test('/tunnel-relay/<node> dispatches to a connected tunnel', async () => {
    const h = bootAgentWithTunnel();
    handles.push(h);

    const seen: TunnelReq[] = [];
    const tunnelClient = createTunnelClient({
      url: h.wsUrl,
      bearer: h.tunnelBearer,
      nodeName: 'gpu-alpha',
      handleRequest: async (req) => {
        seen.push(req);
        return 'ok';
      },
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await tunnelClient.start();

    const resp = await fetch(`${h.baseUrl}/tunnel-relay/gpu-alpha`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'test.ping', input: { n: 1 } }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      id: string;
      result?: unknown;
      error?: { code: string; message: string };
    };
    expect(body.type).toBe('res');
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.result).toBe('ok');
    expect(body.error).toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('test.ping');
    expect(seen[0]!.params).toEqual({ type: 'query', input: { n: 1 } });
    tunnelClient.stop();
  });

  test('/tunnel-relay/<unknown> returns 502 with tunnel-send-failed', async () => {
    const h = bootAgentWithTunnel();
    handles.push(h);

    const resp = await fetch(`${h.baseUrl}/tunnel-relay/ghost`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'whatever' }),
    });
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as {
      type: string;
      id: string;
      error?: { code: string; message: string };
    };
    expect(body.error?.code).toBe('tunnel-send-failed');
    expect(typeof body.error?.message).toBe('string');
  });

  test('/tunnel-relay/<node> 401s without bearer', async () => {
    const h = bootAgentWithTunnel();
    handles.push(h);

    const resp = await fetch(`${h.baseUrl}/tunnel-relay/anything`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'x' }),
    });
    expect(resp.status).toBe(401);
    expect(resp.headers.get('www-authenticate')).toContain('Bearer');
  });

  test('/tunnel-relay/<node> 400s on malformed JSON body', async () => {
    const h = bootAgentWithTunnel();
    handles.push(h);

    const resp = await fetch(`${h.baseUrl}/tunnel-relay/anything`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.agentToken}`,
        'content-type': 'application/json',
      },
      body: '{not-json',
    });
    expect(resp.status).toBe(400);
  });
});

describe('startAgentServer without tunnelCentral', () => {
  test('/tunnel falls through to 404 and tunnelServer is undefined', async () => {
    const { token, hash } = generateToken();
    const agent = startAgentServer({
      bindHost: '127.0.0.1',
      port: 0,
      tokenHash: hash,
    });
    handles.push({
      agent,
      agentToken: token,
      tunnelBearer: '',
      baseUrl: agent.url,
      port: agent.port,
      wsUrl: `ws://127.0.0.1:${agent.port}/tunnel`,
    });

    expect(agent.tunnelServer).toBeUndefined();

    // Plain GET (no upgrade headers) — the fetch handler should
    // skip the gated /tunnel branch and fall through to 404.
    const resp = await fetch(`${agent.url}/tunnel`);
    expect(resp.status).toBe(404);
  });
});
