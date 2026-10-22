import { auth, tunnel } from "@llamactl/remote";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleTunnelRelay } from "../../remote/src/server/tunnel-relay.js";
import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { __resetInsecureTunnelWarning, buildTunnelSubscribe } from "../src/tunnel-dispatch.js";

const { createTunnelClient, createTunnelServer } = tunnel;
const { hashToken } = auth;
type TunnelReq = tunnel.TunnelReq;
type TunnelSubscription = tunnel.TunnelSubscription;

const OVERRIDE_KEY = "LLAMACTL_TUNNEL_JOURNAL";
// Without an explicit path the tunnel server and relay journal to the
// operator's real tunnel journal. The default is pointed into the same
// directory from module load on, before any hook, so a missing path fails
// the file instead of reaching the real journal.
const journalDir = mkdtempSync(join(tmpdir(), "llamactl-cli-tunnel-journal-"));
const journalPath = join(journalDir, "journal.jsonl");
const fallbackJournal = join(journalDir, "default", "journal.jsonl");
const savedOverride = process.env[OVERRIDE_KEY];
process.env[OVERRIDE_KEY] = fallbackJournal;

afterAll(async () => {
  // stop() does not await the server's close handler, which journals the
  // disconnect a moment later and would recreate a directory removed first.
  await new Promise((r) => setTimeout(r, 100));
  if (savedOverride === undefined) Reflect.deleteProperty(process.env, OVERRIDE_KEY);
  else process.env[OVERRIDE_KEY] = savedOverride;
  const leaked = existsSync(fallbackJournal);
  rmSync(journalDir, { recursive: true, force: true });
  if (leaked) {
    throw new Error(
      `a tunnel journal write fell back to ${OVERRIDE_KEY}; pass journalPath explicitly`,
    );
  }
});

/**
 * B.5 coverage — end-to-end subscription over the reverse-tunnel
 * SSE relay. Builds a central agent + dialing client, invokes
 * `buildTunnelSubscribe(...)(method, input, handlers)`, asserts
 * each event streams through `onData` and the terminal `onComplete`
 * fires. Also covers `unsubscribe()` + fail-closed pinning.
 */

interface Harness {
  stop: () => Promise<void>;
  bunPort: number;
  bearer: string;
  receivedCancel: string[];
}

async function startHarness(script: {
  events: unknown[];
  delayMs?: number;
  throwErr?: Error;
}): Promise<Harness> {
  __resetInsecureTunnelWarning();
  const bearer = "relay-bearer";
  const tunnelBearer = "tunnel-bearer";
  const bearerHash = hashToken(bearer);
  const nodeName = "node1";
  const receivedCancel: string[] = [];
  const tunnelSrv = createTunnelServer({
    expectedBearerHash: hashToken(tunnelBearer),
    journalPath,
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
        return await handleTunnelRelay(req, url, tunnelSrv, bearerHash, journalPath);
      }
      return new Response("404", { status: 404 });
    },
    websocket: tunnelSrv.websocket,
  });
  const bunPort = bun.port ?? 0;
  const handleSubscription = (req: TunnelReq): TunnelSubscription => ({
    subscribe(handlers): { cancel(): void } {
      const cancelled = { value: false };
      const isCancelled = (): boolean => cancelled.value;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Preserve existing CLI/test semantics while clearing strict lint debt.
      (async (): Promise<void> => {
        for (const ev of script.events) {
          if (cancelled.value) break;
          await new Promise((r) => setTimeout(r, script.delayMs ?? 2));
          if (isCancelled()) break;
          handlers.onEvent(ev);
        }
        if (cancelled.value) {
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
          cancelled.value = true;
          receivedCancel.push(req.id);
        },
      };
    },
  });
  const client = createTunnelClient({
    url: `ws://127.0.0.1:${String(bunPort)}/tunnel`,
    bearer: tunnelBearer,
    nodeName,
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    handleRequest: async () => ({}),
    handleSubscription,
    initialAttemptTimeoutMs: 2000,
    heartbeat: { intervalMs: 0 },
  });
  await client.start();
  return {
    bunPort,
    bearer,
    receivedCancel,
    async stop(): Promise<void> {
      client.stop();
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Preserve existing CLI/test semantics while clearing strict lint debt.
      bun.stop();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}

describe("buildTunnelSubscribe end-to-end", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await harness.stop();
    harness = null;
  });

  test("streams events + onComplete", async () => {
    harness = await startHarness({
      events: [{ i: 0 }, { i: 1 }, { i: 2 }],
    });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${String(harness.bunPort)}`,
      bearer: harness.bearer,
      nodeName: "node1",
      insecure: true,
    });
    const events: unknown[] = [];
    let completed = false;
    let started = false;
    let error: unknown = null;
    const handle = sub("tick", null, {
      onStarted: () => {
        started = true;
      },
      onData: (e) => events.push(e),
      onComplete: () => {
        completed = true;
      },
      onError: (err) => {
        error = err;
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.unsubscribe();
    expect(error).toBeNull();
    expect(completed).toBe(true);
    expect(started).toBe(true);
    expect(events).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  test("agent-side error propagates to onError", async () => {
    harness = await startHarness({
      events: [{ only: 1 }],
      throwErr: Object.assign(new Error("agent-failure"), { code: "E42" }),
    });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${String(harness.bunPort)}`,
      bearer: harness.bearer,
      nodeName: "node1",
      insecure: true,
    });
    let error: Error | null = null;
    let completed = false;
    const events: unknown[] = [];
    sub("boom", null, {
      onData: (e) => events.push(e),
      onError: (err) => {
        error = err as Error;
      },
      onComplete: () => {
        completed = true;
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([{ only: 1 }]);
    expect(completed).toBe(false);
    expect(error).not.toBeNull();
    expect((error as unknown as Error).message).toBe("agent-failure");
  });

  test("unsubscribe() aborts mid-stream + agent sees stream-cancel", async () => {
    harness = await startHarness({
      events: Array.from({ length: 40 }, (_, i) => ({ i })),
      delayMs: 15,
    });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${String(harness.bunPort)}`,
      bearer: harness.bearer,
      nodeName: "node1",
      insecure: true,
    });
    const events: unknown[] = [];
    const handle = sub("long", null, {
      onData: (e) => events.push(e),
      onError: () => {
        return;
      },
      onComplete: () => {
        return;
      },
    });
    // Let a couple of events land.
    await new Promise((r) => setTimeout(r, 50));
    handle.unsubscribe();
    await new Promise((r) => setTimeout(r, 150));
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(40);
    expect(harness.receivedCancel.length).toBeGreaterThan(0);
  });

  test("pinning fail-closed without fingerprint + not insecure", async () => {
    harness = await startHarness({ events: [] });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${String(harness.bunPort)}`,
      bearer: harness.bearer,
      nodeName: "node1",
      // insecure: false (default)
    });
    let error: Error | null = null;
    sub("tick", null, {
      onData: () => {
        return;
      },
      onError: (err) => {
        error = err as Error;
      },
      onComplete: () => {
        return;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(error).not.toBeNull();
    expect((error as unknown as Error).message).toContain("tunnelCentralFingerprint");
  });

  test("unsubscribe() before any events is a clean no-op", async () => {
    harness = await startHarness({
      events: Array.from({ length: 10 }, (_, i) => ({ i })),
      delayMs: 20,
    });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${String(harness.bunPort)}`,
      bearer: harness.bearer,
      nodeName: "node1",
      insecure: true,
    });
    const handle = sub("tick", null, {
      onData: () => {
        return;
      },
      onError: () => {
        return;
      },
      onComplete: () => {
        return;
      },
    });
    handle.unsubscribe();
    // Second unsubscribe is idempotent.
    handle.unsubscribe();
    await new Promise((r) => setTimeout(r, 50));
    // No assertions here; the unsubscribe must not throw.
    expect(true).toBe(true);
  });
});
