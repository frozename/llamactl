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
 * bearer + nodeName, then handles inbound `req` frames by calling
 * the caller-supplied `handleRequest` and shipping back a `res`
 * frame with the matching id.
 *
 * I.3.1 scope: one connection, no reconnect, no heartbeat. The
 * `connect()` promise resolves on hello-ack (explicit handshake
 * success) or rejects on close-before-ack. Reconnect loop, jitter,
 * exp backoff, ping/pong land in I.3.2.
 */

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
  onClose?: (code: number, reason: string) => void;
  /** ms to wait for the hello-ack before treating the handshake as
   *  failed. Defaults to 5 s. */
  helloAckTimeoutMs?: number;
}

export interface TunnelClient {
  /** Open the socket + wait for hello-ack. */
  connect(): Promise<void>;
  /** Send a ping; resolves when server pongs. Reject on timeout.
   *  Useful for the self-test CLI in I.3.4; also lets tests assert
   *  the message round-trip without needing a req path. */
  ping(nonce?: string, timeoutMs?: number): Promise<void>;
  close(code?: number, reason?: string): void;
  /** Diagnostic: is the underlying socket OPEN + past hello-ack. */
  isReady(): boolean;
}

const ACK_TIMEOUT_DEFAULT = 5000;

export function createTunnelClient(opts: TunnelClientOptions): TunnelClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WS: any = opts.WebSocketCtor ?? (globalThis as { WebSocket?: unknown }).WebSocket;
  if (!WS) {
    throw new Error(
      'createTunnelClient: no WebSocket available — pass WebSocketCtor explicitly',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ws: any = null;
  let ready = false;
  const pendingPings = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

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

  return {
    async connect() {
      const ackTimeout = opts.helloAckTimeoutMs ?? ACK_TIMEOUT_DEFAULT;
      ws = new WS(opts.url);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('tunnel: hello-ack timeout'));
          try { ws.close(); } catch { /* ignore */ }
        }, ackTimeout);
        ws.onopen = () => {
          ws.send(
            encodeTunnelMessage({
              type: 'hello',
              bearer: opts.bearer,
              nodeName: opts.nodeName,
            }),
          );
        };
        ws.onmessage = (ev: { data: string | Buffer }) => {
          const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8');
          const msg = parseTunnelMessage(raw);
          if (!msg) return;
          if (!ready) {
            if (msg.type === 'hello-ack') {
              ready = true;
              clearTimeout(timer);
              resolve();
            }
            return;
          }
          if (msg.type === 'req') {
            void doHandleRequest(msg).then((res) => {
              try { ws.send(encodeTunnelMessage(res)); } catch { /* ignore */ }
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
          // Drop anything else — out-of-protocol messages are not fatal.
        };
        ws.onclose = (ev: { code: number; reason: string }) => {
          clearTimeout(timer);
          ready = false;
          opts.onClose?.(ev.code, ev.reason);
          if (!ready) {
            reject(new Error(`tunnel closed before hello-ack: ${ev.code} ${ev.reason}`));
          }
          for (const { reject: rej } of pendingPings.values()) {
            rej(new Error(`tunnel-disconnected: ${ev.code}`));
          }
          pendingPings.clear();
        };
        ws.onerror = () => {
          // onclose will follow and carry the actual failure reason;
          // nothing to do here beyond swallowing the event.
        };
      });
    },
    async ping(nonce, timeoutMs = 3000) {
      if (!ready || !ws) throw new Error('tunnel not ready');
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
    close(code, reason) {
      ready = false;
      if (ws) {
        try { ws.close(code ?? 1000, reason ?? 'client close'); } catch { /* ignore */ }
      }
    },
    isReady() {
      return ready;
    },
  };
}
