import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeTunnelMessage,
  parseTunnelMessage,
  type ClientWebSocketConstructor,
  type TunnelState,
} from "../src/tunnel/index.js";

import { generateToken, hashToken } from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

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
    bindHost: "127.0.0.1",
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
    wsUrl: `ws://127.0.0.1:${String(agent.port)}/tunnel`,
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
  fleetJournalPath?: string;
  WebSocketCtor?: ClientWebSocketConstructor;
}): DialingHandle {
  const states: TunnelState[] = [];
  const { hash } = generateToken();
  const agent = startAgentServer({
    bindHost: "127.0.0.1",
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
      ...(opts.WebSocketCtor !== undefined ? { WebSocketCtor: opts.WebSocketCtor } : {}),
    },
    ...(opts.fleetJournalPath !== undefined ? { fleetJournalPath: opts.fleetJournalPath } : {}),
  });
  return { agent, states };
}

async function waitFor(check: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function fleetSnapshotFixture(node: string): Record<string, unknown> {
  return {
    kind: "fleet-snapshot",
    ts: "2026-06-22T12:00:00.000Z",
    node,
    node_mem: {
      free_mb: 4096,
      active_mb: 1024,
      inactive_mb: 512,
      wired_mb: 256,
      compressor_mb: 128,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: [
      {
        name: "assistant",
        kind: "ModelRun",
        endpoint: "http://127.0.0.1:8080",
        priority: 50,
        rss_mb: 2048,
        request_rate_5m: 1.5,
        error_rate_5m: 0,
        p50_ms: 100,
        p95_ms: 200,
        models: ["gemma"],
        reachable: true,
        consecutiveErrors: 0,
      },
    ],
  };
}

function disabledModelRunYaml(name: string): string {
  return [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  node: local",
    "  enabled: false",
    "  target:",
    "    kind: rel",
    "    value: models/demo.gguf",
    "",
  ].join("\n");
}

let centrals: CentralHandle[] = [];
let dialers: DialingHandle[] = [];
let tempDirs: string[] = [];

beforeEach(() => {
  centrals = [];
  dialers = [];
  tempDirs = [];
});
afterEach(async () => {
  for (const d of dialers) {
    await d.agent.stop().catch(() => undefined);
  }
  for (const c of centrals) {
    await c.agent.stop().catch(() => undefined);
  }
  centrals = [];
  dialers = [];
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("startAgentServer with tunnelDial", () => {
  test("central + dialing agent round-trip a real procedure via /tunnel-relay", async () => {
    const central = bootCentralAgent();
    centrals.push(central);

    const dialer = bootDialingAgent({
      url: central.wsUrl,
      bearer: central.tunnelBearer,
      nodeName: "nodeB",
    });
    dialers.push(dialer);

    expect(dialer.agent.tunnelClient).toBeDefined();
    // Wait until the tunnel client reports ready (handshake done) AND
    // central has registered the node (write-then-read race protection).
    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(() => central.agent.tunnelServer!.registry().some((e) => e.nodeName === "nodeB"));

    // Round-trip a real read-only router procedure (`env`) — see
    // packages/remote/src/router.ts:257.
    const resp = await fetch(`${central.baseUrl}/tunnel-relay/nodeB`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${central.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "nodeFacts", type: "query" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      id: string;
      result?: { profile?: unknown; os?: unknown; arch?: unknown };
      error?: { code: string; message: string };
    };
    expect(body.type).toBe("res");
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    // collectNodeFacts() returns NodeFacts with at least profile/os/arch.
    expect(typeof body.result?.profile).toBe("string");
    expect(typeof body.result?.os).toBe("string");
    expect(typeof body.result?.arch).toBe("string");
  });

  test("tunnel direction stays central-originated only", async () => {
    const central = bootCentralAgent();
    centrals.push(central);

    const sockets: WebSocket[] = [];
    const CapturingWebSocket = class extends WebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as ClientWebSocketConstructor;

    const dialer = bootDialingAgent({
      url: central.wsUrl,
      bearer: central.tunnelBearer,
      nodeName: "nodeB",
      WebSocketCtor: CapturingWebSocket,
    });
    dialers.push(dialer);

    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(() => central.agent.tunnelServer!.registry().some((e) => e.nodeName === "nodeB"));
    await waitFor(() => sockets.length === 1);

    const resp = await fetch(`${central.baseUrl}/tunnel-relay/nodeB`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${central.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "nodeFacts", type: "query" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      result?: { profile?: unknown };
      error?: { code: string; message: string };
    };
    expect(body.type).toBe("res");
    expect(body.error).toBeUndefined();
    expect(typeof body.result?.profile).toBe("string");

    const socket = sockets[0]!;
    const inboundAfterNodeReq: unknown[] = [];
    const originalOnMessage = socket.onmessage;
    socket.onmessage = ((ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      inboundAfterNodeReq.push(parseTunnelMessage(raw));
      originalOnMessage?.call(socket, ev);
    }) as typeof socket.onmessage;

    socket.send(
      encodeTunnelMessage({
        type: "req",
        id: "node-originated-req",
        method: "nodeFacts",
        params: { type: "query" },
      }),
    );
    await sleep(100);

    expect(
      inboundAfterNodeReq.some(
        (msg) =>
          msg !== null &&
          typeof msg === "object" &&
          "id" in msg &&
          msg.id === "node-originated-req",
      ),
    ).toBe(false);
    expect(central.agent.tunnelServer!.pendingCount("nodeB")).toBe(0);
    expect(dialer.agent.tunnelClient!.isReady()).toBe(true);
  });

  test("central relays fleetSnapshot query to the dialing node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-fleet-tunnel-"));
    tempDirs.push(dir);
    const journalPath = join(dir, "fleet.jsonl");
    const snapshot = fleetSnapshotFixture("nodeB");
    writeFileSync(journalPath, `${JSON.stringify(snapshot)}\n`, "utf8");

    const central = bootCentralAgent();
    centrals.push(central);

    const dialer = bootDialingAgent({
      url: central.wsUrl,
      bearer: central.tunnelBearer,
      nodeName: "nodeB",
      fleetJournalPath: journalPath,
    });
    dialers.push(dialer);

    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(() => central.agent.tunnelServer!.registry().some((e) => e.nodeName === "nodeB"));

    const resp = await fetch(`${central.baseUrl}/tunnel-relay/nodeB`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${central.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "fleetSnapshot", type: "query" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      result?: unknown;
      error?: { code: string; message: string };
    };
    expect(body.type).toBe("res");
    expect(body.error).toBeUndefined();
    expect(body.result).toEqual(snapshot);
  });

  test("central relays workloadApply mutation to the dialing node", async () => {
    const central = bootCentralAgent();
    centrals.push(central);

    const dialer = bootDialingAgent({
      url: central.wsUrl,
      bearer: central.tunnelBearer,
      nodeName: "nodeB",
    });
    dialers.push(dialer);

    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(() => central.agent.tunnelServer!.registry().some((e) => e.nodeName === "nodeB"));

    const resp = await fetch(`${central.baseUrl}/tunnel-relay/nodeB`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${central.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: "workloadApply",
        type: "mutation",
        input: { yaml: disabledModelRunYaml("relay-apply") },
      }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      result?: { action?: unknown; name?: unknown; node?: unknown; status?: { phase?: unknown } };
      error?: { code: string; message: string };
    };
    expect(body.type).toBe("res");
    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({
      action: "unchanged",
      name: "relay-apply",
      node: "local",
      status: { phase: "Stopped" },
    });
  });

  test("disconnect → reconnect: tunnel re-establishes and second relay call succeeds", async () => {
    const central = bootCentralAgent();
    centrals.push(central);

    const dialer = bootDialingAgent({
      url: central.wsUrl,
      bearer: central.tunnelBearer,
      nodeName: "nodeB",
    });
    dialers.push(dialer);

    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(() => central.agent.tunnelServer!.registry().some((e) => e.nodeName === "nodeB"));

    const readyCountBefore = dialer.states.filter((s) => s === "ready").length;
    expect(readyCountBefore).toBeGreaterThanOrEqual(1);

    // Drop the tunnel from central's side. The dialing client's
    // onclose path fires `disconnected`, then the reconnect loop
    // schedules a fresh attempt → `connecting` → `ready` again.
    const closed = central.agent.tunnelServer!.disconnect("nodeB", "test-eviction");
    expect(closed).toBe(true);

    await waitFor(() => dialer.states.includes("disconnected"), 3000);
    // Wait for a fresh `ready` (i.e. a SECOND ready transition after
    // the disconnect). The reconnect-backoff first delay is ~1s with
    // ±20% jitter; budget 5s.
    await waitFor(() => dialer.states.filter((s) => s === "ready").length > readyCountBefore, 5000);
    await waitFor(() => dialer.agent.tunnelClient!.isReady());
    await waitFor(() => central.agent.tunnelServer!.registry().some((e) => e.nodeName === "nodeB"));

    const resp = await fetch(`${central.baseUrl}/tunnel-relay/nodeB`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${central.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "nodeFacts", type: "query" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      result?: { profile?: unknown };
      error?: { code: string; message: string };
    };
    expect(body.error).toBeUndefined();
    expect(typeof body.result?.profile).toBe("string");
  });
});
