// Transport error classification for the web console (#410 P4). The console
// server answers transport-level failures two ways: guard envelopes
// {error: "<consoleCode>"} written by same-origin/session/node guards, and
// real tRPC error envelopes from the router. SSE drops surface as
// TRPCClientError whose cause chain ends in a SuppressedError wrapping an
// eventsource@4 ErrorEvent (its numeric `code` is the HTTP status), so the
// classifier walks shape/cause/error/suppressed breadth-first rather than a
// single .cause hop.

export type TransportErrorKind =
  | "network"
  | "invalid_session"
  | "forbidden"
  | "not_exposed"
  | "unknown_node"
  | "node_not_dispatchable"
  | "workload_refused"
  | "procedure";

export interface ClassifiedTransportError {
  kind: TransportErrorKind;
  retryable: boolean;
  status?: number;
  consoleCode?: string;
  trpcCode?: string;
  message: string;
}

const CONSOLE_CODE_KINDS: Record<string, TransportErrorKind> = {
  invalid_session: "invalid_session",
  cross_site_request_forbidden: "forbidden",
  misdirected_host: "forbidden",
  procedure_not_exposed: "not_exposed",
  bad_batch: "not_exposed",
  unknown_node: "unknown_node",
  node_not_dispatchable: "node_not_dispatchable",
  bad_node: "node_not_dispatchable",
};

const MAX_DEPTH = 4;

interface Extras {
  status?: number | undefined;
  consoleCode?: string | undefined;
  trpcCode?: string | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function done(
  message: string,
  kind: TransportErrorKind,
  extra: Extras = {},
): ClassifiedTransportError {
  const classified: ClassifiedTransportError = {
    kind,
    retryable: kind === "network",
    message,
  };
  if (extra.status !== undefined) classified.status = extra.status;
  if (extra.consoleCode !== undefined) classified.consoleCode = extra.consoleCode;
  if (extra.trpcCode !== undefined) classified.trpcCode = extra.trpcCode;
  return classified;
}

function collectCandidates(err: unknown): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const visited = new Set<unknown>();
  let frontier: unknown[] = [err];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: unknown[] = [];
    for (const candidate of frontier) {
      if (!isObject(candidate) || visited.has(candidate)) continue;
      visited.add(candidate);
      candidates.push(candidate);
      if (depth === MAX_DEPTH) continue;
      next.push(
        candidate["shape"],
        candidate["cause"],
        candidate["error"],
        candidate["suppressed"],
      );
    }
    frontier = next;
  }
  return candidates;
}

// A real tRPC error envelope always wins over HTTP status: an envelope
// UNAUTHORIZED at 401 is a procedure error, not an invalid session.
interface EnvelopeHit {
  trpcCode: string;
  status: number | undefined;
}

function envelopeCode(
  err: unknown,
  candidates: Record<string, unknown>[],
): EnvelopeHit | undefined {
  const errData = isObject(err) ? err["data"] : undefined;
  if (isObject(errData) && typeof errData["code"] === "string") {
    const status = errData["httpStatus"];
    return {
      trpcCode: errData["code"],
      status: typeof status === "number" ? status : undefined,
    };
  }
  for (const candidate of candidates) {
    const data = candidate["data"];
    const code = candidate["code"];
    if (
      isObject(data) &&
      typeof data["code"] === "string" &&
      typeof code === "number" &&
      code < 0
    ) {
      const status = data["httpStatus"];
      return {
        trpcCode: data["code"],
        status: typeof status === "number" ? status : undefined,
      };
    }
  }
  return undefined;
}

function responseStatus(err: unknown): number | undefined {
  if (!isObject(err)) return undefined;
  const meta = err["meta"];
  if (!isObject(meta)) return undefined;
  const response = meta["response"];
  if (!isObject(response)) return undefined;
  const status = response["status"];
  return typeof status === "number" ? status : undefined;
}

function responseErrorCode(err: unknown): string | undefined {
  if (!isObject(err)) return undefined;
  const meta = err["meta"];
  if (!isObject(meta)) return undefined;
  const body = meta["responseJSON"];
  if (!isObject(body) || Array.isArray(body)) return undefined;
  const code = body["error"];
  return typeof code === "string" ? code : undefined;
}

function candidateStatus(candidate: Record<string, unknown>): number | undefined {
  const code = candidate["code"];
  if (typeof code === "number" && code >= 100 && code <= 599) return code;
  const status = candidate["status"];
  if (typeof status === "number" && status >= 100 && status <= 599) return status;
  return undefined;
}

function statusKind(status: number): TransportErrorKind {
  switch (status) {
    case 401:
      return "invalid_session";
    case 403:
    case 421:
      return "forbidden";
    case 404:
      return "not_exposed";
    case 400:
      return "node_not_dispatchable";
    case 409:
      return "workload_refused";
    default:
      return status >= 400 && status < 500 ? "procedure" : "network";
  }
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (isObject(err) && typeof err["message"] === "string") return err["message"];
  return "Unknown error";
}

function resolveStatus(err: unknown, candidates: Record<string, unknown>[]): number | undefined {
  const meta = responseStatus(err);
  if (meta !== undefined) return meta;
  for (const candidate of candidates) {
    const found = candidateStatus(candidate);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function classifyTransportError(err: unknown): ClassifiedTransportError {
  const message = messageOf(err);
  try {
    const candidates = collectCandidates(err);
    const envelope = envelopeCode(err, candidates);
    if (envelope) {
      return done(message, "procedure", envelope);
    }
    const consoleCode = responseErrorCode(err);
    const status = resolveStatus(err, candidates);
    if (consoleCode !== undefined) {
      const mapped = CONSOLE_CODE_KINDS[consoleCode];
      if (mapped) return done(message, mapped, { consoleCode, status });
      if (status === 409) {
        return done(message, "workload_refused", { consoleCode, status });
      }
    }
    if (status !== undefined) {
      return done(message, statusKind(status), { status, consoleCode });
    }
    return done(message, "network", { consoleCode });
  } catch {
    return done(message, "network");
  }
}
