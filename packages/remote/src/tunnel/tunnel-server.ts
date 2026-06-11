import { hashToken } from "../server/auth.js";
import {
  appendTunnelJournal,
  defaultTunnelJournalPath,
  type TunnelJournalEntry,
} from "./journal.js";
import {
  encodeTunnelMessage,
  parseTunnelMessage,
  TUNNEL_CLOSE_BAD_HELLO,
  TUNNEL_CLOSE_HELLO_TIMEOUT,
  TUNNEL_CLOSE_UNAUTHORIZED,
  type TunnelMessage,
  type TunnelReq,
  type TunnelRes,
} from "./messages.js";

/**
 * Subscription state tracked per correlation id. Kept in a
 * distinct Map from `pending` (req/res) so late stream-event frames
 * never mis-resolve a query/mutation promise, and vice versa.
 *
 *   push(data)  — called on every stream-event frame.
 *   done(error?) — called on the stream-done frame; undefined error
 *                  means clean completion.
 */
interface SubscriptionHandlers {
  push: (value: unknown) => void;
  done: (error?: { code: string; message: string }) => void;
}

/**
 * Central-side (control plane) reverse-tunnel server.
 *
 * Exposes the three pieces Bun.serve requires — a `fetch`
 * handler that upgrades `/tunnel` requests to WebSocket and a
 * `websocket` config with event callbacks — wired together with an
 * in-memory node registry. The router consuming this module can
 * call `registry.send(nodeName, req)` to dispatch a request onto
 * a connected node and receive the response via the returned
 * promise.
 *
 * Scope of I.3.1 (transport proof):
 *   - authenticate via first-message bearer (sha-256 hash compare)
 *   - track {nodeName → ws} with duplicate-name override semantics
 *     (newest connection wins, older is closed with code 4409 so the
 *     operator sees a clean "replaced by another agent" reason)
 *   - correlate responses by id
 *   - reject malformed frames with a clear close code
 *
 * Reconnect heuristics, heartbeat, soak testing land in I.3.2. This
 * module is intentionally stateless-between-connections — a reboot
 * of central drops all tunnels; agents reconnect on their side.
 */

const HELLO_TIMEOUT_MS = 5000;
const TUNNEL_CLOSE_REPLACED = 4409;

export interface TunnelRegistryEntry {
  nodeName: string;
  connectedAt: string;
  send: (req: TunnelReq) => Promise<TunnelRes>;
  close: (code?: number, reason?: string) => void;
}

interface BunServerWebSocket {
  data: unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface BunUpgradeServer {
  upgrade(req: Request, opts: { data: ConnectionState }): boolean;
}

interface ConnectionState {
  authenticated: boolean;
  nodeName: string | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  pending: Map<string, { resolve: (r: TunnelRes) => void; reject: (err: Error) => void }>;
  subscriptions: Map<string, SubscriptionHandlers>;
}

export interface TunnelServerOptions {
  /** Hex-encoded sha-256 of the expected bearer token. */
  expectedBearerHash: string;
  onNodeConnect?: (nodeName: string) => void;
  onNodeDisconnect?: (nodeName: string, reason: string) => void;
  /** Defaults to Date.now-driven id; override for tests. */
  clock?: () => Date;
  /** Path to the JSONL audit journal. Defaults to
   *  `defaultTunnelJournalPath()` (`~/.llamactl/tunnel/journal.jsonl`
   *  or the `$LLAMACTL_TUNNEL_JOURNAL` / `$DEV_STORAGE` overrides).
   *  Every connect, disconnect, unauthorized hello, and replaced
   *  connection emits one line. */
  journalPath?: string;
}

export interface TunnelServer {
  /** Used by Bun.serve's `fetch` handler for WebSocket upgrades. */
  handleUpgrade: (req: Request, server: BunUpgradeServer) => Response | undefined;
  /** Plugs straight into `Bun.serve({ websocket })`. */
  websocket: {
    open: (ws: BunServerWebSocket) => void;
    message: (ws: BunServerWebSocket, data: string | Buffer) => void;
    close: (ws: BunServerWebSocket, code: number, reason: string) => void;
  };
  send: (nodeName: string, req: Omit<TunnelReq, "type">) => Promise<TunnelRes>;
  /**
   * Open a streaming subscription to a node. Ships a `req` frame
   * with `params.type === 'subscription'` and returns an
   * AsyncIterable that yields each `stream-event.data` payload the
   * node pushes back. The iterable terminates when a `stream-done`
   * frame arrives (normal completion) or throws with the propagated
   * error code + message when the node reports a failure. Calling
   * the iterator's `.return()` (e.g. by breaking out of a
   * `for await`) sends a `stream-cancel` back to the node and
   * releases the correlation-id slot.
   */
  sendSubscribe: (nodeName: string, req: Omit<TunnelReq, "type">) => AsyncIterable<unknown>;
  registry: () => TunnelRegistryEntry[];
  /** Force-close a node's tunnel; primarily for tests + operator
   *  "agent tunnel kick" tooling. */
  disconnect: (nodeName: string, reason?: string) => boolean;
}

/**
 * Construct an AsyncIterable wrapping a subscription-over-tunnel.
 * Push-pull model: incoming stream-event frames are buffered, each
 * `next()` drains the buffer or awaits a Deferred. A terminal
 * stream-done resolves the iterator as either "complete" or throws
 * with the agent-reported error. Iterator `return()` ships a
 * stream-cancel frame and releases the correlation-id slot so a
 * later event after cancel is silently dropped.
 */
function buildSubscriptionIterable(
  ws: BunServerWebSocket,
  state: ConnectionState,
  req: TunnelReq,
): AsyncIterable<unknown> {
  // Typed as an internal tagged union so the next()-side consumer
  // knows which branch to take after a Deferred resolves.
  type Entry =
    | { kind: "value"; value: unknown }
    | { kind: "error"; error: { code: string; message: string } }
    | { kind: "complete" };
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      const buffer: Entry[] = [];
      let pending: {
        resolve: (r: IteratorResult<unknown>) => void;
        reject: (e: Error) => void;
      } | null = null;
      let registered = false;
      let finished = false;
      const handlers: SubscriptionHandlers = {
        push(value) {
          if (finished) return;
          if (pending) {
            const p = pending;
            pending = null;
            p.resolve({ value, done: false });
          } else {
            buffer.push({ kind: "value", value });
          }
        },
        done(error) {
          if (finished) return;
          finished = true;
          state.subscriptions.delete(req.id);
          if (error) {
            if (pending) {
              const p = pending;
              pending = null;
              p.reject(Object.assign(new Error(error.message), { code: error.code }));
            } else {
              buffer.push({ kind: "error", error });
            }
          } else {
            if (pending) {
              const p = pending;
              pending = null;
              p.resolve({ value: undefined, done: true });
            } else {
              buffer.push({ kind: "complete" });
            }
          }
        },
      };
      const cleanup = (): void => {
        if (finished) return;
        finished = true;
        state.subscriptions.delete(req.id);
        try {
          ws.send(encodeTunnelMessage({ type: "stream-cancel", id: req.id }));
        } catch {
          // ws already gone; nothing to ship.
        }
      };
      const ensureRegistered = (): void => {
        if (registered) return;
        registered = true;
        state.subscriptions.set(req.id, handlers);
        try {
          ws.send(encodeTunnelMessage(req));
        } catch (err) {
          handlers.done({
            code: "ws-send-failed",
            message: (err as Error).message,
          });
        }
      };
      return {
        async next(): Promise<IteratorResult<unknown>> {
          ensureRegistered();
          if (buffer.length > 0) {
            const head = buffer.shift();
            if (!head) return { value: undefined, done: true };
            if (head.kind === "value") return { value: head.value, done: false };
            if (head.kind === "complete") return { value: undefined, done: true };
            throw Object.assign(new Error(head.error.message), {
              code: head.error.code,
            });
          }
          if (finished) return { value: undefined, done: true };
          return await new Promise<IteratorResult<unknown>>((resolve, reject) => {
            pending = { resolve, reject };
          });
        },
        return(): Promise<IteratorResult<unknown>> {
          cleanup();
          if (pending) {
            const p = pending;
            pending = null;
            p.resolve({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function getState(ws: BunServerWebSocket): ConnectionState {
  return ws.data as ConnectionState;
}

function closeQuietly(ws: BunServerWebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // ignore
  }
}

/** Shared wiring threaded through the per-connection handlers. */
interface TunnelServerContext {
  opts: TunnelServerOptions;
  clock: () => Date;
  nodes: Map<string, BunServerWebSocket>;
  journal: (entry: TunnelJournalEntry) => void;
}

function registerNode(ctx: TunnelServerContext, ws: BunServerWebSocket, nodeName: string): void {
  const prior = ctx.nodes.get(nodeName);
  if (prior && prior !== ws) {
    // Emit the replaced entry BEFORE closing the prior socket so
    // operators see the displacement event even if the close fires
    // a race-y disconnect-log-first.
    ctx.journal({
      kind: "tunnel-replaced",
      ts: ctx.clock().toISOString(),
      nodeName,
    });
    try {
      prior.close(TUNNEL_CLOSE_REPLACED, "replaced by newer connection");
    } catch {
      // best-effort; prior socket may already be closed
    }
  }
  ctx.nodes.set(nodeName, ws);
  ctx.opts.onNodeConnect?.(nodeName);
  ctx.journal({
    kind: "tunnel-connect",
    ts: ctx.clock().toISOString(),
    nodeName,
  });
}

function unregisterNode(ctx: TunnelServerContext, ws: BunServerWebSocket, reason: string): void {
  const state = getState(ws);
  if (!state.nodeName) return;
  // Only remove from registry if *this* ws still owns the slot.
  // A displaced prior connection will fail this check — that case
  // is already journaled as `tunnel-replaced` by registerNode.
  if (ctx.nodes.get(state.nodeName) === ws) {
    ctx.nodes.delete(state.nodeName);
    ctx.opts.onNodeDisconnect?.(state.nodeName, reason);
    // close() calls pass `ws closed <code>(<reason>)`; extract the
    // numeric code so downstream tooling can bucket by close code
    // (1000 clean shutdown vs 4xxx policy-close vs 1006 abnormal).
    const codeMatch = /^ws closed (\d+)/.exec(reason);
    const rawCode = codeMatch?.[1];
    const code = rawCode ? Number.parseInt(rawCode, 10) : undefined;
    ctx.journal({
      kind: "tunnel-disconnect",
      ts: ctx.clock().toISOString(),
      nodeName: state.nodeName,
      reason,
      ...(typeof code === "number" && Number.isFinite(code) ? { code } : {}),
    });
  }
  // Error out any pending requests awaiting responses.
  for (const { reject } of state.pending.values()) {
    reject(new Error(`tunnel-disconnected: ${reason}`));
  }
  state.pending.clear();
  // Terminate any in-flight subscriptions with a synthetic error —
  // the consumer's `for await` will throw with the reason so it
  // can bail out of its SSE body loop cleanly. No explicit
  // stream-cancel ships because the ws is already gone.
  for (const { done } of state.subscriptions.values()) {
    done({ code: "tunnel-disconnected", message: reason });
  }
  state.subscriptions.clear();
}

/** First-message authentication: a `hello` frame carrying the bearer. */
function handleHello(
  ctx: TunnelServerContext,
  ws: BunServerWebSocket,
  state: ConnectionState,
  msg: TunnelMessage,
): void {
  if (msg.type !== "hello") {
    ctx.journal({
      kind: "tunnel-unauthorized",
      ts: ctx.clock().toISOString(),
      reason: "hello-required-first",
    });
    closeQuietly(ws, TUNNEL_CLOSE_UNAUTHORIZED, "hello required first");
    return;
  }
  if (hashToken(msg.bearer) !== ctx.opts.expectedBearerHash) {
    // Hello parsed cleanly so the nodeName is known; journal it
    // so operators can see WHICH node is presenting a stale
    // bearer (common after a central-side bearer rotation).
    ctx.journal({
      kind: "tunnel-unauthorized",
      ts: ctx.clock().toISOString(),
      nodeName: msg.nodeName,
      reason: "bad-bearer",
    });
    closeQuietly(ws, TUNNEL_CLOSE_UNAUTHORIZED, "bad bearer");
    return;
  }
  state.authenticated = true;
  state.nodeName = msg.nodeName;
  if (state.helloTimer) {
    clearTimeout(state.helloTimer);
    state.helloTimer = null;
  }
  registerNode(ctx, ws, msg.nodeName);
  const ack: TunnelMessage = {
    type: "hello-ack",
    serverTime: ctx.clock().toISOString(),
  };
  ws.send(encodeTunnelMessage(ack));
}

/** Correlate a `res` frame back to its pending request promise. */
function resolvePendingRes(state: ConnectionState, msg: TunnelRes): void {
  const pending = state.pending.get(msg.id);
  if (pending) {
    state.pending.delete(msg.id);
    pending.resolve(msg);
  }
}

/**
 * Route to subscription map ONLY — a late stream-event
 * after cancel will miss (no-op) which is the intended
 * silent-drop behaviour.
 */
function pushStreamEvent(
  state: ConnectionState,
  msg: Extract<TunnelMessage, { type: "stream-event" }>,
): void {
  const sub = state.subscriptions.get(msg.id);
  if (sub) sub.push(msg.data);
}

function finishStream(
  state: ConnectionState,
  msg: Extract<TunnelMessage, { type: "stream-done" }>,
): void {
  const sub = state.subscriptions.get(msg.id);
  if (sub) {
    state.subscriptions.delete(msg.id);
    sub.done(msg.ok ? undefined : msg.error);
  }
}

function handleTunnelMessage(
  ctx: TunnelServerContext,
  ws: BunServerWebSocket,
  data: string | Buffer,
): void {
  const state = getState(ws);
  const raw = typeof data === "string" ? data : data.toString("utf8");
  const msg = parseTunnelMessage(raw);
  if (!msg) {
    ctx.journal({
      kind: "tunnel-unauthorized",
      ts: ctx.clock().toISOString(),
      reason: "malformed-hello",
    });
    closeQuietly(ws, TUNNEL_CLOSE_BAD_HELLO, "malformed frame");
    return;
  }
  if (!state.authenticated) {
    handleHello(ctx, ws, state, msg);
    return;
  }
  if (msg.type === "res") {
    resolvePendingRes(state, msg);
    return;
  }
  if (msg.type === "stream-event") {
    pushStreamEvent(state, msg);
    return;
  }
  if (msg.type === "stream-done") {
    finishStream(state, msg);
    return;
  }
  if (msg.type === "ping") {
    ws.send(encodeTunnelMessage({ type: "pong", nonce: msg.nonce }));
    return;
  }
  // Anything else at this stage (req from a node, spurious
  // hello) is ignored — tunnel is request-from-central only.
}

/** AsyncIterable that throws on first `next()` — used when the target
 *  node has no live tunnel so `for await` consumers fail fast. */
function notConnectedIterable(nodeName: string): AsyncIterable<unknown> {
  const err = new Error(`tunnel not connected for node '${nodeName}'`);
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let thrown = false;
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (thrown) return Promise.resolve({ value: undefined, done: true });
          thrown = true;
          return Promise.reject(err);
        },
        return(): Promise<IteratorResult<unknown>> {
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function buildRegistry(ctx: TunnelServerContext): TunnelRegistryEntry[] {
  const out: TunnelRegistryEntry[] = [];
  for (const [nodeName, ws] of ctx.nodes.entries()) {
    const state = getState(ws);
    out.push({
      nodeName,
      connectedAt: ctx.clock().toISOString(),
      send: (req) =>
        new Promise<TunnelRes>((resolve, reject) => {
          state.pending.set(req.id, { resolve, reject });
          try {
            ws.send(encodeTunnelMessage(req));
          } catch (err) {
            state.pending.delete(req.id);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }),
      close: (code, reason) => {
        try {
          ws.close(code ?? 1000, reason ?? "closed by registry");
        } catch {
          // ignore
        }
      },
    });
  }
  return out;
}

export function createTunnelServer(opts: TunnelServerOptions): TunnelServer {
  const clock = opts.clock ?? ((): Date => new Date());
  const nodes = new Map<string, BunServerWebSocket>();
  // Resolved once at setup so env overrides capture the process's
  // startup state, not whatever `process.env` looks like when a ws
  // event fires. Journal writes are best-effort; `appendTunnelJournal`
  // already swallows I/O errors, but we wrap each call in try/catch
  // too so a truly unexpected throw never nukes a tunnel handler.
  const journalPath = opts.journalPath ?? defaultTunnelJournalPath();
  const journal = (entry: TunnelJournalEntry): void => {
    try {
      appendTunnelJournal(entry, journalPath);
    } catch {
      // swallowed; appendTunnelJournal already stderr-warns once.
    }
  };
  const ctx: TunnelServerContext = { opts, clock, nodes, journal };

  return {
    handleUpgrade(req, server): Response | undefined {
      const url = new URL(req.url);
      if (url.pathname !== "/tunnel") return undefined;
      const state: ConnectionState = {
        authenticated: false,
        nodeName: null,
        helloTimer: null,
        pending: new Map(),
        subscriptions: new Map(),
      };

      const upgraded = server.upgrade(req, { data: state });
      if (!upgraded) {
        return new Response("tunnel upgrade failed", { status: 400 });
      }
      return undefined;
    },
    websocket: {
      open(ws): void {
        const state = getState(ws);
        state.helloTimer = setTimeout(() => {
          // NodeName is still unknown — hello never arrived. Journal
          // the timeout itself so operators can distinguish idle
          // loopback probes from actual nodes failing to auth.
          journal({
            kind: "tunnel-unauthorized",
            ts: clock().toISOString(),
            reason: "hello-timeout",
          });
          try {
            ws.close(TUNNEL_CLOSE_HELLO_TIMEOUT, "hello timeout");
          } catch {
            // ignore
          }
        }, HELLO_TIMEOUT_MS);
      },
      message(ws, data): void {
        handleTunnelMessage(ctx, ws, data);
      },
      close(ws, code, reason): void {
        const state = getState(ws);
        if (state.helloTimer) {
          clearTimeout(state.helloTimer);
          state.helloTimer = null;
        }
        unregisterNode(ctx, ws, `ws closed ${String(code)}${reason ? ` (${reason})` : ""}`);
      },
    },
    async send(
      nodeName,
      req,
    ): Promise<{
      type: "res";
      id: string;
      result?: unknown;
      error?: { code: string; message: string } | undefined;
    }> {
      const ws = nodes.get(nodeName);
      if (!ws) throw new Error(`tunnel not connected for node '${nodeName}'`);
      const state = getState(ws);
      const full: TunnelReq = { type: "req", ...req };
      return await new Promise<TunnelRes>((resolve, reject) => {
        state.pending.set(full.id, { resolve, reject });
        try {
          ws.send(encodeTunnelMessage(full));
        } catch (err) {
          state.pending.delete(full.id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    sendSubscribe(nodeName, req): AsyncIterable<unknown> {
      const ws = nodes.get(nodeName);
      if (!ws) {
        // Return an iterable that throws on first `next()` so the
        // synchronous call signature stays simple. Consumers inside
        // a `for await` will see the throw on iteration start.
        return notConnectedIterable(nodeName);
      }
      const state = getState(ws);
      const full: TunnelReq = { type: "req", ...req };
      return buildSubscriptionIterable(ws, state, full);
    },
    registry(): TunnelRegistryEntry[] {
      return buildRegistry(ctx);
    },
    disconnect(nodeName, reason): boolean {
      const ws = nodes.get(nodeName);
      if (!ws) return false;
      try {
        ws.close(1000, reason ?? "kicked by central");
      } catch {
        // ignore
      }
      return true;
    },
  };
}
