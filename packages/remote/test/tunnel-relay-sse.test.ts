import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StreamLimits } from "../src/tunnel/messages.js";

import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { generateToken, hashToken } from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";
import { handleTunnelRelay } from "../src/server/tunnel-relay.js";
import {
  createTunnelClient,
  createTunnelServer,
  type TunnelJournalEntry,
  type TunnelReq,
  type TunnelServer,
  type TunnelSubscription,
} from "../src/tunnel/index.js";
import { type ControllerClosedGuard, installControllerClosedGuard } from "./helpers.js";
import { guardDefaultTunnelJournal, useTempTunnelJournal } from "./tunnel-journal-sandbox.js";

/**
 * B.4 coverage — end-to-end SSE relay. Boots a central agent with
 * a tunnel-server, dials a client whose handleSubscription emits a
 * scripted event sequence, then hits `/tunnel-relay/<node>?stream=true`
 * via `fetch` and parses the SSE body.
 */

interface SSEFrame {
  event?: string;
  data: string;
}

function parseSSEFrame(chunk: string): SSEFrame {
  const frame: SSEFrame = { data: "" };
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) frame.event = line.slice(6).trim();
    else if (line.startsWith("data:")) frame.data = line.slice(5).trim();
  }
  return frame;
}

/**
 * Drain every complete (`\n\n`-terminated) frame from the buffer into
 * `out`. Returns the unconsumed tail and whether a `done` frame arrived.
 */
function drainSSEFrames(buf: string, out: SSEFrame[]): { rest: string; done: boolean } {
  let rest = buf;
  let idx = rest.indexOf("\n\n");
  while (idx !== -1) {
    const chunk = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    idx = rest.indexOf("\n\n");
    if (!chunk) continue;
    const frame = parseSSEFrame(chunk);
    out.push(frame);
    if (frame.event === "done") return { rest, done: true };
  }
  return { rest, done: false };
}

async function readSSE(res: Response, maxFrames = 50): Promise<SSEFrame[]> {
  const out: SSEFrame[] = [];
  if (!res.body) return out;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (out.length < maxFrames) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const drained = drainSSEFrames(buf, out);
    buf = drained.rest;
    if (drained.done) return out;
  }
  return out;
}

interface RunningHarness {
  stop: () => Promise<void>;
  bunPort: number;
  bearer: string;
  bun: ReturnType<typeof Bun.serve>;
  tunnelSrv: TunnelServer;
  receivedCancel: string[];
}

async function startHarness(script: {
  events: unknown[];
  delayMs?: number;
  throwErr?: Error;
  journalPath?: string;
  streamLimits?: StreamLimits;
}): Promise<RunningHarness> {
  const bearer = "relay-bearer";
  const tunnelBearer = "tunnel-bearer";
  const bearerHash = hashToken(bearer);
  const nodeName = "node1";
  const receivedCancel: string[] = [];
  const tunnelSrv = createTunnelServer({
    expectedBearerHash: hashToken(tunnelBearer),
    journalPath: tunnelJournal.path,
    ...(script.streamLimits !== undefined ? { streamLimits: script.streamLimits } : {}),
  });
  const bun = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/tunnel") {
        return tunnelSrv.handleUpgrade(req, server) ?? new Response("no", { status: 400 });
      }
      if (url.pathname.startsWith("/tunnel-relay/")) {
        return await handleTunnelRelay(
          req,
          url,
          tunnelSrv,
          bearerHash,
          script.journalPath ?? tunnelJournal.path,
        );
      }
      return new Response("404", { status: 404 });
    },
    websocket: tunnelSrv.websocket,
  });
  const bunPort = bun.port ?? 0;
  const handleSubscription = (req: TunnelReq): TunnelSubscription => ({
    subscribe(handlers): { cancel(): void } {
      let cancelled = false;
      const isCancelled = (): boolean => cancelled;
      void (async (): Promise<void> => {
        for (const ev of script.events) {
          if (isCancelled()) break;
          await new Promise((r) => setTimeout(r, script.delayMs ?? 2));
          if (isCancelled()) break;
          handlers.onEvent(ev);
        }
        if (isCancelled()) {
          handlers.onComplete();
          return;
        }
        if (script.throwErr) {
          handlers.onError(script.throwErr);
          return;
        }
        handlers.onComplete();
      })();
      return {
        cancel(): void {
          cancelled = true;
          receivedCancel.push(req.id);
        },
      };
    },
  });
  const client = createTunnelClient({
    url: `ws://127.0.0.1:${String(bunPort)}/tunnel`,
    bearer: tunnelBearer,
    nodeName,
    handleRequest: () => Promise.resolve({}),
    handleSubscription,
    initialAttemptTimeoutMs: 2000,
    heartbeat: { intervalMs: 0 },
  });
  await client.start();
  return {
    bunPort,
    bearer,
    bun,
    tunnelSrv,
    receivedCancel,
    async stop(): Promise<void> {
      client.stop();
      void bun.stop();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}

// The relay streams its SSE body to a `getReader()` consumer that may stop
// draining early (frame cap or a `done` frame), so on disconnect the
// server-side stream can leak a benign Controller-is-already-closed
// rejection at teardown. The shared guard swallows only that and re-throws
// anything else on dispose.
let controllerGuard: ControllerClosedGuard;
beforeAll(() => {
  controllerGuard = installControllerClosedGuard();
});
afterAll(() => {
  controllerGuard.dispose();
});

const tunnelJournal = useTempTunnelJournal();
guardDefaultTunnelJournal();

describe("tunnel-relay SSE", () => {
  let harness: RunningHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.stop();
    harness = undefined;
  });

  test("relays three events + done frame over SSE", async () => {
    harness = await startHarness({
      events: [{ i: 0 }, { i: 1 }, { i: 2 }],
    });
    const res = await fetch(
      `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/node1?stream=true`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method: "tick", type: "subscription", input: null }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSSE(res);
    const dataFrames = frames.filter((f) => !f.event);
    const doneFrames = frames.filter((f) => f.event === "done");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- test uses dynamic fixture/proxy data.
    expect(dataFrames.map((f) => JSON.parse(f.data))).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(doneFrames.length).toBe(1);
    expect(JSON.parse(doneFrames[0]!.data)).toEqual({ ok: true });
  });

  test("agent-side error surfaces as done with ok:false", async () => {
    harness = await startHarness({
      events: [{ seen: 1 }],
      throwErr: Object.assign(new Error("kaboom"), { code: "E42" }),
    });
    const res = await fetch(
      `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/node1?stream=true`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method: "boom", type: "subscription", input: null }),
      },
    );
    const frames = await readSSE(res);
    const done = frames.find((f) => f.event === "done");
    expect(done).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test uses dynamic fixture/proxy data.
    const parsed = JSON.parse(done!.data);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test uses dynamic fixture/proxy data.
    expect(parsed.ok).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test uses dynamic fixture/proxy data.
    expect(parsed.error.message).toBe("kaboom");
  });

  test("client AbortController mid-stream triggers agent stream-cancel", async () => {
    harness = await startHarness({
      events: Array.from({ length: 20 }, (_, i) => ({ i })),
      delayMs: 15,
    });
    const ac = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/node1?stream=true`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method: "long", type: "subscription", input: null }),
        signal: ac.signal,
      },
    );
    expect(res.status).toBe(200);
    // Read one frame then abort.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // cancel on aborted reader may reject; ignore.
    }
    // Give the cancel propagation time to round-trip.
    await new Promise((r) => setTimeout(r, 150));
    expect(harness.receivedCancel.length).toBeGreaterThan(0);
  });

  test("a request-signal abort with no read in flight still ships the node a stream-cancel", async () => {
    // 400 x 5 ms outlasts the wait + poll: a node stream that has
    // already completed has nothing left to cancel.
    harness = await startHarness({
      events: Array.from({ length: 400 }, (_, i) => ({ i })),
      delayMs: 5,
    });
    const dir = mkdtempSync(join(tmpdir(), "relay-sse-reqsignal-"));
    try {
      const journalPath = join(dir, "relay.jsonl");
      const nodeSrv = harness.tunnelSrv;
      // Track the relay's unsettled next() calls so the abort waits for an
      // observed idle body; a fixed sleep can let the abort land on an
      // in-flight pull, whose own close path hides an onReqAbort regression.
      let pendingNext = 0;
      let deliveredEvents = 0;
      const pendingNextAtReturn: number[] = [];
      const tunnelSrv: TunnelServer = {
        ...nodeSrv,
        sendSubscribe: (nodeName, frame): AsyncIterable<unknown> => ({
          [Symbol.asyncIterator]: (): AsyncIterator<unknown> => {
            const inner = nodeSrv.sendSubscribe(nodeName, frame)[Symbol.asyncIterator]();
            return {
              next: async (): Promise<IteratorResult<unknown>> => {
                pendingNext += 1;
                try {
                  const step = await inner.next();
                  if (step.done !== true) deliveredEvents += 1;
                  return step;
                } finally {
                  pendingNext -= 1;
                }
              },
              return: async (): Promise<IteratorResult<unknown>> => {
                pendingNextAtReturn.push(pendingNext);
                return (await inner.return?.()) ?? { done: true, value: undefined };
              },
            };
          },
        }),
      };
      const ac = new AbortController();
      const url = new URL(
        `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/node1?stream=true`,
      );
      // Call handleTunnelRelay directly, not through Bun.serve, so nothing
      // else cancels the body when the request signal aborts.
      const req = new Request(String(url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method: "long", type: "subscription", input: null }),
        signal: ac.signal,
      });
      const res = await handleTunnelRelay(
        req,
        url,
        tunnelSrv,
        hashToken(harness.bearer),
        journalPath,
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      // That read emptied the body's queue, so it pulls one more event; once
      // that is enqueued the queue sits at its high-water mark and nothing
      // pulls, leaving onReqAbort as the only path that can see the abort.
      const idleDeadline = Date.now() + 1000;
      while ((deliveredEvents < 2 || pendingNext > 0) && Date.now() < idleDeadline) {
        await new Promise((r) => setTimeout(r, 1));
      }
      expect({ deliveredEvents, pendingNext }).toEqual({ deliveredEvents: 2, pendingNext: 0 });
      expect(harness.receivedCancel).toEqual([]);
      ac.abort();
      const deadline = Date.now() + 1000;
      while (harness.receivedCancel.length !== 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(harness.receivedCancel).toHaveLength(1);
      // A pull that saw the abort closes the subscription with its own next()
      // still unsettled, so 0 here means onReqAbort did the closing.
      expect(pendingNextAtReturn).toEqual([0]);
      // Read before reader.cancel(): the body's cancel() journals
      // client-aborted too, so reading after it would not prove onReqAbort
      // journaled this line.
      let entries: TunnelJournalEntry[] = [];
      const journalDeadline = Date.now() + 1000;
      while (entries.length === 0 && Date.now() < journalDeadline) {
        try {
          entries = readFileSync(journalPath, "utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as TunnelJournalEntry)
            .filter((e) => e.kind === "tunnel-relay-call" || e.kind === "tunnel-relay-error");
        } catch {
          /* file not yet created */
        }
        if (entries.length === 0) await new Promise((r) => setTimeout(r, 10));
      }
      expect(entries).toEqual([
        expect.objectContaining({
          kind: "tunnel-relay-error",
          code: "client-aborted",
        }) as TunnelJournalEntry,
      ]);
      await reader.cancel().catch(() => undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SSE rejects without bearer", async () => {
    harness = await startHarness({ events: [] });
    const res = await fetch(
      `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/node1?stream=true`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "x", type: "subscription", input: null }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("client abort journals as error, not ok:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-sse-abort-"));
    try {
      const journalPath = join(dir, "relay.jsonl");
      harness = await startHarness({
        events: Array.from({ length: 50 }, (_, i) => ({ i })),
        delayMs: 20,
        journalPath,
      });
      const ac = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/node1?stream=true`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${harness.bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ method: "stream", type: "subscription", input: null }),
          signal: ac.signal,
        },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read();
      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted reader */
      }
      let entry: TunnelJournalEntry | undefined;
      const deadline = Date.now() + 2000;
      while (!entry && Date.now() < deadline) {
        try {
          entry = readFileSync(journalPath, "utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as TunnelJournalEntry)
            .find((e) => e.kind === "tunnel-relay-call" || e.kind === "tunnel-relay-error");
        } catch {
          /* file not yet created */
        }
        if (!entry) await new Promise((r) => setTimeout(r, 10));
      }
      expect(entry).toBeDefined();
      // aborted stream must NOT be journaled as a successful call
      expect(entry?.kind).toBe("tunnel-relay-error");
      if (entry?.kind === "tunnel-relay-error") {
        expect(entry.code).toBe("client-aborted");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SSE against disconnected node ships an error done frame", async () => {
    harness = await startHarness({ events: [] });
    const res = await fetch(
      `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/ghost?stream=true`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method: "x", type: "subscription", input: null }),
      },
    );
    expect(res.status).toBe(200);
    const frames = await readSSE(res);
    const done = frames.find((f) => f.event === "done");
    expect(done).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test uses dynamic fixture/proxy data.
    const parsed = JSON.parse(done!.data);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- test uses dynamic fixture/proxy data.
    expect(parsed.ok).toBe(false);
  });
});

describe("P4.1: bounded relay streams", () => {
  let harness: RunningHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.stop();
    harness = undefined;
  });

  test("central's stream-overflow reaches the relay client as a typed done frame", async () => {
    harness = await startHarness({
      events: [{ small: true }, { pad: "x".repeat(8 * 1024) }, { never: true }],
      streamLimits: { maxFrameBytes: 4096, maxQueuedBytes: 16 * 1024 },
    });
    const res = await fetch(
      `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/node1?stream=true`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method: "big", type: "subscription", input: null }),
      },
    );
    const frames = await readSSE(res);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- test parses SSE payloads.
    expect(frames.filter((f) => !f.event).map((f) => JSON.parse(f.data))).toEqual([
      { small: true },
    ]);
    const done = frames.find((f) => f.event === "done");
    expect(JSON.parse(done?.data ?? "null")).toMatchObject({
      ok: false,
      error: { code: "stream-overflow" },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.receivedCancel).toHaveLength(1);
  });
});

describe("P4.1: central's default caps are per subscription", () => {
  let harness: RunningHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.stop();
    harness = undefined;
  });

  async function relay(method: string): Promise<SSEFrame[]> {
    harness = await startHarness({ events: [{ pad: "x".repeat(2 * 1024 * 1024) }] });
    const res = await fetch(
      `http://127.0.0.1:${String(harness.bunPort)}/tunnel-relay/node1?stream=true`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method, type: "subscription", input: null }),
      },
    );
    return await readSSE(res);
  }

  test("a 2 MiB event on a non-RPC subscription is relayed, as before the RPC caps", async () => {
    const frames = await relay("serverLogs");
    expect(frames.filter((f) => !f.event)).toHaveLength(1);
    expect(JSON.parse(frames.find((f) => f.event === "done")?.data ?? "null")).toEqual({
      ok: true,
    });
  });

  test("the same event on an inferenceRpc subscription ends typed stream-overflow", async () => {
    const frames = await relay("inferenceRpc.stream");
    expect(frames.filter((f) => !f.event)).toHaveLength(0);
    expect(JSON.parse(frames.find((f) => f.event === "done")?.data ?? "null")).toMatchObject({
      ok: false,
      error: { code: "stream-overflow" },
    });
  });
});

describe("P4.1: an agent serves tunneled subscriptions", () => {
  const agents: RunningAgent[] = [];
  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.stop();
  });

  test("an agent dialing central serves tunneled subscriptions from its own router", async () => {
    const relay = generateToken();
    const tunnelBearer = `tun_${Math.random().toString(36).slice(2)}`;
    const central = startAgentServer({
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: relay.hash,
      tunnelCentral: { expectedBearerHash: hashToken(tunnelBearer) },
      tunnelJournalPath: tunnelJournal.path,
    });
    agents.push(central);
    let markReady = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const dialer = startAgentServer({
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      tunnelDial: {
        url: `ws://127.0.0.1:${String(central.port)}/tunnel`,
        bearer: tunnelBearer,
        nodeName: "dialer",
        onStateChange: (state) => {
          if (state === "ready") markReady();
        },
      },
    });
    agents.push(dialer);
    await ready;

    const res = await fetch(`${central.url}/tunnel-relay/dialer?stream=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        method: "inferenceRpc.stream",
        type: "subscription",
        input: { attemptId: "att-none" },
      }),
    });
    const frames = await readSSE(res);
    // The worker RPC stream answered from the dialing agent's router: no
    // claims ride an unauthenticated tunnel context, so it refuses typed.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- test parses SSE payloads.
    expect(frames.filter((f) => !f.event).map((f) => JSON.parse(f.data))).toEqual([
      {
        frame: "rejected",
        rejection: expect.objectContaining({ code: "unauthorized-scope" }) as unknown,
      },
    ]);
    expect(JSON.parse(frames.find((f) => f.event === "done")?.data ?? "null")).toEqual({
      ok: true,
    });
  });
});
