import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateToken, hashToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';
import type { TunnelState } from '../src/tunnel/index.js';

/**
 * Phase I.3.2 — agent-side DIAL-OUT (tunnelDial) integration.
 *
 * Boots two agents in-process: agent A acts as central
 * (`tunnelCentral`), agent B dials A via `tunnelDial`. Once the
 * tunnel is `ready`, central reaches B's tRPC procedures via
 * `/tunnel-relay/<nodeName>` and the response round-trips.
 *
 * Plain HTTP, 127.0.0.1, ephemeral ports, mDNS off — same hermetic
 * scaffolding tunnel-integration.test.ts (Phase I.3.1) uses.
 */

interface CentralHandle {
  agent: RunningAgent;
  agentToken: string;
  tunnelBearer: string;
  baseUrl: string;
  port: number;
  wsUrl: string;
}

function bootCentralAgent(): CentralHandle {
  const { token: agentToken, hash: agentHash } = generateToken();
  const tunnelBearer = `tun_${Math.random().toString(36).slice(2)}`;
  const agent = startAgentServer({
    bindHost: '127.0.0.1',
    port: 0,
    tokenHash: agentHash,
    advertiseMdns: false,
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

interface DialingHandle {
  agent: RunningAgent;
  states: TunnelState[];
}

function bootDialingAgent(opts: {
  url: string;
  bearer: string;
  nodeName: string;
}): DialingHandle {
  const states: TunnelState[] = [];
  const { hash } = generateToken();
  const agent = startAgentServer({
    bindHost: '127.0.0.1',
    port: 0,
    tokenHash: hash,
    advertiseMdns: false,
    tunnelDial: {
      url: opts.url,
      bearer: opts.bearer,
      nodeName: opts.nodeName,
      onStateChange: (s) => {
        states.push(s);
      },
    },
  });
  return { agent, states };
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
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

let centrals: CentralHandle[] = [];
let dialers: DialingHandle[] = [];

beforeEach(() => {
  centrals = [];
  dialers = [];
});
afterEach(async () => {
  for (const d of dialers) {
    await d.agent.stop().catch(() => {});
  }
  for (const c of centrals) {
    await c.agent.stop().catch(() => {});
  }
  centrals = [];
  dialers = [];
});

describe('startAgentServer with tunnelDial', () => {
  test('central + dialing agent round-trip a real procedure via /tunnel-relay', async () => {
    const central = bootCentralAgent();
    centrals.push(central);

    const dialer = bootDialingAgent({
      url: central.wsUrl,
      bearer: central.tunnelBearer,
      nodeName: 'nodeB',
    });
    dialers.push(dialer);

    expect(dialer.agent.tunnelClient).toBeDefined();
    // Wait until the tunnel client reports ready (handshake done) AND
    // central has registered the node (write-then-read race protection).
    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(
      () => central.agent.tunnelServer!.registry().some((e) => e.nodeName === 'nodeB'),
    );

    // Round-trip a real read-only router procedure (`env`) — see
    // packages/remote/src/router.ts:257.
    const resp = await fetch(`${central.baseUrl}/tunnel-relay/nodeB`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${central.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'nodeFacts', type: 'query' }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      id: string;
      result?: { profile?: unknown; os?: unknown; arch?: unknown };
      error?: { code: string; message: string };
    };
    expect(body.type).toBe('res');
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    // collectNodeFacts() returns NodeFacts with at least profile/os/arch.
    expect(typeof body.result?.profile).toBe('string');
    expect(typeof body.result?.os).toBe('string');
    expect(typeof body.result?.arch).toBe('string');
  });

  test('disconnect → reconnect: tunnel re-establishes and second relay call succeeds', async () => {
    const central = bootCentralAgent();
    centrals.push(central);

    const dialer = bootDialingAgent({
      url: central.wsUrl,
      bearer: central.tunnelBearer,
      nodeName: 'nodeB',
    });
    dialers.push(dialer);

    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(
      () => central.agent.tunnelServer!.registry().some((e) => e.nodeName === 'nodeB'),
    );

    const readyCountBefore = dialer.states.filter((s) => s === 'ready').length;
    expect(readyCountBefore).toBeGreaterThanOrEqual(1);

    // Drop the tunnel from central's side. The dialing client's
    // onclose path fires `disconnected`, then the reconnect loop
    // schedules a fresh attempt → `connecting` → `ready` again.
    const closed = central.agent.tunnelServer!.disconnect('nodeB', 'test-eviction');
    expect(closed).toBe(true);

    await waitFor(() => dialer.states.includes('disconnected'), 3000);
    // Wait for a fresh `ready` (i.e. a SECOND ready transition after
    // the disconnect). The reconnect-backoff first delay is ~1s with
    // ±20% jitter; budget 5s.
    await waitFor(
      () => dialer.states.filter((s) => s === 'ready').length > readyCountBefore,
      5000,
    );
    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(
      () => central.agent.tunnelServer!.registry().some((e) => e.nodeName === 'nodeB'),
    );

    const resp = await fetch(`${central.baseUrl}/tunnel-relay/nodeB`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${central.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'nodeFacts', type: 'query' }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      result?: { profile?: unknown };
      error?: { code: string; message: string };
    };
    expect(body.error).toBeUndefined();
    expect(typeof body.result?.profile).toBe('string');
  });
});
