import type { TunnelSendFn } from '@llamactl/remote';

/**
 * Narrow callable shape of `fetch` — just the call signature,
 * without the `preconnect` helper Bun's global carries. Tests stub
 * this with a plain async function; the production default is the
 * runtime's global `fetch`.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * CLI-side dispatcher for reverse-tunnel calls (I.3.3).
 *
 * When the kubeconfig marks a node as `tunnelPreferred: true`, the
 * operator has declared that node NAT'd / unreachable over direct
 * HTTPS. The dispatcher hands `createNodeClient` a `TunnelSendFn`
 * that POSTs to `<tunnelCentralUrl>/tunnel-relay/<nodeName>` — the
 * local agent (playing tunnel-central) then forwards the request
 * over the reverse WebSocket to the node and returns the `TunnelRes`
 * envelope.
 *
 * Deviation note: no silent HTTP fallback. If the operator set
 * `tunnelPreferred: true`, direct HTTPS wouldn't work anyway — so a
 * failed relay call surfaces as an error.
 *
 * TODO: pinned-cert verification against the local central's TLS
 * cert. Today we rely on the relay URL pointing at loopback for
 * single-host deployments; cross-host central requires reusing
 * `buildPinnedLinks`'s fingerprint check (out of scope for this
 * slice — known gap).
 */
export interface TunnelRelayCallOptions {
  centralUrl: string;
  nodeName: string;
  method: string;
  input: unknown;
  bearer: string;
  /** Injected for testability. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Tunnel frame type. Uniform per router-bridge.ts:31 comment —
   *  the caller proxy treats query vs mutation identically for
   *  non-streaming procedures; the node-client proxy passes the
   *  real type for server-side routing correctness. */
  type?: 'query' | 'mutation';
}

interface TunnelResEnvelope {
  type: 'res';
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export async function callViaTunnelRelay(
  opts: TunnelRelayCallOptions,
): Promise<unknown> {
  const base = opts.centralUrl.replace(/\/$/, '');
  const url = `${base}/tunnel-relay/${encodeURIComponent(opts.nodeName)}`;
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as FetchLike);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.bearer}`,
    },
    body: JSON.stringify({
      method: opts.method,
      type: opts.type ?? 'query',
      input: opts.input,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `tunnel-relay ${res.status}: ${text || res.statusText}`,
    );
  }
  const envelope = (await res.json()) as TunnelResEnvelope;
  if (envelope.error) {
    const err = new Error(envelope.error.message) as Error & { code?: string };
    err.code = envelope.error.code;
    throw err;
  }
  return envelope.result;
}

/**
 * Build a `TunnelSendFn` closure that routes every tunnel frame
 * through `callViaTunnelRelay`. The returned fn is what
 * `createNodeClient`'s `proxyFromTunnel` path invokes to move a
 * single tRPC call over the tunnel.
 *
 * The `bearer` is the operator's local-agent token (same bearer
 * guarding direct-HTTPS `/trpc` on the local node). We reuse it
 * because the relay endpoint lives on the operator's local agent,
 * not on the NAT'd node — and the local agent's `verifyBearer`
 * accepts that same token hash.
 */
export function buildTunnelSend(opts: {
  centralUrl: string;
  bearer: string;
  nodeName: string;
  fetchImpl?: FetchLike;
}): TunnelSendFn {
  return async (req) => {
    // `req.params` is `{ type: 'query'|'mutation', input: unknown }`
    // per node-client.ts's `proxyFromTunnel`. We unwrap it here so
    // the relay receives flat `{method, type, input}` — that's the
    // shape `handleTunnelRelay` parses on the server side.
    const params = req.params as { type?: 'query' | 'mutation'; input?: unknown };
    try {
      const result = await callViaTunnelRelay({
        centralUrl: opts.centralUrl,
        nodeName: opts.nodeName,
        method: req.method,
        input: params?.input,
        bearer: opts.bearer,
        fetchImpl: opts.fetchImpl,
        type: params?.type,
      });
      return { id: req.id, result };
    } catch (err) {
      const e = err as Error & { code?: string };
      return {
        id: req.id,
        error: {
          code: e.code ?? 'tunnel-relay-failed',
          message: e.message,
        },
      };
    }
  };
}
