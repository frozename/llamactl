import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashToken } from "../src/server/auth.js";
import { handleTunnelRelay } from "../src/server/tunnel-relay.js";
import {
  createTunnelClient,
  createTunnelServer,
  type TunnelJournalEntry,
  type TunnelReq,
  type TunnelSubscription,
} from "../src/tunnel/index.js";

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
  receivedCancel: string[];
}

async function startHarness(script: {
  events: unknown[];
  delayMs?: number;
  throwErr?: Error;
  journalPath?: string;
}): Promise<RunningHarness> {
  const bearer = "relay-bearer";
  const tunnelBearer = "tunnel-bearer";
  const bearerHash = hashToken(bearer);
  const nodeName = "node1";
  const receivedCancel: string[] = [];
  const tunnelSrv = createTunnelServer({
    expectedBearerHash: hashToken(tunnelBearer),
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
        return await handleTunnelRelay(req, url, tunnelSrv, bearerHash, script.journalPath);
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
    receivedCancel,
    async stop(): Promise<void> {
      client.stop();
      void bun.stop();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}

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
    rmSync(dir, { recursive: true, force: true });
    expect(entry).toBeDefined();
    // aborted stream must NOT be journaled as a successful call
    expect(entry?.kind).toBe("tunnel-relay-error");
    if (entry?.kind === "tunnel-relay-error") {
      expect(entry.code).toBe("client-aborted");
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
