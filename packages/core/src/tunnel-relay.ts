import { createHash, timingSafeEqual } from "node:crypto";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TunnelRelayCallOptions {
  centralUrl: string;
  nodeName: string;
  method: string;
  input: unknown;
  bearer: string;
  fetchImpl?: FetchLike;
  type?: "query" | "mutation";
  pinnedCa?: string;
  expectedFingerprint?: string;
  insecure?: boolean;
  timeoutMs?: number;
}

export interface BuildRelayFetchInitOptions {
  method: string;
  type: "query" | "mutation" | "subscription";
  input: unknown;
  bearer: string;
  pinnedCa?: string;
  expectedFingerprint?: string;
  insecure?: boolean;
  signal?: AbortSignal;
}

export interface BuiltRelayRequest {
  url: string;
  init: Parameters<FetchLike>[1];
}

interface TunnelResEnvelope {
  type: "res";
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface TunnelSendRequest {
  id: string;
  method: string;
  params: unknown;
}

export interface TunnelSendResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string } | undefined;
}

export type TunnelSendFn = (req: TunnelSendRequest) => Promise<TunnelSendResponse>;

let warnedAboutInsecureTunnel = false;

export function __resetInsecureTunnelWarning(): void {
  warnedAboutInsecureTunnel = false;
}

function computeFingerprint(certPem: string): string {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(certPem);
  if (!match?.[1]) throw new Error("not a valid cert PEM");
  const der = Buffer.from(match[1].replaceAll(/\s+/g, ""), "base64");
  const hex = createHash("sha256").update(der).digest("hex");
  return `sha256:${hex}`;
}

function fingerprintsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function enforceRelayPinning(opts: {
  pinnedCa?: string;
  expectedFingerprint?: string;
  insecure?: boolean;
}): void {
  if (opts.insecure) {
    if (!warnedAboutInsecureTunnel) {
      process.stderr.write(
        "WARN: tunnel-relay fingerprint check bypassed (--insecure-tunnel-relay)\n",
      );
      warnedAboutInsecureTunnel = true;
    }
    return;
  }
  if (!opts.pinnedCa || !opts.expectedFingerprint) {
    throw new Error(
      "tunnelCentralFingerprint + tunnelCentralCertificate must be " +
        "set in kubeconfig context, or pass --insecure-tunnel-relay to " +
        "bypass (run `llamactl tunnel pin-central` to populate)",
    );
  }
  const computed = computeFingerprint(opts.pinnedCa);
  if (!fingerprintsEqual(computed, opts.expectedFingerprint)) {
    throw new Error(
      `tunnel-relay fingerprint mismatch: expected ${opts.expectedFingerprint}, got ${computed}`,
    );
  }
}

export function buildRelayFetchInit(
  centralUrl: string,
  nodeName: string,
  opts: BuildRelayFetchInitOptions,
  query?: Record<string, string>,
): BuiltRelayRequest {
  enforceRelayPinning(opts);
  const base = centralUrl.replace(/\/$/, "");
  let url = `${base}/tunnel-relay/${encodeURIComponent(nodeName)}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const init: Parameters<FetchLike>[1] = {
    method: "POST",
    headers: {
      "content-type": "application/json",
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

const RELAY_POST_TIMEOUT_MS = 30_000;

export async function callViaTunnelRelay(opts: TunnelRelayCallOptions): Promise<unknown> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? RELAY_POST_TIMEOUT_MS;
  const built = buildRelayFetchInit(opts.centralUrl, opts.nodeName, {
    method: opts.method,
    type: opts.type ?? "query",
    input: opts.input,
    bearer: opts.bearer,
    signal: AbortSignal.timeout(timeoutMs),
    ...(opts.pinnedCa ? { pinnedCa: opts.pinnedCa } : {}),
    ...(opts.expectedFingerprint ? { expectedFingerprint: opts.expectedFingerprint } : {}),
    ...(opts.insecure ? { insecure: opts.insecure } : {}),
  });
  let res: Response;
  try {
    res = await fetchImpl(built.url, built.init);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      const te = Object.assign(new Error(`tunnel-relay timed out after ${String(timeoutMs)}ms`), {
        code: "tunnel-timeout",
      });
      throw te;
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`tunnel-relay ${String(res.status)}: ${text || res.statusText}`);
  }
  const envelope = (await res.json()) as TunnelResEnvelope;
  if (envelope.error) {
    const err = new Error(envelope.error.message) as Error & { code?: string };
    err.code = envelope.error.code;
    throw err;
  }
  return envelope.result;
}

export function buildTunnelSend(opts: {
  centralUrl: string;
  bearer: string;
  nodeName: string;
  fetchImpl?: FetchLike;
  pinnedCa?: string;
  expectedFingerprint?: string;
  insecure?: boolean;
}): TunnelSendFn {
  return async (req) => {
    const params = req.params as { type?: "query" | "mutation"; input?: unknown };
    try {
      const callOpts: TunnelRelayCallOptions = {
        centralUrl: opts.centralUrl,
        nodeName: opts.nodeName,
        method: req.method,
        input: params.input,
        bearer: opts.bearer,
      };
      if (opts.fetchImpl) callOpts.fetchImpl = opts.fetchImpl;
      if (params.type) callOpts.type = params.type;
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
          code: e.code ?? "tunnel-relay-failed",
          message: e.message,
        },
      };
    }
  };
}
