import type { TunnelSubscribeFn } from "@llamactl/remote";
import {
  buildRelayFetchInit,
  buildTunnelSend,
  callViaTunnelRelay,
  __resetInsecureTunnelWarning,
  type BuiltRelayRequest,
  type FetchLike,
  type TunnelRelayCallOptions,
} from "@llamactl/core/tunnel-relay";

import { hasBoolean, hasString, isRecord } from "./runtime-shape.js";

export {
  buildTunnelSend,
  callViaTunnelRelay,
  __resetInsecureTunnelWarning,
  type FetchLike,
  type TunnelRelayCallOptions,
};

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
interface SafeCallbacks {
  safeError: (err: unknown) => void;
  safeComplete: () => void;
  isAborted: () => boolean;
}

function makeSafeCallbacks(
  handlers: Parameters<TunnelSubscribeFn>[2],
  settledRef: { value: boolean },
  abort: AbortController,
): SafeCallbacks {
  const safeError = (err: unknown): void => {
    if (settledRef.value) return;
    settledRef.value = true;
    try {
      handlers.onError(err);
    } catch {
      // ignore
    }
  };
  const safeComplete = (): void => {
    if (settledRef.value) return;
    settledRef.value = true;
    try {
      handlers.onComplete();
    } catch {
      // ignore
    }
  };
  const isAborted = (): boolean => abort.signal.aborted;
  return { safeError, safeComplete, isAborted };
}

function parseDoneFrame(dataPayload: string): { action: "complete" | "error"; err?: Error } {
  let parsed: { ok: boolean; error?: { code: string; message: string } };
  try {
    const value: unknown = JSON.parse(dataPayload);
    if (!isDoneFrame(value)) {
      return { action: "error", err: new Error("tunnel-relay SSE: invalid done frame") };
    }
    parsed = value;
  } catch {
    return { action: "error", err: new Error("tunnel-relay SSE: malformed done frame") };
  }
  if (parsed.ok) {
    return { action: "complete" };
  }
  const err = Object.assign(new Error(parsed.error?.message ?? "subscription error"), {
    code: parsed.error?.code,
  });
  return { action: "error", err };
}

// default 'message' event
function deliverDataFrame(
  dataPayload: string,
  handlers: Parameters<TunnelSubscribeFn>[2],
  safe: SafeCallbacks,
): { action: "continue" | "error"; err?: Error } {
  let data: unknown;
  try {
    data = JSON.parse(dataPayload);
  } catch {
    return { action: "error", err: new Error("tunnel-relay SSE: malformed data frame") };
  }
  // Buffered frames can remain after unsubscribe/SIGINT; do
  // not deliver data once the subscription is aborted.
  if (safe.isAborted()) return { action: "continue" };
  try {
    handlers.onData(data);
  } catch {
    // caller handler threw; continue pumping — their
    // subscribeRemote catches and surfaces.
  }
  return { action: "continue" };
}

function parseSseChunk(
  chunk: string,
  handlers: Parameters<TunnelSubscribeFn>[2],
  safe: SafeCallbacks,
): { action: "complete" | "error" | "continue"; err?: Error } {
  let eventName = "";
  let dataPayload = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataPayload = line.slice(5).trim();
  }
  if (eventName === "done") {
    return parseDoneFrame(dataPayload);
  }
  if (!eventName) {
    return deliverDataFrame(dataPayload, handlers, safe);
  }
  return { action: "continue" };
}

async function pumpTunnelSse(
  fetchImpl: FetchLike,
  opts: {
    centralUrl: string;
    nodeName: string;
    bearer: string;
    pinnedCa?: string;
    expectedFingerprint?: string;
    insecure?: boolean;
  },
  method: string,
  input: unknown,
  handlers: Parameters<TunnelSubscribeFn>[2],
  abort: AbortController,
  safe: SafeCallbacks,
): Promise<void> {
  let built: BuiltRelayRequest;
  try {
    built = buildRelayFetchInit(
      opts.centralUrl,
      opts.nodeName,
      {
        method,
        type: "subscription",
        input,
        bearer: opts.bearer,
        signal: abort.signal,
        ...(opts.pinnedCa ? { pinnedCa: opts.pinnedCa } : {}),
        ...(opts.expectedFingerprint ? { expectedFingerprint: opts.expectedFingerprint } : {}),
        ...(opts.insecure ? { insecure: opts.insecure } : {}),
      },
      { stream: "true" },
    );
  } catch (err) {
    safe.safeError(err);
    return;
  }
  const res = await openTunnelSseResponse(fetchImpl, built, abort, safe);
  if (!res) return;
  handlers.onStarted?.();
  if (!res.body) {
    safe.safeError(new Error("tunnel-relay SSE returned an empty body"));
    return;
  }
  try {
    const settled = await readTunnelSseStream(res.body, handlers, abort, safe);
    if (settled) return;
    // Stream ended without a done frame (server closed body).
    if (abort.signal.aborted) safe.safeComplete();
    else safe.safeError(new Error("tunnel-relay SSE: stream closed without a done frame"));
  } catch (err) {
    if (abort.signal.aborted) {
      safe.safeComplete();
      return;
    }
    safe.safeError(err);
  }
}

async function openTunnelSseResponse(
  fetchImpl: FetchLike,
  built: BuiltRelayRequest,
  abort: AbortController,
  safe: SafeCallbacks,
): Promise<Response | null> {
  let res: Response;
  try {
    res = await fetchImpl(built.url, built.init);
  } catch (err) {
    if (abort.signal.aborted) {
      safe.safeComplete();
      return null;
    }
    safe.safeError(err);
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    safe.safeError(new Error(`tunnel-relay ${String(res.status)}: ${text || res.statusText}`));
    return null;
  }
  return res;
}

/** Drain complete `\n\n`-separated SSE frames out of `state.buf`.
 *  Returns true when a terminal frame settled the subscription. */
function drainSseFrames(
  state: { buf: string },
  handlers: Parameters<TunnelSubscribeFn>[2],
  safe: SafeCallbacks,
): boolean {
  let idx: number;
  while ((idx = state.buf.indexOf("\n\n")) !== -1) {
    const chunk = state.buf.slice(0, idx);
    state.buf = state.buf.slice(idx + 2);
    if (!chunk) continue;
    const result = parseSseChunk(chunk, handlers, safe);
    if (result.action === "complete") {
      safe.safeComplete();
      return true;
    }
    if (result.action === "error") {
      safe.safeError(result.err ?? new Error("tunnel-relay SSE: unknown error"));
      return true;
    }
  }
  return false;
}

/** Pump the SSE body until a terminal frame settles the subscription
 *  (returns true) or the stream ends / aborts first (returns false). */
async function readTunnelSseStream(
  body: NonNullable<Response["body"]>,
  handlers: Parameters<TunnelSubscribeFn>[2],
  abort: AbortController,
  safe: SafeCallbacks,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = { buf: "" };
  for (;;) {
    if (abort.signal.aborted) return false;
    const { value, done } = await reader.read();
    if (done) return false;
    state.buf += decoder.decode(value, { stream: true });
    // Parse one SSE frame at a time — standard \n\n separator.
    if (drainSseFrames(state, handlers, safe)) return true;
  }
}

export function buildTunnelSubscribe(opts: {
  centralUrl: string;
  bearer: string;
  nodeName: string;
  fetchImpl?: FetchLike;
  pinnedCa?: string;
  expectedFingerprint?: string;
  insecure?: boolean;
}): TunnelSubscribeFn {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  return (method, input, handlers) => {
    const abort = new AbortController();
    const settledRef = { value: false };
    const safe = makeSafeCallbacks(handlers, settledRef, abort);
    void pumpTunnelSse(fetchImpl, opts, method, input, handlers, abort, safe);
    return {
      unsubscribe(): void {
        if (settledRef.value) return;
        // Mark settled so duplicate unsubscribe is a no-op and the
        // pump's next path observes an aborted signal cleanly.
        settledRef.value = true;
        try {
          abort.abort();
        } catch {
          // ignore
        }
      },
    };
  };
}

function isDoneFrame(value: unknown): value is {
  ok: boolean;
  error?: { code: string; message: string };
} {
  if (!isRecord(value) || !hasBoolean(value, "ok")) return false;
  const error = value["error"];
  return (
    error === undefined ||
    (isRecord(error) && hasString(error, "code") && hasString(error, "message"))
  );
}
