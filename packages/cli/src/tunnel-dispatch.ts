import type { TunnelSendFn, TunnelSubscribeFn } from '@llamactl/remote';
import { tls } from '@llamactl/remote';

const { computeFingerprint, fingerprintsEqual } = tls;

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
 * Module-scoped guard so the `--insecure-tunnel-relay` stderr WARN
 * fires at most once per CLI process, regardless of how many
 * tunneled tRPC calls flow through in a session. Exported helper
 * for tests that want to reset the flag between test cases.
 */
let warnedAboutInsecureTunnel = false;
export function __resetInsecureTunnelWarning(): void {
  warnedAboutInsecureTunnel = false;
}

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
 * Slice C (I.3.7) — the relay POST is now pinned against the local
 * central agent's TLS cert via `pinnedCa` + `expectedFingerprint`
 * (sourced from kubeconfig `tunnelCentralCertificate` +
 * `tunnelCentralFingerprint`). This is the *central* cert, NOT the
 * NAT'd node's — `ClusterNode.certificateFingerprint` is a
 * separate concern for direct HTTPS. Absent fields fail closed
 * unless `insecure: true` explicitly bypasses the check with a
 * one-shot stderr WARN.
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
  /**
   * PEM of the *local central agent's* cert (distinct from the
   * remote node's cert). When set together with
   * `expectedFingerprint`, pins the relay POST via Bun's
   * `fetch({ tls: { ca } })` — ignores system roots so a
   * CA-issued MITM cert won't pass.
   */
  pinnedCa?: string;
  /** `"sha256:<hex>"` that `pinnedCa` must hash to. Mismatch
   *  throws before the fetch fires. */
  expectedFingerprint?: string;
  /** Bypass pin check with one stderr WARN. Only set when the
   *  operator passed `--insecure-tunnel-relay` on the CLI. */
  insecure?: boolean;
}

interface TunnelResEnvelope {
  type: 'res';
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * Shared pin-gate + request-init builder used by both the JSON
 * POST path (`callViaTunnelRelay`) and the SSE subscribe path
 * (`openTunnelRelaySse`). Extracted so both surfaces enforce the
 * fingerprint check + Bun `tls.ca` plumbing identically — the anti-
 * pattern guard (B.4 docstring) explicitly forbids pinning drift
 * between the two.
 */
interface BuildRelayFetchInitOptions {
  method: string;
  type: 'query' | 'mutation' | 'subscription';
  input: unknown;
  bearer: string;
  pinnedCa?: string;
  expectedFingerprint?: string;
  insecure?: boolean;
  /** Appended to the request init — used by the SSE path to carry
   *  an AbortController signal so `.unsubscribe()` can tear down
   *  the fetch response. */
  signal?: AbortSignal;
}
interface BuiltRelayRequest {
  url: string;
  init: Parameters<FetchLike>[1];
}
function buildRelayFetchInit(
  centralUrl: string,
  nodeName: string,
  opts: BuildRelayFetchInitOptions,
  query?: Record<string, string>,
): BuiltRelayRequest {
  // Fingerprint gate. `tunnelCentralFingerprint` /
  // `tunnelCentralCertificate` pin against the *local central agent's*
  // TLS cert — NOT the remote node's cert. See links.ts:38-62 for
  // the mirror pattern.
  if (opts.insecure) {
    if (!warnedAboutInsecureTunnel) {
      process.stderr.write(
        'WARN: tunnel-relay fingerprint check bypassed (--insecure-tunnel-relay)\n',
      );
      warnedAboutInsecureTunnel = true;
    }
  } else {
    if (!opts.pinnedCa || !opts.expectedFingerprint) {
      throw new Error(
        'tunnelCentralFingerprint + tunnelCentralCertificate must be ' +
          'set in kubeconfig context, or pass --insecure-tunnel-relay to ' +
          'bypass (run `llamactl tunnel pin-central` to populate)',
      );
    }
    const computed = computeFingerprint(opts.pinnedCa);
    if (!fingerprintsEqual(computed, opts.expectedFingerprint)) {
      throw new Error(
        `tunnel-relay fingerprint mismatch: expected ${opts.expectedFingerprint}, got ${computed}`,
      );
    }
  }
  const base = centralUrl.replace(/\/$/, '');
  let url = `${base}/tunnel-relay/${encodeURIComponent(nodeName)}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  // Bun-specific `tls.ca` extension (same cast-through-any pattern as
  // `makePinnedFetch` in links.ts:62). Only set when we've verified
  // the fingerprint above — omit entirely in insecure mode so the
  // default system-CA trust path applies.
  const init: Parameters<FetchLike>[1] = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.bearer}`,
    },
    body: JSON.stringify({
      method: opts.method,
      type: opts.type,
      input: opts.input,
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.pinnedCa && !opts.insecure
      ? ({ tls: { ca: opts.pinnedCa } } as Record<string, unknown>)
      : {}),
  };
  return { url, init };
}

export async function callViaTunnelRelay(
  opts: TunnelRelayCallOptions,
): Promise<unknown> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as FetchLike);
  const built = buildRelayFetchInit(opts.centralUrl, opts.nodeName, {
    method: opts.method,
    type: opts.type ?? 'query',
    input: opts.input,
    bearer: opts.bearer,
    ...(opts.pinnedCa ? { pinnedCa: opts.pinnedCa } : {}),
    ...(opts.expectedFingerprint
      ? { expectedFingerprint: opts.expectedFingerprint }
      : {}),
    ...(opts.insecure ? { insecure: opts.insecure } : {}),
  });
  const res = await fetchImpl(built.url, built.init);
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
  /** PEM of the local central agent cert — from
   *  `context.tunnelCentralCertificate`. */
  pinnedCa?: string;
  /** `"sha256:<hex>"` — from
   *  `context.tunnelCentralFingerprint`. */
  expectedFingerprint?: string;
  /** Bypass pinning — threaded through from the global
   *  `--insecure-tunnel-relay` flag (see
   *  `dispatcher.ts:isInsecureTunnelRelay`). */
  insecure?: boolean;
}): TunnelSendFn {
  return async (req) => {
    // `req.params` is `{ type: 'query'|'mutation', input: unknown }`
    // per node-client.ts's `proxyFromTunnel`. We unwrap it here so
    // the relay receives flat `{method, type, input}` — that's the
    // shape `handleTunnelRelay` parses on the server side.
    const params = req.params as { type?: 'query' | 'mutation'; input?: unknown };
    try {
      const callOpts: TunnelRelayCallOptions = {
        centralUrl: opts.centralUrl,
        nodeName: opts.nodeName,
        method: req.method,
        input: params?.input,
        bearer: opts.bearer,
      };
      if (opts.fetchImpl) callOpts.fetchImpl = opts.fetchImpl;
      if (params?.type) callOpts.type = params.type;
      if (opts.pinnedCa) callOpts.pinnedCa = opts.pinnedCa;
      if (opts.expectedFingerprint) callOpts.expectedFingerprint = opts.expectedFingerprint;
      if (opts.insecure) callOpts.insecure = opts.insecure;
      const result = await callViaTunnelRelay(callOpts);
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

/**
 * Build a `TunnelSubscribeFn` closure. The returned fn — plugged
 * into `createNodeClient({tunnelSubscribe})` — opens an SSE stream
 * against `<centralUrl>/tunnel-relay/<nodeName>?stream=true`, parses
 * the event frames (each `data:` line is a subscription event; the
 * terminal `event: done\ndata: {ok, error?}` frame closes the
 * stream), and funnels them through the caller's
 * `{onData, onError, onComplete, onStarted?}` handlers.
 *
 * Pinning: same gate as the POST path — uses `buildRelayFetchInit`
 * so mismatch / missing-fingerprint in secure mode throws before
 * any network I/O. Abort semantics: `unsubscribe()` aborts the
 * fetch, which Bun translates into ending the HTTP request; the
 * central agent's SSE handler sees `req.signal.aborted` and
 * iterator.return()-s the subscription, shipping a `stream-cancel`
 * frame to the agent.
 */
export function buildTunnelSubscribe(opts: {
  centralUrl: string;
  bearer: string;
  nodeName: string;
  fetchImpl?: FetchLike;
  pinnedCa?: string;
  expectedFingerprint?: string;
  insecure?: boolean;
}): TunnelSubscribeFn {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as FetchLike);
  return (method, input, handlers) => {
    const abort = new AbortController();
    let settled = false;
    const safeError = (err: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        handlers.onError(err);
      } catch {
        // ignore
      }
    };
    const safeComplete = (): void => {
      if (settled) return;
      settled = true;
      try {
        handlers.onComplete();
      } catch {
        // ignore
      }
    };
    const pump = async (): Promise<void> => {
      let built: BuiltRelayRequest;
      try {
        built = buildRelayFetchInit(
          opts.centralUrl,
          opts.nodeName,
          {
            method,
            type: 'subscription',
            input,
            bearer: opts.bearer,
            signal: abort.signal,
            ...(opts.pinnedCa ? { pinnedCa: opts.pinnedCa } : {}),
            ...(opts.expectedFingerprint
              ? { expectedFingerprint: opts.expectedFingerprint }
              : {}),
            ...(opts.insecure ? { insecure: opts.insecure } : {}),
          },
          { stream: 'true' },
        );
      } catch (err) {
        safeError(err);
        return;
      }
      let res: Response;
      try {
        res = await fetchImpl(built.url, built.init);
      } catch (err) {
        if (abort.signal.aborted) {
          safeComplete();
          return;
        }
        safeError(err);
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        safeError(
          new Error(`tunnel-relay ${res.status}: ${text || res.statusText}`),
        );
        return;
      }
      handlers.onStarted?.();
      if (!res.body) {
        safeError(new Error('tunnel-relay SSE returned an empty body'));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          if (abort.signal.aborted) break;
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Parse one SSE frame at a time — standard \n\n separator.
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (!chunk) continue;
            let eventName = '';
            let dataPayload = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataPayload = line.slice(5).trim();
            }
            if (eventName === 'done') {
              let parsed: { ok: boolean; error?: { code: string; message: string } };
              try {
                parsed = JSON.parse(dataPayload);
              } catch {
                safeError(new Error('tunnel-relay SSE: malformed done frame'));
                return;
              }
              if (parsed.ok) {
                safeComplete();
              } else {
                const err = new Error(parsed.error?.message ?? 'subscription error');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (err as any).code = parsed.error?.code;
                safeError(err);
              }
              return;
            }
            if (!eventName) {
              // default 'message' event
              let data: unknown;
              try {
                data = JSON.parse(dataPayload);
              } catch {
                // Corrupted frame; surface as error.
                safeError(new Error('tunnel-relay SSE: malformed data frame'));
                return;
              }
              if (abort.signal.aborted) return;
              try {
                handlers.onData(data);
              } catch {
                // caller handler threw; continue pumping — their
                // subscribeRemote catches and surfaces.
              }
            }
          }
        }
        // Stream ended without a done frame (server closed body).
        if (abort.signal.aborted) safeComplete();
        else safeError(new Error('tunnel-relay SSE: stream closed without a done frame'));
      } catch (err) {
        if (abort.signal.aborted) {
          safeComplete();
          return;
        }
        safeError(err);
      }
    };
    void pump();
    return {
      unsubscribe(): void {
        if (settled) return;
        // Mark settled so duplicate unsubscribe is a no-op and the
        // pump's next path observes an aborted signal cleanly.
        settled = true;
        try {
          abort.abort();
        } catch {
          // ignore
        }
      },
    };
  };
}
