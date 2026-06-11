import {
  encodeTunnelMessage,
  parseTunnelMessage,
  type TunnelReq,
  type TunnelRes,
} from "./messages.js";

/**
 * Subscription-side handler shape. Mirrors `TunnelSubscription`
 * exported from `./router-bridge.ts` — kept here as a separate
 * local interface so `tunnel-client.ts` stays independent of
 * router-bridge's router-typing. Callers (agents) build these via
 * `createTunnelSubscriptionHandler(router, ctxFn)`.
 */
export interface TunnelSubscriptionHandle {
  subscribe(handlers: {
    onEvent: (data: unknown) => void;
    onError: (err: Error) => void;
    onComplete: () => void;
  }): { cancel: () => void };
}

export type HandleSubscriptionFn = (req: TunnelReq) => TunnelSubscriptionHandle;

/**
 * Agent-side (node) reverse-tunnel client.
 *
 * Dials central's `/tunnel` WebSocket, sends a hello frame carrying
 * bearer + nodeName, handles inbound `req` frames by calling the
 * caller-supplied `handleRequest` and shipping back a `res` frame,
 * maintains a ping/pong heartbeat, and auto-reconnects with
 * jittered exponential backoff when the link drops.
 *
 * I.3.2 adds to the I.3.1 proof:
 *   - start()/stop() lifecycle replaces connect()/close(). start()
 *     kicks off the reconnect loop and resolves on first hello-ack
 *     (or rejects after `initialAttemptTimeoutMs`).
 *   - heartbeat: every `intervalMs` the client pings the server;
 *     missed pong within `timeoutMs` forces a reconnect.
 *   - reconnect: exponential backoff with jitter, capped at
 *     `maxDelayMs`. Resets to `minDelayMs` after a healthy hello-ack.
 *   - onStateChange observability: connecting | ready | disconnected
 *     | stopped. Useful for the `llamactl agent tunnel-test` CLI + a
 *     future Electron dashboard tile.
 */

export interface TunnelReconnectConfig {
  minDelayMs?: number; // default 1000
  maxDelayMs?: number; // default 60000
  jitterFraction?: number; // default 0.2 (±20%)
}

export interface TunnelHeartbeatConfig {
  /** Interval between client-initiated pings. Default 25000 (tighter
   *  than most LBs' 60s idle-timeout). 0 disables heartbeat. */
  intervalMs?: number;
  /** Max wait for a pong before declaring the link dead + reconnecting.
   *  Default 5000. */
  timeoutMs?: number;
}

export type TunnelState = "connecting" | "ready" | "disconnected" | "stopped";

export interface TunnelClientOptions {
  url: string;
  bearer: string;
  nodeName: string;
  /** Invoked for each inbound req; returned value is packaged as a
   *  success `res`. Throw to send an error `res`. */
  handleRequest: (req: TunnelReq) => Promise<unknown>;
  /** Invoked for each inbound req whose `params.type === 'subscription'`.
   *  Returns a subscription handle whose `.subscribe()` wires the
   *  tunnel client's event/error/complete callbacks; the handle's
   *  `cancel()` runs when central sends a stream-cancel frame (or
   *  the ws disconnects). When absent, subscription reqs error back
   *  with `code: 'subscription-unsupported'`. */
  handleSubscription?: HandleSubscriptionFn;
  /** Override for tests. Defaults to the global WebSocket. */
  WebSocketCtor?: ClientWebSocketConstructor;
  /** Per-close observer. Fires on every socket close (including
   *  reconnects), not just the final stop(). */
  onClose?: (code: number, reason: string) => void;
  onStateChange?: (state: TunnelState) => void;
  /** ms to wait for the hello-ack on each connection attempt before
   *  treating it as failed. Defaults to 5 s. */
  helloAckTimeoutMs?: number;
  /** start() rejects if the FIRST attempt doesn't reach `ready`
   *  within this budget. Subsequent attempts use helloAckTimeoutMs
   *  and don't reject start(); they just schedule another backoff.
   *  Default 10000. Set 0 to resolve start() immediately without
   *  waiting for the first hello-ack (pure background mode). */
  initialAttemptTimeoutMs?: number;
  reconnect?: TunnelReconnectConfig;
  heartbeat?: TunnelHeartbeatConfig;
}

export interface TunnelClient {
  /** Kick off the reconnect loop. Resolves on first hello-ack (or on
   *  start if initialAttemptTimeoutMs === 0). */
  start(): Promise<void>;
  /** Stop the reconnect loop + close the socket. Idempotent. */
  stop(code?: number, reason?: string): void;
  /** Send a ping; resolves when the matching pong arrives. */
  ping(nonce?: string, timeoutMs?: number): Promise<void>;
  /** Wait for the next `ready` state (resolves immediately if already
   *  ready). Rejects after `timeoutMs`. */
  waitUntilReady(timeoutMs?: number): Promise<void>;
  isReady(): boolean;
  state(): TunnelState;
}

const ACK_TIMEOUT_DEFAULT = 5000;
const INITIAL_ATTEMPT_TIMEOUT_DEFAULT = 10000;

interface ClientWebSocket {
  onmessage: ((ev: { data: string | Buffer }) => void) | null;
  onopen: (() => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ClientWebSocketConstructor = new (url: string) => ClientWebSocket;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: Error, fallback: string): string {
  return "code" in err ? String(err.code) : fallback;
}

interface TunnelClientContext {
  opts: TunnelClientOptions;
  WS: ClientWebSocketConstructor;
  reconnectCfg: { minDelayMs: number; maxDelayMs: number; jitterFraction: number };
  heartbeatCfg: { intervalMs: number; timeoutMs: number };
  ws: ClientWebSocket | null;
  state: TunnelState;
  stopped: boolean;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pendingPings: Map<string, { resolve: () => void; reject: (err: Error) => void }>;
  readyWaiters: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }[];
  firstAttemptResolver: { resolve: () => void; reject: (err: Error) => void } | null;
  /** Active subscription teardowns keyed by req.id. On stream-cancel
   *  from central (or any disconnect path), we call cancel() and
   *  drop the entry; the subscription's onComplete/onError still
   *  fires through the normal router-bridge handler so the server
   *  side of the tunnel gets its terminal stream-done frame. */
  activeSubscriptions: Map<string, { cancel: () => void }>;
}

function setState(ctx: TunnelClientContext, next: TunnelState): void {
  if (ctx.state === next) return;
  ctx.state = next;
  ctx.opts.onStateChange?.(next);
  if (next === "ready") {
    for (const w of ctx.readyWaiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve();
    }
  }
}

function detachSocket(ws: ClientWebSocket): void {
  try {
    ws.onmessage = null;
  } catch {
    /* ignore */
  }
  try {
    ws.onopen = null;
  } catch {
    /* ignore */
  }
  try {
    ws.onclose = null;
  } catch {
    /* ignore */
  }
  try {
    ws.onerror = null;
  } catch {
    /* ignore */
  }
  try {
    ws.close();
  } catch {
    /* ignore */
  }
}

function cleanupSocket(ctx: TunnelClientContext): void {
  if (ctx.ws) {
    detachSocket(ctx.ws);
    ctx.ws = null;
  }
  if (ctx.heartbeatTimer) {
    clearInterval(ctx.heartbeatTimer);
    ctx.heartbeatTimer = null;
  }
  for (const { reject } of ctx.pendingPings.values()) {
    reject(new Error("tunnel-disconnected"));
  }
  ctx.pendingPings.clear();
  // Tear down any in-flight subscriptions — the source observable
  // gets aborted so background work stops, and future stream-cancel
  // frames from central (which won't arrive anyway) would have no
  // subscription to cancel. The router-bridge handler's
  // onComplete/onError terminal still fires but the ws.send that
  // would ship stream-done silently fails (swallowed below).
  for (const { cancel } of ctx.activeSubscriptions.values()) {
    try {
      cancel();
    } catch {
      /* ignore */
    }
  }
  ctx.activeSubscriptions.clear();
}

function computeBackoff(ctx: TunnelClientContext): number {
  const base = Math.min(
    ctx.reconnectCfg.maxDelayMs,
    ctx.reconnectCfg.minDelayMs * Math.pow(2, Math.max(0, ctx.attempt - 1)),
  );
  const jitter = base * ctx.reconnectCfg.jitterFraction;
  return Math.max(0, base + (Math.random() * 2 - 1) * jitter);
}

function scheduleReconnect(ctx: TunnelClientContext): void {
  if (ctx.stopped) return;
  if (ctx.reconnectTimer) return;
  const delay = computeBackoff(ctx);
  ctx.reconnectTimer = setTimeout(() => {
    ctx.reconnectTimer = null;
    if (ctx.stopped) return;
    doConnect(ctx);
  }, delay);
}

function startHeartbeat(ctx: TunnelClientContext): void {
  if (ctx.heartbeatCfg.intervalMs <= 0) return;
  ctx.heartbeatTimer = setInterval(() => {
    if (ctx.state !== "ready") return;
    const nonce = `hb-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      ctx.pendingPings.delete(nonce);
      // Miss → force reconnect. Close the current socket; the
      // onclose path handles the loop.
      try {
        ctx.ws?.close(4000, "heartbeat timeout");
      } catch {
        /* ignore */
      }
    }, ctx.heartbeatCfg.timeoutMs);
    ctx.pendingPings.set(nonce, {
      resolve: () => {
        clearTimeout(timer);
      },
      reject: () => {
        clearTimeout(timer);
      },
    });
    try {
      ctx.ws?.send(encodeTunnelMessage({ type: "ping", nonce }));
    } catch {
      clearTimeout(timer);
      ctx.pendingPings.delete(nonce);
    }
  }, ctx.heartbeatCfg.intervalMs);
}

async function doHandleRequest(ctx: TunnelClientContext, req: TunnelReq): Promise<TunnelRes> {
  try {
    const result = await ctx.opts.handleRequest(req);
    return { type: "res", id: req.id, result };
  } catch (err) {
    return {
      type: "res",
      id: req.id,
      error: { code: "handler-threw", message: errorMessage(err) },
    };
  }
}

/**
 * Fan a subscription req into stream-event frames. `index` stays
 * monotonic per subscription id; the consumer (central) uses it
 * to gap-detect in future replay-aware variants. On completion
 * or error, ship exactly one stream-done then release the id.
 */
function doHandleSubscription(ctx: TunnelClientContext, req: TunnelReq): void {
  const handler = ctx.opts.handleSubscription;
  if (!handler) {
    // No subscription handler wired — ship a stream-done immediately
    // so the central side doesn't hang forever. Correlation id
    // stays tied to the originating req.
    try {
      ctx.ws?.send(
        encodeTunnelMessage({
          type: "stream-done",
          id: req.id,
          ok: false,
          error: {
            code: "subscription-unsupported",
            message: "this agent does not have a subscription handler wired",
          },
        }),
      );
    } catch {
      /* ignore */
    }
    return;
  }
  let index = 0;
  let sub: TunnelSubscriptionHandle;
  try {
    sub = handler(req);
  } catch (err) {
    try {
      ctx.ws?.send(
        encodeTunnelMessage({
          type: "stream-done",
          id: req.id,
          ok: false,
          error: {
            code: "subscription-handler-threw",
            message: errorMessage(err),
          },
        }),
      );
    } catch {
      /* ignore */
    }
    return;
  }
  const handle = sub.subscribe({
    onEvent: (data) => {
      try {
        ctx.ws?.send(
          encodeTunnelMessage({
            type: "stream-event",
            id: req.id,
            index: index++,
            data,
          }),
        );
      } catch {
        /* ignore */
      }
    },
    onError: (err) => {
      ctx.activeSubscriptions.delete(req.id);
      try {
        ctx.ws?.send(
          encodeTunnelMessage({
            type: "stream-done",
            id: req.id,
            ok: false,
            error: {
              code: errorCode(err, "subscription-error"),
              message: err.message,
            },
          }),
        );
      } catch {
        /* ignore */
      }
    },
    onComplete: () => {
      ctx.activeSubscriptions.delete(req.id);
      try {
        ctx.ws?.send(
          encodeTunnelMessage({
            type: "stream-done",
            id: req.id,
            ok: true,
          }),
        );
      } catch {
        /* ignore */
      }
    },
  });
  ctx.activeSubscriptions.set(req.id, handle);
}

function doConnect(ctx: TunnelClientContext): void {
  if (ctx.stopped) return;
  ctx.attempt++;
  setState(ctx, "connecting");
  const ackTimeout = ctx.opts.helloAckTimeoutMs ?? ACK_TIMEOUT_DEFAULT;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  let newWs: ClientWebSocket;
  try {
    newWs = new ctx.WS(ctx.opts.url);
    ctx.ws = newWs;
  } catch (err) {
    setState(ctx, "disconnected");
    scheduleReconnect(ctx);
    if (ctx.firstAttemptResolver && ctx.attempt === 1) {
      ctx.firstAttemptResolver.reject(err as Error);
      ctx.firstAttemptResolver = null;
    }
    return;
  }
  ackTimer = setTimeout(() => {
    try {
      ctx.ws?.close();
    } catch {
      /* ignore */
    }
  }, ackTimeout);
  newWs.onopen = (): void => {
    try {
      newWs.send(
        encodeTunnelMessage({
          type: "hello",
          bearer: ctx.opts.bearer,
          nodeName: ctx.opts.nodeName,
        }),
      );
    } catch {
      // close path picks it up
    }
  };
  newWs.onmessage = (ev: { data: string | Buffer }): void => {
    const raw = typeof ev.data === "string" ? ev.data : ev.data.toString("utf8");
    const msg = parseTunnelMessage(raw);
    if (!msg) return;
    if (ctx.state !== "ready") {
      if (msg.type === "hello-ack") {
        if (ackTimer) {
          clearTimeout(ackTimer);
          ackTimer = null;
        }
        ctx.attempt = 0; // reset backoff on a healthy ack
        setState(ctx, "ready");
        startHeartbeat(ctx);
        if (ctx.firstAttemptResolver) {
          ctx.firstAttemptResolver.resolve();
          ctx.firstAttemptResolver = null;
        }
      }
      return;
    }
    if (msg.type === "req") {
      // Inspect params.type to split subscription reqs from
      // query/mutation reqs. Subscription reqs take a distinct
      // path (stream frames) and never write a `res`.
      const params = msg.params as { type?: string } | undefined;
      if (params?.type === "subscription") {
        doHandleSubscription(ctx, msg);
        return;
      }
      void doHandleRequest(ctx, msg).then((res) => {
        try {
          ctx.ws?.send(encodeTunnelMessage(res));
        } catch {
          /* ignore */
        }
      });
      return;
    }
    if (msg.type === "stream-cancel") {
      const handle = ctx.activeSubscriptions.get(msg.id);
      if (handle) {
        ctx.activeSubscriptions.delete(msg.id);
        try {
          handle.cancel();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (msg.type === "pong") {
      const p = ctx.pendingPings.get(msg.nonce);
      if (p) {
        ctx.pendingPings.delete(msg.nonce);
        p.resolve();
      }
      return;
    }
  };
  newWs.onclose = (ev: { code: number; reason: string }): void => {
    if (ackTimer) {
      clearTimeout(ackTimer);
      ackTimer = null;
    }
    const wasFirstAttempt = ctx.firstAttemptResolver !== null && ctx.attempt === 1;
    ctx.opts.onClose?.(ev.code, ev.reason);
    cleanupSocket(ctx);
    setState(ctx, ctx.stopped ? "stopped" : "disconnected");
    if (wasFirstAttempt && ctx.firstAttemptResolver) {
      ctx.firstAttemptResolver.reject(
        new Error(`tunnel closed before hello-ack: ${String(ev.code)} ${ev.reason}`),
      );
      ctx.firstAttemptResolver = null;
    }
    if (!ctx.stopped) scheduleReconnect(ctx);
  };
  newWs.onerror = (): void => {
    // onclose will follow.
  };
}

async function startTunnelClient(ctx: TunnelClientContext): Promise<void> {
  if (ctx.stopped) throw new Error("tunnel client has been stopped");
  const initialBudget = ctx.opts.initialAttemptTimeoutMs ?? INITIAL_ATTEMPT_TIMEOUT_DEFAULT;
  if (initialBudget <= 0) {
    // Background mode — fire and forget.
    doConnect(ctx);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ctx.firstAttemptResolver = null;
      reject(new Error("tunnel start: initial-attempt timeout"));
    }, initialBudget);
    ctx.firstAttemptResolver = {
      resolve: (): void => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err): void => {
        clearTimeout(timer);
        reject(err);
      },
    };
    doConnect(ctx);
  });
}

function stopTunnelClient(ctx: TunnelClientContext, code?: number, reason?: string): void {
  ctx.stopped = true;
  if (ctx.reconnectTimer) {
    clearTimeout(ctx.reconnectTimer);
    ctx.reconnectTimer = null;
  }
  if (ctx.ws) {
    try {
      ctx.ws.close(code ?? 1000, reason ?? "client stop");
    } catch {
      /* ignore */
    }
  }
  cleanupSocket(ctx);
  setState(ctx, "stopped");
  for (const w of ctx.readyWaiters.splice(0)) {
    if (w.timer) clearTimeout(w.timer);
    w.reject(new Error("tunnel client stopped"));
  }
  if (ctx.firstAttemptResolver) {
    ctx.firstAttemptResolver.reject(new Error("tunnel client stopped"));
    ctx.firstAttemptResolver = null;
  }
}

async function pingTunnel(
  ctx: TunnelClientContext,
  nonce?: string,
  timeoutMs = 3000,
): Promise<void> {
  if (ctx.state !== "ready" || !ctx.ws) throw new Error("tunnel not ready");
  const currentWs = ctx.ws;
  const actualNonce = nonce ?? Math.random().toString(36).slice(2);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ctx.pendingPings.delete(actualNonce);
      reject(new Error("ping timeout"));
    }, timeoutMs);
    ctx.pendingPings.set(actualNonce, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    try {
      currentWs.send(encodeTunnelMessage({ type: "ping", nonce: actualNonce }));
    } catch (err) {
      ctx.pendingPings.delete(actualNonce);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function waitUntilTunnelReady(ctx: TunnelClientContext, timeoutMs = 10000): Promise<void> {
  if (ctx.state === "ready") return;
  if (ctx.state === "stopped") throw new Error("tunnel client stopped");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = ctx.readyWaiters.findIndex((w) => w.timer === timer);
      if (i >= 0) ctx.readyWaiters.splice(i, 1);
      reject(new Error(`tunnel waitUntilReady: timeout after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    ctx.readyWaiters.push({ resolve, reject, timer });
  });
}

export function createTunnelClient(opts: TunnelClientOptions): TunnelClient {
  const WebSocketCtor =
    opts.WebSocketCtor ?? (globalThis as { WebSocket?: ClientWebSocketConstructor }).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("createTunnelClient: no WebSocket available — pass WebSocketCtor explicitly");
  }
  const ctx: TunnelClientContext = {
    opts,
    WS: WebSocketCtor,
    reconnectCfg: {
      minDelayMs: opts.reconnect?.minDelayMs ?? 1000,
      maxDelayMs: opts.reconnect?.maxDelayMs ?? 60000,
      jitterFraction: opts.reconnect?.jitterFraction ?? 0.2,
    },
    heartbeatCfg: {
      intervalMs: opts.heartbeat?.intervalMs ?? 25000,
      timeoutMs: opts.heartbeat?.timeoutMs ?? 5000,
    },
    ws: null,
    state: "disconnected",
    stopped: false,
    attempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    pendingPings: new Map(),
    readyWaiters: [],
    firstAttemptResolver: null,
    activeSubscriptions: new Map(),
  };

  return {
    start: () => startTunnelClient(ctx),
    stop: (code?: number, reason?: string): void => {
      stopTunnelClient(ctx, code, reason);
    },
    ping: (nonce, timeoutMs) => pingTunnel(ctx, nonce, timeoutMs),
    waitUntilReady: (timeoutMs) => waitUntilTunnelReady(ctx, timeoutMs),
    isReady: () => ctx.state === "ready",
    state: () => ctx.state,
  };
}
