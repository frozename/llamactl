import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { hashToken } from "../src/server/auth.js";
import {
  createTunnelClient,
  createTunnelServer,
  type TunnelClient,
  type TunnelReq,
  type TunnelServer,
  type TunnelSubscription,
} from "../src/tunnel/index.js";

/**
 * #192 — the tunnel client's idle signal. Agent stop() keeps the tunnel
 * up until it is idle, so a request counts until its `res` is sent and a
 * subscription until its stream-done is sent, including after central
 * cancelled it.
 */

const BEARER = "idle-bearer";
const NODE = "idle-node";

interface Harness {
  server: TunnelServer;
  client: TunnelClient;
  cancelAcks: string[];
}

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

async function connect(
  handlers: {
    handleRequest?: (req: TunnelReq) => Promise<unknown>;
    handleSubscription?: (req: TunnelReq) => TunnelSubscription;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "tunnel-idle-"));
  const cancelAcks: string[] = [];
  const server = createTunnelServer({
    expectedBearerHash: hashToken(BEARER),
    journalPath: join(dir, "journal.jsonl"),
    onStreamCancelAck: (_node, _id, outcome) => {
      cancelAcks.push(outcome);
    },
  });
  const bun = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      return server.handleUpgrade(req, srv) ?? new Response("404", { status: 404 });
    },
    websocket: server.websocket,
  });
  stops.push(() => {
    void bun.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  const client = createTunnelClient({
    url: `ws://127.0.0.1:${String(bun.port ?? 0)}/tunnel`,
    bearer: BEARER,
    nodeName: NODE,
    handleRequest: handlers.handleRequest ?? ((): Promise<unknown> => Promise.resolve(null)),
    ...(handlers.handleSubscription !== undefined
      ? { handleSubscription: handlers.handleSubscription }
      : {}),
    initialAttemptTimeoutMs: 2_000,
    heartbeat: { intervalMs: 0 },
  });
  await client.start();
  stops.push(() => {
    client.stop();
  });
  return { server, client, cancelAcks };
}

/** Whether `promise` has settled once a macrotask has passed. */
async function settledSoon(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return settled;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("tunnel client: whenIdle (#192)", () => {
  test("resolves at once when nothing is in flight", async () => {
    const { client } = await connect();
    expect(await settledSoon(client.whenIdle())).toBe(true);
  });

  test("a request counts until its res is sent", async () => {
    const arrived = deferred();
    const answer = deferred();
    const { server, client } = await connect({
      handleRequest: async (): Promise<unknown> => {
        arrived.resolve();
        await answer.promise;
        return "late";
      },
    });
    const res = server.send(NODE, { id: "req-1", method: "inferenceRpc.status", params: {} });
    await arrived.promise;
    const idle = client.whenIdle();
    expect(await settledSoon(idle)).toBe(false);
    answer.resolve();
    expect(await res).toMatchObject({ id: "req-1", result: "late" });
    expect(await settledSoon(idle)).toBe(true);
  });

  test("waits for every request in flight, not only the first to finish", async () => {
    const answers = new Map([
      ["req-a", deferred()],
      ["req-b", deferred()],
    ]);
    let arrivals = 0;
    const { server, client } = await connect({
      handleRequest: async (req): Promise<unknown> => {
        arrivals += 1;
        await answers.get(req.id)?.promise;
        return req.id;
      },
    });
    const first = server.send(NODE, { id: "req-a", method: "inferenceRpc.status", params: {} });
    const second = server.send(NODE, { id: "req-b", method: "inferenceRpc.status", params: {} });
    await until(() => arrivals === 2);
    const idle = client.whenIdle();
    answers.get("req-a")?.resolve();
    expect(await first).toMatchObject({ id: "req-a", result: "req-a" });
    expect(await settledSoon(idle)).toBe(false);
    answers.get("req-b")?.resolve();
    expect(await second).toMatchObject({ id: "req-b", result: "req-b" });
    expect(await settledSoon(idle)).toBe(true);
  });

  test("a subscription central cancelled counts until its stream-done acknowledges the cancel", async () => {
    const cancelled = deferred();
    let acknowledge = (): void => undefined;
    const { server, client, cancelAcks } = await connect({
      handleSubscription: (): TunnelSubscription => ({
        subscribe(handlers): { cancel: () => void } {
          handlers.onEvent("first");
          acknowledge = (): void => {
            handlers.onError(Object.assign(new Error("cancelled"), { code: "stream-cancelled" }));
          };
          return {
            cancel: (): void => {
              cancelled.resolve();
            },
          };
        },
      }),
    });
    for await (const event of server.sendSubscribe(NODE, {
      id: "sub-1",
      method: "inferenceRpc.stream",
      params: { type: "subscription", input: null },
    })) {
      expect(event).toBe("first");
      break;
    }
    await cancelled.promise;
    const idle = client.whenIdle();
    expect(await settledSoon(idle)).toBe(false);
    acknowledge();
    expect(await settledSoon(idle)).toBe(true);
    await until(() => cancelAcks.length > 0);
    expect(cancelAcks).toEqual(["cancelled"]);
  });

  test("a subscription that completes counts until its stream-done is sent", async () => {
    const opened = deferred();
    let complete = (): void => undefined;
    const { server, client } = await connect({
      handleSubscription: (): TunnelSubscription => ({
        subscribe(handlers): { cancel: () => void } {
          opened.resolve();
          complete = (): void => {
            handlers.onComplete();
          };
          return {
            cancel: (): void => undefined,
          };
        },
      }),
    });
    const events = server.sendSubscribe(NODE, {
      id: "sub-done",
      method: "inferenceRpc.stream",
      params: { type: "subscription", input: null },
    });
    const drained = (async (): Promise<void> => {
      for await (const _ of events) {
        // The stream ends without an event.
      }
    })();
    await opened.promise;
    const idle = client.whenIdle();
    expect(await settledSoon(idle)).toBe(false);
    complete();
    expect(await settledSoon(idle)).toBe(true);
    await drained;
  });

  test("stop() releases a pending wait", async () => {
    const opened = deferred();
    const { server, client } = await connect({
      handleSubscription: (): TunnelSubscription => ({
        subscribe(): { cancel: () => void } {
          opened.resolve();
          return {
            cancel: (): void => undefined,
          };
        },
      }),
    });
    const events = server.sendSubscribe(NODE, {
      id: "sub-open",
      method: "inferenceRpc.stream",
      params: { type: "subscription", input: null },
    });
    const drained = (async (): Promise<void> => {
      for await (const _ of events) {
        // A subscription that never ends.
      }
    })().catch(() => undefined);
    await opened.promise;
    const idle = client.whenIdle();
    expect(await settledSoon(idle)).toBe(false);
    client.stop();
    expect(await settledSoon(idle)).toBe(true);
    expect(await settledSoon(client.whenIdle())).toBe(true);
    await drained;
  });

  test("a dropped socket releases a pending wait without stop()", async () => {
    const arrived = deferred();
    const answer = deferred();
    const { server, client } = await connect({
      handleRequest: async (): Promise<unknown> => {
        arrived.resolve();
        await answer.promise;
        return "unsent";
      },
    });
    const res = server
      .send(NODE, { id: "req-drop", method: "inferenceRpc.status", params: {} })
      .then(
        () => "answered",
        () => "failed",
      );
    await arrived.promise;
    const idle = client.whenIdle();
    expect(await settledSoon(idle)).toBe(false);
    expect(server.disconnect(NODE)).toBe(true);
    await until(() => client.state() === "disconnected");
    expect(await settledSoon(idle)).toBe(true);
    expect(await res).toBe("failed");
    answer.resolve();
  });
});
