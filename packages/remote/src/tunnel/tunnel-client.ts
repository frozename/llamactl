import {
  encodeTunnelMessage,
  parseTunnelMessage,
  type TunnelReq,
  type TunnelRes,
} from './messages.js';

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
  minDelayMs?: number;   // default 1000
  maxDelayMs?: number;   // default 60000
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

export type TunnelState = 'connecting' | 'ready' | 'disconnected' | 'stopped';

export interface TunnelClientOptions {
  url: string;
  bearer: string;
  nodeName: string;
  /** Invoked for each inbound req; returned value is packaged as a
   *  success `res`. Throw to send an error `res`. */
  handleRequest: (req: TunnelReq) => Promise<unknown>;
  /** Override for tests. Defaults to the global WebSocket. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WebSocketCtor?: any;
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

export function createTunnelClient(opts: TunnelClientOptions): TunnelClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WS: any = opts.WebSocketCtor ?? (globalThis as { WebSocket?: unknown }).WebSocket;
  if (!WS) {
    throw new Error(
      'createTunnelClient: no WebSocket available — pass WebSocketCtor explicitly',
    );
  }
  const reconnectCfg = {
    minDelayMs: opts.reconnect?.minDelayMs ?? 1000,
    maxDelayMs: opts.reconnect?.maxDelayMs ?? 60000,
    jitterFraction: opts.reconnect?.jitterFraction ?? 0.2,
  };
  const heartbeatCfg = {
    intervalMs: opts.heartbeat?.intervalMs ?? 25000,
    timeoutMs: opts.heartbeat?.timeoutMs ?? 5000,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ws: any = null;
  let state: TunnelState = 'disconnected';
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const pendingPings = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  const readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> | null }> = [];
  let firstAttemptResolver: { resolve: () => void; reject: (err: Error) => void } | null = null;

  function setState(next: TunnelState): void {
    if (state === next) return;
    state = next;
    opts.onStateChange?.(next);
    if (next === 'ready') {
      for (const w of readyWaiters.splice(0)) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  function cleanupSocket(): void {
    if (ws) {
      try { ws.onmessage = null; } catch { /* ignore */ }
      try { ws.onopen = null; } catch { /* ignore */ }
      try { ws.onclose = null; } catch { /* ignore */ }
      try { ws.onerror = null; } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const { reject } of pendingPings.values()) {
      reject(new Error('tunnel-disconnected'));
    }
    pendingPings.clear();
  }

  function computeBackoff(): number {
    const base = Math.min(
      reconnectCfg.maxDelayMs,
      reconnectCfg.minDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
    );
    const jitter = base * reconnectCfg.jitterFraction;
    return Math.max(0, base + (Math.random() * 2 - 1) * jitter);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) return;
    const delay = computeBackoff();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      void doConnect();
    }, delay);
  }

  function startHeartbeat(): void {
    if (heartbeatCfg.intervalMs <= 0) return;
    heartbeatTimer = setInterval(() => {
      if (state !== 'ready') return;
      const nonce = `hb-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        pendingPings.delete(nonce);
        // Miss → force reconnect. Close the current socket; the
        // onclose path handles the loop.
        try { ws?.close(4000, 'heartbeat timeout'); } catch { /* ignore */ }
      }, heartbeatCfg.timeoutMs);
      pendingPings.set(nonce, {
        resolve: () => { clearTimeout(timer); },
        reject: () => { clearTimeout(timer); },
      });
      try {
        ws?.send(encodeTunnelMessage({ type: 'ping', nonce }));
      } catch {
        clearTimeout(timer);
        pendingPings.delete(nonce);
      }
    }, heartbeatCfg.intervalMs);
  }

  async function doHandleRequest(req: TunnelReq): Promise<TunnelRes> {
    try {
      const result = await opts.handleRequest(req);
      return { type: 'res', id: req.id, result };
    } catch (err) {
      return {
        type: 'res',
        id: req.id,
        error: { code: 'handler-threw', message: (err as Error).message },
      };
    }
  }

  function doConnect(): void {
    if (stopped) return;
    attempt++;
    setState('connecting');
    const ackTimeout = opts.helloAckTimeoutMs ?? ACK_TIMEOUT_DEFAULT;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      ws = new WS(opts.url);
    } catch (err) {
      setState('disconnected');
      scheduleReconnect();
      if (firstAttemptResolver && attempt === 1) {
        firstAttemptResolver.reject(err as Error);
        firstAttemptResolver = null;
      }
      return;
    }
    ackTimer = setTimeout(() => {
      try { ws?.close(); } catch { /* ignore */ }
    }, ackTimeout);
    ws.onopen = () => {
      try {
        ws.send(
          encodeTunnelMessage({
            type: 'hello',
            bearer: opts.bearer,
            nodeName: opts.nodeName,
          }),
        );
      } catch {
        // close path picks it up
      }
    };
    ws.onmessage = (ev: { data: string | Buffer }) => {
      const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8');
      const msg = parseTunnelMessage(raw);
      if (!msg) return;
      if (state !== 'ready') {
        if (msg.type === 'hello-ack') {
          if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
          attempt = 0; // reset backoff on a healthy ack
          setState('ready');
          startHeartbeat();
          if (firstAttemptResolver) {
            firstAttemptResolver.resolve();
            firstAttemptResolver = null;
          }
        }
        return;
      }
      if (msg.type === 'req') {
        void doHandleRequest(msg).then((res) => {
          try { ws?.send(encodeTunnelMessage(res)); } catch { /* ignore */ }
        });
        return;
      }
      if (msg.type === 'pong') {
        const p = pendingPings.get(msg.nonce);
        if (p) {
          pendingPings.delete(msg.nonce);
          p.resolve();
        }
        return;
      }
    };
    ws.onclose = (ev: { code: number; reason: string }) => {
      if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
      const wasFirstAttempt = firstAttemptResolver !== null && attempt === 1;
      opts.onClose?.(ev.code, ev.reason);
      cleanupSocket();
      setState(stopped ? 'stopped' : 'disconnected');
      if (wasFirstAttempt && firstAttemptResolver) {
        firstAttemptResolver.reject(
          new Error(`tunnel closed before hello-ack: ${ev.code} ${ev.reason}`),
        );
        firstAttemptResolver = null;
      }
      if (!stopped) scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose will follow.
    };
  }

  return {
    async start() {
      if (stopped) throw new Error('tunnel client has been stopped');
      const initialBudget = opts.initialAttemptTimeoutMs ?? INITIAL_ATTEMPT_TIMEOUT_DEFAULT;
      if (initialBudget <= 0) {
        // Background mode — fire and forget.
        doConnect();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          firstAttemptResolver = null;
          reject(new Error('tunnel start: initial-attempt timeout'));
        }, initialBudget);
        firstAttemptResolver = {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        };
        doConnect();
      });
    },
    stop(code, reason) {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try { ws.close(code ?? 1000, reason ?? 'client stop'); } catch { /* ignore */ }
      }
      cleanupSocket();
      setState('stopped');
      for (const w of readyWaiters.splice(0)) {
        if (w.timer) clearTimeout(w.timer);
        w.reject(new Error('tunnel client stopped'));
      }
      if (firstAttemptResolver) {
        firstAttemptResolver.reject(new Error('tunnel client stopped'));
        firstAttemptResolver = null;
      }
    },
    async ping(nonce, timeoutMs = 3000) {
      if (state !== 'ready' || !ws) throw new Error('tunnel not ready');
      const actualNonce = nonce ?? Math.random().toString(36).slice(2);
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPings.delete(actualNonce);
          reject(new Error('ping timeout'));
        }, timeoutMs);
        pendingPings.set(actualNonce, {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        });
        try {
          ws.send(encodeTunnelMessage({ type: 'ping', nonce: actualNonce }));
        } catch (err) {
          pendingPings.delete(actualNonce);
          clearTimeout(timer);
          reject(err as Error);
        }
      });
    },
    async waitUntilReady(timeoutMs = 10000) {
      if (state === 'ready') return;
      if (state === 'stopped') throw new Error('tunnel client stopped');
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = readyWaiters.findIndex((w) => w.timer === timer);
          if (i >= 0) readyWaiters.splice(i, 1);
          reject(new Error(`tunnel waitUntilReady: timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        readyWaiters.push({ resolve, reject, timer });
      });
    },
    isReady() {
      return state === 'ready';
    },
    state() {
      return state;
    },
  };
}
