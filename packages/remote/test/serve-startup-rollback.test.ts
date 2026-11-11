/**
 * #278 DF-05 + the #621 review follow-up: when `startAgentServer` throws
 * partway through startup — here a missing TLS cert at bind time — the
 * early steps it already ran (the process fatal handlers, the search
 * ingest, the peer-snapshot poller) must be rolled back, and a rollback
 * step that itself throws must neither mask the original error nor skip
 * the remaining steps.
 *
 * (a)-(d) are RED on main at 91fc6ec6: the throw escapes with the
 * handlers, poller and ingest left running. (g) is RED there too: the
 * tunnel client was recorded for rollback only after start() returned, so
 * a start that throws leaked it. (h) is RED there: a start that fails
 * before it starts the search ingest leaks its handlers. (e) and (f) are
 * success-path pins — green at main, must stay green.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SearchIngestStop } from "../src/search/ingest/lifecycle.js";
import type { PeerSnapshotPollerOptions } from "../src/server/peer-snapshot-poller.js";
import type { RunningAgent, StartAgentOptions } from "../src/server/serve.js";
import type { TunnelClient, TunnelClientOptions } from "../src/tunnel/index.js";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { generateToken } from "../src/server/auth.js";

// mock.module is process-global in this repo: snapshot the real exports
// before registering the wrappers so every other export stays linkable
// (DEFAULT_PEER_FETCH_TIMEOUT_MS, __peerSnapshotInternals) and the real
// modules can be restored for later test files in this bun process.
const pollerReal = { ...(await import("../src/server/peer-snapshot-poller.js")) };
const ingestReal = { ...(await import("../src/search/ingest/lifecycle.js")) };
const tunnelReal = { ...(await import("../src/tunnel/index.js")) };

let pollerStops = 0;
let ingestStarts = 0;
let ingestStops = 0;
let throwNext = false;
// (g): createTunnelClient hands back a client whose start() throws
// synchronously, standing in for any throw after the client exists.
let fakeTunnelClient = false;
let tunnelStops = 0;
// (h): startSearchIngest throws synchronously, so the start fails before
// this call has started any ingest.
let throwIngestStart = false;
// realStop functions of pollers a failed start leaked; afterEach calls
// and clears them so no interval survives into the next test.
const liveStops: (() => void)[] = [];
const runningAgents: RunningAgent[] = [];

const wrappedPollerStart = (opts?: PeerSnapshotPollerOptions): (() => void) => {
  const realStop = pollerReal.startPeerSnapshotPoller(opts);
  liveStops.push(realStop);
  return () => {
    pollerStops += 1;
    realStop();
    const at = liveStops.indexOf(realStop);
    if (at !== -1) liveStops.splice(at, 1);
  };
};

// startAgentServer stops its ingest through the handle startSearchIngest
// returns (#634), so the stop count lives on the handle. Like the real
// handle it is idempotent: only its first call counts.
const wrappedIngestStart = (): SearchIngestStop => {
  ingestStarts += 1;
  if (throwIngestStart) throw new Error("ingest start boom");
  const realStop = ingestReal.startSearchIngest();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    ingestStops += 1;
    realStop();
    if (throwNext) {
      throwNext = false;
      throw new Error("ingest stop boom");
    }
  };
};

const wrappedCreateTunnelClient = (opts: TunnelClientOptions): TunnelClient => {
  if (!fakeTunnelClient) return tunnelReal.createTunnelClient(opts);
  return {
    start: () => {
      throw new Error("tunnel start boom");
    },
    stop: () => {
      tunnelStops += 1;
    },
  } as unknown as TunnelClient;
};

await mock.module("../src/server/peer-snapshot-poller.js", () => ({
  ...pollerReal,
  startPeerSnapshotPoller: wrappedPollerStart,
}));
await mock.module("../src/search/ingest/lifecycle.js", () => ({
  ...ingestReal,
  startSearchIngest: wrappedIngestStart,
}));
await mock.module("../src/tunnel/index.js", () => ({
  ...tunnelReal,
  createTunnelClient: wrappedCreateTunnelClient,
}));

const { startAgentServer } = await import("../src/server/serve.js");

afterAll(() => {
  void mock.module("../src/server/peer-snapshot-poller.js", () => pollerReal);
  void mock.module("../src/search/ingest/lifecycle.js", () => ingestReal);
  void mock.module("../src/tunnel/index.js", () => tunnelReal);
});

type FatalEvent = "uncaughtException" | "unhandledRejection";
type FatalListener<E extends FatalEvent> = (...args: process.ProcessEventMap[E]) => void;

let uncaughtSnapshot: FatalListener<"uncaughtException">[] = [];
let unhandledSnapshot: FatalListener<"unhandledRejection">[] = [];
let uncaughtBaseline = 0;
let unhandledBaseline = 0;

function removeListenersAddedSince<E extends FatalEvent>(
  event: E,
  snapshot: readonly FatalListener<E>[],
): void {
  for (const listener of process.listeners(event)) {
    if (!snapshot.includes(listener)) {
      process.off(event, listener);
    }
  }
}

function startOptions(withMissingTls: boolean): StartAgentOptions {
  return {
    tokenHash: generateToken().hash,
    bindHost: "127.0.0.1",
    port: 0,
    advertiseMdns: false,
    peerSnapshotPoll: true,
    peerSnapshotPollIntervalMs: 60_000,
    ...(withMissingTls
      ? {
          tls: {
            certPath: join(tmpdir(), `llamactl-missing-${randomUUID()}.crt`),
            keyPath: join(tmpdir(), `llamactl-missing-${randomUUID()}.key`),
          },
        }
      : {}),
  };
}

function startTracked(options: StartAgentOptions): RunningAgent {
  const agent = startAgentServer(options);
  runningAgents.push(agent);
  return agent;
}

const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMACTL_CONFIG"] as const;
let temp: ReturnType<typeof makeTempRuntime>;
const envBackup: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) {
    envBackup[key] = process.env[key];
  }
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  process.env["DEV_STORAGE"] = tempEnv["DEV_STORAGE"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = tempEnv["LOCAL_AI_RUNTIME_DIR"];
  process.env["LLAMACTL_CONFIG"] = join(temp.devStorage, "llamactl-config.json");
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const prev = envBackup[key];
    if (prev === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = prev;
    }
  }
  temp.cleanup();
});

beforeEach(() => {
  pollerStops = 0;
  ingestStarts = 0;
  ingestStops = 0;
  throwNext = false;
  fakeTunnelClient = false;
  tunnelStops = 0;
  throwIngestStart = false;
  uncaughtSnapshot = process.listeners("uncaughtException");
  unhandledSnapshot = process.listeners("unhandledRejection");
  uncaughtBaseline = uncaughtSnapshot.length;
  unhandledBaseline = unhandledSnapshot.length;
});

afterEach(async () => {
  throwNext = false;
  fakeTunnelClient = false;
  throwIngestStart = false;
  for (const agent of runningAgents.splice(0)) {
    await agent.stop();
  }
  removeListenersAddedSince("uncaughtException", uncaughtSnapshot);
  removeListenersAddedSince("unhandledRejection", unhandledSnapshot);
  for (const stop of liveStops.splice(0)) {
    stop();
  }
});

describe("startAgentServer startup rollback (#278 DF-05)", () => {
  test("(a) a failed start removes the process handlers it installed", () => {
    expect(() => startAgentServer(startOptions(true))).toThrow("cert not found");
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBaseline);
    expect(process.listenerCount("unhandledRejection")).toBe(unhandledBaseline);
  });

  test("(b) a failed start stops the poller and the search ingest it started", () => {
    expect(() => startAgentServer(startOptions(true))).toThrow("cert not found");
    expect(pollerStops).toBe(1);
    expect(ingestStops).toBe(1);
  });

  test("(c) repeated failed starts roll back every time", () => {
    expect(() => startAgentServer(startOptions(true))).toThrow("cert not found");
    expect(() => startAgentServer(startOptions(true))).toThrow("cert not found");
    expect(() => startAgentServer(startOptions(true))).toThrow("cert not found");
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBaseline);
    expect(process.listenerCount("unhandledRejection")).toBe(unhandledBaseline);
    expect(pollerStops).toBe(3);
    expect(liveStops).toHaveLength(0);
  });

  test("(d) a throwing rollback step keeps the original error and runs the rest", () => {
    throwNext = true;
    expect(() => startAgentServer(startOptions(true))).toThrow("cert not found");
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBaseline);
    expect(process.listenerCount("unhandledRejection")).toBe(unhandledBaseline);
    expect(pollerStops).toBe(1);
    expect(ingestStops).toBe(1);
  });

  test("(e) pin: stop() on a successful start rolls back handlers, poller and ingest", async () => {
    const agent = startTracked(startOptions(false));
    expect(pollerStops).toBe(0);
    expect(ingestStops).toBe(0);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBaseline + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(unhandledBaseline + 1);
    await agent.stop();
    expect(pollerStops).toBe(1);
    expect(ingestStops).toBe(1);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBaseline);
    expect(process.listenerCount("unhandledRejection")).toBe(unhandledBaseline);
  });

  test("(f) pin: a plain-loopback agent exposes no tunnel handles", async () => {
    const agent = startTracked(startOptions(false));
    expect(agent).not.toHaveProperty("tunnelClient");
    expect(agent).not.toHaveProperty("tunnelServer");
    expect(agent.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await agent.stop();
  });

  test("(g) a throw after the tunnel client exists stops it and keeps the error", () => {
    fakeTunnelClient = true;
    expect(() =>
      startAgentServer({
        ...startOptions(false),
        tunnelDial: { url: "ws://127.0.0.1:1/tunnel", bearer: "b", nodeName: "n" },
      }),
    ).toThrow("tunnel start boom");
    expect(tunnelStops).toBe(1);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBaseline);
    expect(process.listenerCount("unhandledRejection")).toBe(unhandledBaseline);
    expect(pollerStops).toBe(1);
    expect(ingestStops).toBe(1);
  });

  test("(h) a start that fails before its ingest leaves another agent's ingest running", async () => {
    const running = startTracked(startOptions(false));
    expect(ingestStarts).toBe(1);
    throwIngestStart = true;
    expect(() => startAgentServer(startOptions(false))).toThrow("ingest start boom");
    expect(ingestStarts).toBe(2);
    expect(ingestStops).toBe(0);
    expect(pollerStops).toBe(0);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBaseline + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(unhandledBaseline + 1);
    await running.stop();
    expect(ingestStops).toBe(1);
  });
});
