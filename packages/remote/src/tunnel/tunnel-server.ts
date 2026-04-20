import { hashToken } from '../server/auth.js';
import {
  appendTunnelJournal,
  defaultTunnelJournalPath,
  type TunnelJournalEntry,
} from './journal.js';
import {
  TUNNEL_CLOSE_BAD_HELLO,
  TUNNEL_CLOSE_HELLO_TIMEOUT,
  TUNNEL_CLOSE_UNAUTHORIZED,
  encodeTunnelMessage,
  parseTunnelMessage,
  type TunnelMessage,
  type TunnelReq,
  type TunnelRes,
} from './messages.js';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBunServerWebSocket = any;

interface ConnectionState {
  authenticated: boolean;
  nodeName: string | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  pending: Map<string, { resolve: (r: TunnelRes) => void; reject: (err: Error) => void }>;
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
  /** Used by Bun.serve's `fetch` handler for WebSocket upgrades.
   *  Typed loosely with `any` because Bun's own Server type keeps its
   *  `data` generic narrow; callers pass their Bun server directly. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleUpgrade: (req: Request, server: any) => Response | undefined;
  /** Plugs straight into `Bun.serve({ websocket })`. */
  websocket: {
    open: (ws: AnyBunServerWebSocket) => void;
    message: (ws: AnyBunServerWebSocket, data: string | Buffer) => void;
    close: (ws: AnyBunServerWebSocket, code: number, reason: string) => void;
  };
  send: (nodeName: string, req: Omit<TunnelReq, 'type'>) => Promise<TunnelRes>;
  registry: () => TunnelRegistryEntry[];
  /** Force-close a node's tunnel; primarily for tests + operator
   *  "agent tunnel kick" tooling. */
  disconnect: (nodeName: string, reason?: string) => boolean;
}

export function createTunnelServer(opts: TunnelServerOptions): TunnelServer {
  const clock = opts.clock ?? (() => new Date());
  const nodes = new Map<string, AnyBunServerWebSocket>();
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

  function getState(ws: AnyBunServerWebSocket): ConnectionState {
    return ws.data as ConnectionState;
  }

  function registerNode(ws: AnyBunServerWebSocket, nodeName: string): void {
    const prior = nodes.get(nodeName);
    if (prior && prior !== ws) {
      // Emit the replaced entry BEFORE closing the prior socket so
      // operators see the displacement event even if the close fires
      // a race-y disconnect-log-first.
      journal({
        kind: 'tunnel-replaced',
        ts: clock().toISOString(),
        nodeName,
      });
      try {
        prior.close(TUNNEL_CLOSE_REPLACED, 'replaced by newer connection');
      } catch {
        // best-effort; prior socket may already be closed
      }
    }
    nodes.set(nodeName, ws);
    opts.onNodeConnect?.(nodeName);
    journal({
      kind: 'tunnel-connect',
      ts: clock().toISOString(),
      nodeName,
    });
  }

  function unregisterNode(ws: AnyBunServerWebSocket, reason: string): void {
    const state = getState(ws);
    if (!state.nodeName) return;
    // Only remove from registry if *this* ws still owns the slot.
    // A displaced prior connection will fail this check — that case
    // is already journaled as `tunnel-replaced` by registerNode.
    if (nodes.get(state.nodeName) === ws) {
      nodes.delete(state.nodeName);
      opts.onNodeDisconnect?.(state.nodeName, reason);
      // close() calls pass `ws closed <code>(<reason>)`; extract the
      // numeric code so downstream tooling can bucket by close code
      // (1000 clean shutdown vs 4xxx policy-close vs 1006 abnormal).
      const codeMatch = /^ws closed (\d+)/.exec(reason);
      const code = codeMatch ? Number.parseInt(codeMatch[1]!, 10) : undefined;
      journal({
        kind: 'tunnel-disconnect',
        ts: clock().toISOString(),
        nodeName: state.nodeName,
        reason,
        ...(typeof code === 'number' && Number.isFinite(code) ? { code } : {}),
      });
    }
    // Error out any pending requests awaiting responses.
    for (const { reject } of state.pending.values()) {
      reject(new Error(`tunnel-disconnected: ${reason}`));
    }
    state.pending.clear();
  }

  return {
    handleUpgrade(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== '/tunnel') return undefined;
      const state: ConnectionState = {
        authenticated: false,
        nodeName: null,
        helloTimer: null,
        pending: new Map(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const upgraded = (server as any).upgrade(req, { data: state });
      if (!upgraded) {
        return new Response('tunnel upgrade failed', { status: 400 });
      }
      return undefined;
    },
    websocket: {
      open(ws) {
        const state = getState(ws);
        state.helloTimer = setTimeout(() => {
          // NodeName is still unknown — hello never arrived. Journal
          // the timeout itself so operators can distinguish idle
          // loopback probes from actual nodes failing to auth.
          journal({
            kind: 'tunnel-unauthorized',
            ts: clock().toISOString(),
            reason: 'hello-timeout',
          });
          try {
            ws.close(TUNNEL_CLOSE_HELLO_TIMEOUT, 'hello timeout');
          } catch {
            // ignore
          }
        }, HELLO_TIMEOUT_MS);
      },
      message(ws, data) {
        const state = getState(ws);
        const raw = typeof data === 'string' ? data : data.toString('utf8');
        const msg = parseTunnelMessage(raw);
        if (!msg) {
          journal({
            kind: 'tunnel-unauthorized',
            ts: clock().toISOString(),
            reason: 'malformed-hello',
          });
          try {
            ws.close(TUNNEL_CLOSE_BAD_HELLO, 'malformed frame');
          } catch {
            // ignore
          }
          return;
        }
        if (!state.authenticated) {
          if (msg.type !== 'hello') {
            journal({
              kind: 'tunnel-unauthorized',
              ts: clock().toISOString(),
              reason: 'hello-required-first',
            });
            try {
              ws.close(TUNNEL_CLOSE_UNAUTHORIZED, 'hello required first');
            } catch {
              // ignore
            }
            return;
          }
          if (hashToken(msg.bearer) !== opts.expectedBearerHash) {
            // Hello parsed cleanly so the nodeName is known; journal it
            // so operators can see WHICH node is presenting a stale
            // bearer (common after a central-side bearer rotation).
            journal({
              kind: 'tunnel-unauthorized',
              ts: clock().toISOString(),
              nodeName: msg.nodeName,
              reason: 'bad-bearer',
            });
            try {
              ws.close(TUNNEL_CLOSE_UNAUTHORIZED, 'bad bearer');
            } catch {
              // ignore
            }
            return;
          }
          state.authenticated = true;
          state.nodeName = msg.nodeName;
          if (state.helloTimer) {
            clearTimeout(state.helloTimer);
            state.helloTimer = null;
          }
          registerNode(ws, msg.nodeName);
          const ack: TunnelMessage = {
            type: 'hello-ack',
            serverTime: clock().toISOString(),
          };
          ws.send(encodeTunnelMessage(ack));
          return;
        }
        if (msg.type === 'res') {
          const pending = state.pending.get(msg.id);
          if (pending) {
            state.pending.delete(msg.id);
            pending.resolve(msg);
          }
          return;
        }
        if (msg.type === 'ping') {
          ws.send(encodeTunnelMessage({ type: 'pong', nonce: msg.nonce }));
          return;
        }
        // Anything else at this stage (req from a node, spurious
        // hello) is ignored — tunnel is request-from-central only.
      },
      close(ws, code, reason) {
        const state = getState(ws);
        if (state.helloTimer) {
          clearTimeout(state.helloTimer);
          state.helloTimer = null;
        }
        unregisterNode(ws, `ws closed ${code}${reason ? ` (${reason})` : ''}`);
      },
    },
    async send(nodeName, req) {
      const ws = nodes.get(nodeName);
      if (!ws) throw new Error(`tunnel not connected for node '${nodeName}'`);
      const state = getState(ws);
      const full: TunnelReq = { type: 'req', ...req };
      return new Promise<TunnelRes>((resolve, reject) => {
        state.pending.set(full.id, { resolve, reject });
        try {
          ws.send(encodeTunnelMessage(full));
        } catch (err) {
          state.pending.delete(full.id);
          reject(err as Error);
        }
      });
    },
    registry() {
      const out: TunnelRegistryEntry[] = [];
      for (const [nodeName, ws] of nodes.entries()) {
        const state = getState(ws);
        out.push({
          nodeName,
          connectedAt: clock().toISOString(),
          send: (req) =>
            new Promise<TunnelRes>((resolve, reject) => {
              state.pending.set(req.id, { resolve, reject });
              try {
                ws.send(encodeTunnelMessage(req));
              } catch (err) {
                state.pending.delete(req.id);
                reject(err as Error);
              }
            }),
          close: (code, reason) => {
            try {
              ws.close(code ?? 1000, reason ?? 'closed by registry');
            } catch {
              // ignore
            }
          },
        });
      }
      return out;
    },
    disconnect(nodeName, reason) {
      const ws = nodes.get(nodeName);
      if (!ws) return false;
      try {
        ws.close(1000, reason ?? 'kicked by central');
      } catch {
        // ignore
      }
      return true;
    },
  };
}
