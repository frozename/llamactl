/**
 * InferenceRpcV1 caller side (P4.1): the embedded, direct and tunnel
 * clients and the `worker-rpc` BackendExecutor the unified proxy acquires.
 * The embedded client drives the worker procedures in-process through the
 * same tRPC input parsing the wire uses; the direct client speaks the
 * owner's agent route over TLS pinned to its certificate; the tunnel client
 * reaches an owner that dials in through central's relay. The owner's
 * kubeconfig node picks the transport, with no probing fallback, and every
 * transport yields the same values (golden.json).
 *
 * Remote clients validate each result and frame at the boundary, bound
 * every unary call with a timeout, and read a stream ahead of its consumer
 * into a queue capped in bytes: a frame or backlog past a cap ends the
 * stream typed `stream-overflow` and tears the transport down, which
 * cancels the attempt upstream.
 *
 * Remote clients present the caller's service credential, never the
 * operator bearer: as the bearer on a direct dial, pinned to the owner's
 * certificate. Over the tunnel the credential never leaves the caller:
 * central forwards whatever a relay request carries to whichever node
 * holds the name, so each call carries a fresh single-use token derived
 * from the credential instead, bound to the node, the call, its input and
 * the relay hop, whose own bearer central checks.
 *
 * The executor negotiates, fences on the worker's catalog, submits, then
 * consumes the stream, checking every event with Nova's sequence rules.
 * It never re-submits once a submit may have been accepted: a lost
 * acknowledgement is resolved through `status`, a lost stream through
 * `cancel` then `status`, and an outcome it cannot establish is surfaced
 * as `unknown-outcome`. Only a stale generation is retried, once, after a
 * single catalog refresh. A worker that positively reports no RPC — it
 * answers `not-advertised`, or it predates the route — keeps the request
 * on the existing path; every other negotiation failure fails closed.
 */
import type { PeerNode } from "@llamactl/core/config/peers";
import type { ClusterNode } from "@llamactl/core/config/schema";
import type { z } from "zod";

import { type inferenceContracts, inferenceRpc, type routingCatalog } from "@llamactl/core";
import { currentContext, loadConfig } from "@llamactl/core/config/kubeconfig";
import { listPeers } from "@llamactl/core/config/peers";
import { resolveSecret } from "@llamactl/core/config/secret";
import {
  buildRelayFetchInit,
  callViaTunnelRelay,
  enforceRelayPinning,
} from "@llamactl/core/tunnel-relay";
import {
  type ExecutionContentPayload,
  type ExecutionEventV1,
  type ExecutionTerminal,
  INITIAL_EXECUTION_SEQUENCE_STATE,
  stepExecutionSequence,
} from "@novaproto/contracts";

import type { BackendExecutionContext, BackendExecutor } from "../proxy/create-proxy.js";

import { makePinnedFetch, type PinnedFetch } from "../client/links.js";
import { mintServiceToken, relayPrincipalOf, SERVICE_TOKEN_HEADER } from "../server/auth.js";
import {
  frameBytes,
  INFERENCE_RPC_STREAM_LIMITS,
  type StreamLimits,
  TUNNEL_STREAM_OVERFLOW,
} from "../tunnel/messages.js";
import { inferenceRpcRouter } from "./procedures.js";

type Claims = inferenceRpc.InferenceServiceClaimsV1;
type Envelope = inferenceContracts.InferenceEnvelopeV1;
type Rejection = inferenceRpc.InferenceRpcRejectionV1;
type StreamFrame = inferenceRpc.InferenceRpcStreamFrameV1;
type AttemptStatus = inferenceRpc.InferenceRpcAttemptStatusV1;

export type InferenceRpcTransport = "embedded" | "direct" | "tunnel";
export interface InferenceRpcClient {
  readonly transport: InferenceRpcTransport;
  negotiate(
    input: inferenceRpc.InferenceRpcNegotiateInputV1,
  ): Promise<inferenceRpc.InferenceRpcNegotiateResultV1>;
  catalog(): Promise<inferenceRpc.InferenceRpcCatalogResultV1>;
  submit(
    input: inferenceRpc.InferenceRpcSubmitInputV1,
  ): Promise<inferenceRpc.InferenceRpcSubmitResultV1>;
  stream(
    input: inferenceRpc.InferenceRpcStreamRequestV1,
    signal?: AbortSignal,
  ): AsyncIterable<StreamFrame>;
  status(
    input: inferenceRpc.InferenceRpcStatusRequestV1,
  ): Promise<inferenceRpc.InferenceRpcStatusResultV1>;
  cancel(
    input: inferenceRpc.InferenceRpcCancelRequestV1,
  ): Promise<inferenceRpc.InferenceRpcCancelResultV1>;
}

/** In-process client for the local worker, presenting server-derived claims. */
export function createEmbeddedInferenceRpcClient(claims: Claims): InferenceRpcClient {
  const caller = (signal?: AbortSignal): ReturnType<typeof inferenceRpcRouter.createCaller> =>
    inferenceRpcRouter.createCaller({ inferenceClaims: claims }, signal ? { signal } : undefined);
  return {
    transport: "embedded",
    negotiate: async (input) => await caller().negotiate(input),
    catalog: async () => await caller().catalog(),
    submit: async (input) => await caller().submit(input),
    stream: async function* (input, signal): AsyncGenerator<StreamFrame> {
      yield* await caller(signal).stream(input);
    },
    status: async (input) => await caller().status(input),
    cancel: async (input) => await caller().cancel(input),
  };
}

// ---- remote clients: direct and tunnel -------------------------------------

export interface RemoteInferenceRpcClientOptions {
  /** Bounds each unary call, and a stream's wait for its first frame. Default 10 s. */
  callTimeoutMs?: number;
  /** Caps on what a stream reads ahead of its consumer. */
  limits?: StreamLimits;
  /** Observes a stream's queued bytes each time they change. */
  onStreamQueue?: (attemptId: string, queuedBytes: number) => void;
}

export interface DirectInferenceRpcClientOptions extends RemoteInferenceRpcClientOptions {
  /** The owner's kubeconfig node: its endpoint and pinned certificate. */
  node: ClusterNode;
  /** The caller's service credential for the owner's worker RPC. */
  serviceCredential: string;
  /** Defaults to a fetch pinned to the node's certificate. */
  fetch?: PinnedFetch;
}

export interface TunnelInferenceRpcClientOptions extends RemoteInferenceRpcClientOptions {
  centralUrl: string;
  centralCertificate?: string;
  centralFingerprint?: string;
  /** The name the owner dials central with. */
  nodeName: string;
  /** Central's relay bearer: it authorizes the relay hop only and never reaches the node. */
  bearer: string;
  /**
   * The caller's service credential. It never leaves the caller: each call
   * sends a single-use token derived from it, which the owner verifies.
   */
  serviceCredential: string;
  /** Defaults to global fetch; the relay request is pinned to central either way. */
  fetch?: PinnedFetch;
}

/** The stream outran its consumer past a cap; the attempt was cancelled upstream. */
export class InferenceRpcStreamOverflowError extends Error {
  readonly code = TUNNEL_STREAM_OVERFLOW;
}

/** The owner's agent refused the service credential before any procedure ran (HTTP 401). */
export class InferenceRpcCredentialRefusedError extends Error {}

/**
 * The owner answered, past its authentication, that it has no
 * `inferenceRpc` route: a build that predates the RPC. That is a
 * positive "no RPC here", like `not-advertised`.
 */
export class InferenceRpcRouteMissingError extends Error {}

const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const RPC = "inferenceRpc";

type CallType = "query" | "mutation";

interface SseEvent {
  name: string | undefined;
  data: string;
  bytes: number;
}

type WireStep =
  | { kind: "frame"; data: string }
  | { kind: "end" }
  | { kind: "error"; code: string; message: string }
  | { kind: "skip" };

/** The transport-specific half of a remote client. */
interface RpcWire {
  readonly transport: "direct" | "tunnel";
  call(procedure: string, type: CallType, input: unknown): Promise<unknown>;
  /** Opens the attempt's stream response (server-sent events). */
  open(input: unknown, signal: AbortSignal): Promise<Response>;
  read(event: SseEvent): WireStep;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function timed<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (!controller.signal.aborted) throw err;
    throw new Error(`the worker RPC call timed out after ${String(timeoutMs)} ms`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/** tRPC's own "no such procedure" error: the route is absent, not failing. */
function isMissingProcedure(status: number, error: unknown): boolean {
  const data = isRecord(error) ? error["data"] : undefined;
  return status === 404 && isRecord(data) && data["code"] === "NOT_FOUND";
}

/** The data of a tRPC fetch-adapter response, or the error it carries. */
async function trpcData(res: Response, procedure: string): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null);
  const result = isRecord(body) ? body["result"] : undefined;
  if (res.ok && isRecord(result)) return result["data"];
  const error = isRecord(body) ? body["error"] : undefined;
  const message = isRecord(error) && typeof error["message"] === "string" ? error["message"] : "";
  const failure = `worker RPC ${procedure} failed: HTTP ${String(res.status)} ${message}`.trim();
  if (res.status === 401) throw new InferenceRpcCredentialRefusedError(failure);
  if (isMissingProcedure(res.status, error)) throw new InferenceRpcRouteMissingError(failure);
  throw new Error(failure);
}

/**
 * A node that predates the RPC answers a tunneled call to it from its
 * own router caller, which throws tRPC's "No procedure found"; the
 * tunnel client relays that as `handler-threw`.
 */
function relayError(err: unknown): unknown {
  const code = isRecord(err) ? err["code"] : undefined;
  const missing =
    code === "handler-threw" &&
    /^No procedure found on path "inferenceRpc[.,]/.test(errorMessage(err));
  return missing ? new InferenceRpcRouteMissingError(errorMessage(err), { cause: err }) : err;
}

function directWire(opts: DirectInferenceRpcClientOptions): RpcWire {
  const pinned = opts.fetch ?? makePinnedFetch(opts.node);
  const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const root = opts.node.endpoint.endsWith("/")
    ? opts.node.endpoint.slice(0, -1)
    : opts.node.endpoint;
  const authorization = `Bearer ${opts.serviceCredential}`;
  const url = (procedure: string, input?: unknown): string => {
    const path = `${root}/trpc/${RPC}.${procedure}`;
    return input === undefined
      ? path
      : `${path}?input=${encodeURIComponent(JSON.stringify(input))}`;
  };
  return {
    transport: "direct",
    call: (procedure, type, input) =>
      timed(timeoutMs, async (signal) => {
        const res =
          type === "query"
            ? await pinned(url(procedure, input), { headers: { authorization }, signal })
            : await pinned(url(procedure), {
                method: "POST",
                headers: { authorization, "content-type": "application/json" },
                body: JSON.stringify(input),
                signal,
              });
        return await trpcData(res, procedure);
      }),
    open: (input, signal) =>
      pinned(url("stream", input), {
        headers: { authorization, accept: "text/event-stream" },
        signal,
      }),
    read: ({ name, data }): WireStep => {
      if (name === undefined) return { kind: "frame", data };
      if (name === "return") return { kind: "end" };
      if (name === "serialized-error") {
        return { kind: "error", code: "worker-error", message: data };
      }
      return { kind: "skip" };
    },
  };
}

function relayDone(data: string): WireStep {
  let done: unknown;
  try {
    done = JSON.parse(data);
  } catch {
    done = null;
  }
  if (isRecord(done) && done["ok"] === true) return { kind: "end" };
  const error = isRecord(done) ? done["error"] : undefined;
  if (!isRecord(error) || typeof error["code"] !== "string") {
    return { kind: "error", code: "protocol-error", message: "malformed relay done frame" };
  }
  const message = typeof error["message"] === "string" ? error["message"] : "";
  return { kind: "error", code: error["code"], message };
}

function tunnelWire(opts: TunnelInferenceRpcClientOptions): RpcWire {
  const pinning = {
    ...(opts.centralCertificate !== undefined ? { pinnedCa: opts.centralCertificate } : {}),
    ...(opts.centralFingerprint !== undefined
      ? { expectedFingerprint: opts.centralFingerprint }
      : {}),
  };
  // Refuse an unpinned central up front rather than on the first call.
  enforceRelayPinning(pinning);
  const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const baseFetch = opts.fetch ?? fetch;
  const relayPrincipal = relayPrincipalOf(opts.bearer);
  // Minted per request, so a retried call never resends a spent token.
  const relayFetch =
    (method: string, input: unknown): PinnedFetch =>
    (url, init) => {
      const headers = new Headers(init?.headers);
      const call = { node: opts.nodeName, method, input, relayPrincipal };
      headers.set(SERVICE_TOKEN_HEADER, mintServiceToken(opts.serviceCredential, call));
      return baseFetch(url, { ...init, headers });
    };
  const target = { centralUrl: opts.centralUrl, nodeName: opts.nodeName, bearer: opts.bearer };
  return {
    transport: "tunnel",
    call: async (procedure, type, input): Promise<unknown> => {
      const method = `${RPC}.${procedure}`;
      try {
        return await callViaTunnelRelay({
          ...target,
          ...pinning,
          method,
          type,
          input,
          timeoutMs,
          fetchImpl: relayFetch(method, input),
        });
      } catch (err) {
        throw relayError(err);
      }
    },
    open: (input, signal): Promise<Response> => {
      const { url, init } = buildRelayFetchInit(
        opts.centralUrl,
        opts.nodeName,
        {
          ...pinning,
          method: `${RPC}.stream`,
          type: "subscription",
          input,
          bearer: opts.bearer,
          signal,
        },
        { stream: "true" },
      );
      return relayFetch(`${RPC}.stream`, input)(url, init);
    },
    read: ({ name, data }): WireStep => {
      if (name === undefined) return { kind: "frame", data };
      return name === "done" ? relayDone(data) : { kind: "skip" };
    },
  };
}

function overflowError(message: string): InferenceRpcStreamOverflowError {
  return new InferenceRpcStreamOverflowError(message);
}

/** Splits server-sent events; a frame past the frame cap is an overflow, complete or not. */
function sseParser(maxFrameBytes: number): (text: string) => SseEvent[] {
  let pending = "";
  const parse = (block: string): SseEvent | null => {
    const bytes = frameBytes(block);
    if (bytes > maxFrameBytes) {
      throw overflowError(
        `a ${String(bytes)}-byte frame exceeds the ${String(maxFrameBytes)}-byte frame cap`,
      );
    }
    let name: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    return name === undefined && data.length === 0 ? null : { name, data: data.join("\n"), bytes };
  };
  return (text) => {
    pending += text;
    const events: SseEvent[] = [];
    for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
      const event = parse(pending.slice(0, end));
      pending = pending.slice(end + 2);
      if (event !== null) events.push(event);
    }
    if (frameBytes(pending) > maxFrameBytes) {
      throw overflowError(
        `an unterminated frame passed the ${String(maxFrameBytes)}-byte frame cap`,
      );
    }
    return events;
  };
}

interface FrameQueue {
  /** False when the frame would take the backlog past the cap. */
  push(frame: StreamFrame, bytes: number): boolean;
  end(): void;
  fail(error: unknown): void;
  next(): Promise<IteratorResult<StreamFrame>>;
}

/** Frames read ahead of the consumer, at most `maxQueuedBytes` of them. */
function frameQueue(maxQueuedBytes: number, observe: (queuedBytes: number) => void): FrameQueue {
  const items: { frame: StreamFrame; bytes: number }[] = [];
  let queued = 0;
  let closed = false;
  let failure: { error: unknown } | null = null;
  let waiter: (() => void) | null = null;
  const wake = (): void => {
    const resolve = waiter;
    waiter = null;
    resolve?.();
  };
  return {
    push(frame, bytes): boolean {
      if (queued + bytes > maxQueuedBytes) return false;
      items.push({ frame, bytes });
      queued += bytes;
      observe(queued);
      wake();
      return true;
    },
    end(): void {
      closed = true;
      wake();
    },
    fail(error): void {
      if (closed) return;
      closed = true;
      failure = { error };
      wake();
    },
    async next(): Promise<IteratorResult<StreamFrame>> {
      for (;;) {
        const head = items.shift();
        if (head !== undefined) {
          queued -= head.bytes;
          observe(queued);
          return { value: head.frame, done: false };
        }
        if (failure !== null) throw failure.error;
        if (closed) return { value: undefined, done: true };
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
  };
}

function frameOf(data: string): StreamFrame {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("the worker RPC stream sent a frame that is not JSON");
  }
  if (!inferenceRpc.InferenceRpcStreamFrameV1Schema.safeParse(value).success) {
    throw new Error("the worker RPC stream sent a malformed frame");
  }
  // Validated, then passed on by value, so every transport yields the same frames.
  return value as StreamFrame;
}

interface StreamReading {
  wire: RpcWire;
  input: inferenceRpc.InferenceRpcStreamRequestV1;
  transport: AbortController;
  queue: FrameQueue;
  limits: StreamLimits;
  onFrame: () => void;
}

/** Applies one event; false once the stream ended. */
function deliver(r: StreamReading, event: SseEvent): boolean {
  const step = r.wire.read(event);
  switch (step.kind) {
    case "skip": {
      return true;
    }
    case "end": {
      r.queue.end();
      return false;
    }
    case "error": {
      throw step.code === TUNNEL_STREAM_OVERFLOW
        ? overflowError(step.message)
        : new Error(`the worker RPC stream failed: ${step.code}: ${step.message}`);
    }
    case "frame": {
      if (!r.queue.push(frameOf(step.data), event.bytes)) {
        throw overflowError(
          `the consumer fell more than ${String(r.limits.maxQueuedBytes)} bytes behind the stream`,
        );
      }
      r.onFrame();
      return true;
    }
  }
}

/**
 * Reads the stream eagerly into the bounded queue. Any failure ends the
 * queue with it and tears the transport down: on an overflow that is the
 * upstream cancel, since the worker treats the drop as a disconnect.
 */
async function readStream(r: StreamReading): Promise<void> {
  try {
    const res = await r.wire.open(r.input, r.transport.signal);
    if (!res.ok || res.body === null) {
      throw new Error(`the worker RPC stream did not open: HTTP ${String(res.status)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const split = sseParser(r.limits.maxFrameBytes);
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      for (const event of split(decoder.decode(chunk.value, { stream: true }))) {
        if (!deliver(r, event)) return;
      }
    }
    r.queue.end();
  } catch (err) {
    r.queue.fail(err);
  } finally {
    r.transport.abort();
  }
}

async function* streamFrames(
  wire: RpcWire,
  opts: RemoteInferenceRpcClientOptions,
  input: inferenceRpc.InferenceRpcStreamRequestV1,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamFrame> {
  const transport = new AbortController();
  const leave = (): void => {
    transport.abort();
  };
  signal?.addEventListener("abort", leave, { once: true });
  if (signal?.aborted === true) leave();
  const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const firstFrame = setTimeout(leave, timeoutMs);
  const limits = opts.limits ?? INFERENCE_RPC_STREAM_LIMITS;
  const queue = frameQueue(limits.maxQueuedBytes, (bytes) => {
    opts.onStreamQueue?.(input.attemptId, bytes);
  });
  const reading = readStream({
    wire,
    input,
    transport,
    queue,
    limits,
    onFrame: () => {
      clearTimeout(firstFrame);
    },
  });
  try {
    for (let next = await queue.next(); next.done !== true; next = await queue.next()) {
      yield next.value;
    }
  } finally {
    clearTimeout(firstFrame);
    signal?.removeEventListener("abort", leave);
    // Ended or left: either way the transport goes, which the worker sees.
    leave();
    await reading;
  }
}

function remoteClient(wire: RpcWire, opts: RemoteInferenceRpcClientOptions): InferenceRpcClient {
  const validated = async <T>(
    schema: z.ZodType<T>,
    procedure: string,
    type: CallType,
    input?: unknown,
  ): Promise<T> => {
    const result = await wire.call(procedure, type, input);
    if (!schema.safeParse(result).success) {
      throw new Error(`the worker sent a malformed ${procedure} result`);
    }
    return result as T;
  };
  return {
    transport: wire.transport,
    negotiate: (input) =>
      validated(inferenceRpc.InferenceRpcNegotiateResultV1Schema, "negotiate", "query", input),
    catalog: () => validated(inferenceRpc.InferenceRpcCatalogResultV1Schema, "catalog", "query"),
    submit: (input) =>
      validated(inferenceRpc.InferenceRpcSubmitResultV1Schema, "submit", "mutation", input),
    stream: (input, signal) => streamFrames(wire, opts, input, signal),
    status: (input) =>
      validated(inferenceRpc.InferenceRpcStatusResultV1Schema, "status", "query", input),
    cancel: (input) =>
      validated(inferenceRpc.InferenceRpcCancelResultV1Schema, "cancel", "mutation", input),
  };
}

/** A client for the owner's agent over TLS pinned to the node's certificate. */
export function createDirectInferenceRpcClient(
  opts: DirectInferenceRpcClientOptions,
): InferenceRpcClient {
  return remoteClient(directWire(opts), opts);
}

/** A client for an owner that dials central, through central's pinned relay. */
export function createTunnelInferenceRpcClient(
  opts: TunnelInferenceRpcClientOptions,
): InferenceRpcClient {
  return remoteClient(tunnelWire(opts), opts);
}

// ---- attempt outcome ------------------------------------------------------

type AttemptItem =
  | { type: "content"; payload: ExecutionContentPayload }
  | { type: "terminal"; terminal: ExecutionTerminal };

type AttemptOutcome =
  | { kind: "fallback" }
  | { kind: "rejected"; rejection: Rejection }
  | { kind: "settled"; terminal: ExecutionTerminal }
  | { kind: "stream"; items: AsyncGenerator<AttemptItem> };

const UNKNOWN_OUTCOME: ExecutionTerminal = {
  outcome: "unknown-outcome",
  message: "the attempt outcome could not be established",
  usage: { source: "unknown" },
};

const DEFAULT_RESOLVE_TIMEOUT_MS = 15_000;

/**
 * A call that failed before the worker could accept anything: a refused
 * credential is outside the claims, anything else leaves the target
 * unavailable. Both fail closed.
 */
function refusal(err: unknown, what: string): Rejection {
  return err instanceof InferenceRpcCredentialRefusedError
    ? { code: "unauthorized-scope", message: `the worker refused the service credential: ${what}` }
    : { code: "target-unavailable", message: `${what}: ${errorMessage(err)}` };
}

/** The only outcome a non-terminal status can resolve to: never a replay. */
function settledFrom(status: AttemptStatus): ExecutionTerminal {
  return status.terminal ?? UNKNOWN_OUTCOME;
}

/** Retries an idempotent call through transport loss until `until`; null if it never answered. */
async function retrying<T>(until: number, call: () => Promise<T>): Promise<T | null> {
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try {
      return await call();
    } catch {
      if (Date.now() + delay > until) return null;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Resolves an attempt the caller lost track of. `status` and `cancel` are
 * idempotent, so both are retried through a transport loss, across a
 * tunnel reconnect, for up to the resolve window; `submit` never is.
 */
interface Resolver {
  status(attemptId: string): Promise<AttemptStatus | null>;
  cancel(attemptId: string): Promise<void>;
  /** A stream lost before its terminal: stop the attempt, then read how it ended. */
  lost(attemptId: string, lastSequence: number | undefined): Promise<ExecutionTerminal>;
}

/**
 * How a stream that broke before its terminal ended. A completion counts
 * only when the worker's terminal was the very next event, so output lost
 * in transit is never passed off as complete.
 */
function terminalAfterLoss(
  status: AttemptStatus,
  lastSequence: number | undefined,
): ExecutionTerminal {
  const terminal = settledFrom(status);
  if (terminal.outcome !== "completed") return terminal;
  if (lastSequence !== undefined && status.terminalSequence === lastSequence + 1) return terminal;
  return {
    outcome: "failed",
    started: true,
    error: {
      code: "incomplete",
      message: "the worker completed, but output was lost in transit; it is not replayed",
      retryable: false,
    },
    model: terminal.model,
    ...(terminal.deployment !== undefined ? { deployment: terminal.deployment } : {}),
    usage: terminal.usage,
  };
}

function resolverFor(client: InferenceRpcClient, windowMs: number): Resolver {
  const statusUntil = async (attemptId: string, until: number): Promise<AttemptStatus | null> => {
    const result = await retrying(until, () => client.status({ attemptId }));
    return result?.outcome === "status" ? result : null;
  };
  const cancelUntil = async (attemptId: string, until: number): Promise<void> => {
    await retrying(until, () => client.cancel({ attemptId }));
  };
  return {
    status: (attemptId) => statusUntil(attemptId, Date.now() + windowMs),
    cancel: (attemptId) => cancelUntil(attemptId, Date.now() + windowMs),
    lost: async (attemptId, lastSequence): Promise<ExecutionTerminal> => {
      const until = Date.now() + windowMs;
      await cancelUntil(attemptId, until);
      const status = await statusUntil(attemptId, until);
      return status === null ? UNKNOWN_OUTCOME : terminalAfterLoss(status, lastSequence);
    },
  };
}

function protocolError(message: string): ExecutionTerminal {
  return {
    outcome: "failed",
    started: true,
    error: { code: "protocol-error", message, retryable: false },
    usage: { source: "unknown" },
  };
}

/**
 * How a stream that threw ended. An overflow already tore the transport
 * down, which cancels the attempt; the explicit cancel gets it
 * acknowledged. Any other break is resolved through cancel and status.
 */
async function brokenTerminal(
  resolver: Resolver,
  attemptId: string,
  err: unknown,
  lastSequence: number | undefined,
): Promise<ExecutionTerminal> {
  if (!(err instanceof InferenceRpcStreamOverflowError)) {
    return await resolver.lost(attemptId, lastSequence);
  }
  await resolver.cancel(attemptId);
  return {
    outcome: "failed",
    started: true,
    error: { code: "stream-overflow", message: err.message, retryable: false },
    usage: { source: "unknown" },
  };
}

/**
 * Validated attempt items: every received event is stepped through Nova's
 * sequence rules, and a stream that breaks or ends without its terminal
 * is resolved rather than re-run.
 */
async function* attemptItems(
  resolver: Resolver,
  attemptId: string,
  frames: AsyncIterator<StreamFrame>,
  first: ExecutionEventV1,
): AsyncGenerator<AttemptItem> {
  let sequence = stepExecutionSequence(INITIAL_EXECUTION_SEQUENCE_STATE, first).state;
  let lastSequence = first.sequence;
  let broken: unknown;
  try {
    for (let next = await frames.next(); next.done !== true; next = await frames.next()) {
      if (next.value.frame !== "event") break;
      const step = stepExecutionSequence(sequence, next.value.event);
      sequence = step.state;
      const event = step.event;
      if (step.violations.length > 0 || event === undefined) {
        await resolver.cancel(attemptId);
        const message = step.violations.map((v) => v.message).join("; ");
        yield { type: "terminal", terminal: protocolError(message) };
        return;
      }
      lastSequence = event.sequence;
      if (event.type === "terminal") {
        yield { type: "terminal", terminal: event.terminal };
        return;
      }
      if (event.type === "content") yield { type: "content", payload: event.payload };
    }
  } catch (err) {
    // A broken stream is resolved below, never re-run.
    broken = err;
  } finally {
    await frames.return?.();
  }
  const terminal = await brokenTerminal(resolver, attemptId, broken, lastSequence);
  yield { type: "terminal", terminal };
}

async function openStream(
  client: InferenceRpcClient,
  resolver: Resolver,
  attemptId: string,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const frames = client.stream({ attemptId }, signal)[Symbol.asyncIterator]();
  let first: IteratorResult<StreamFrame>;
  try {
    first = await frames.next();
  } catch (err) {
    return { kind: "settled", terminal: await brokenTerminal(resolver, attemptId, err, undefined) };
  }
  if (first.done === true) {
    return { kind: "settled", terminal: await resolver.lost(attemptId, undefined) };
  }
  const frame = first.value;
  if (frame.frame === "event") {
    return { kind: "stream", items: attemptItems(resolver, attemptId, frames, frame.event) };
  }
  await frames.return?.();
  return frame.frame === "rejected"
    ? { kind: "rejected", rejection: frame.rejection }
    : { kind: "settled", terminal: settledFrom(frame.status) };
}
// ---- submit with the single stale-generation refresh ----------------------

interface SubmitPlan {
  client: InferenceRpcClient;
  deploymentId: string;
  expectedEpoch: string | undefined;
  /** The declared owner; the worker that answers must be it. */
  ownerNodeId: string | undefined;
  /** The candidate's models, for resolving it on the owner when its epoch is unknown. */
  models: readonly string[];
  version: inferenceRpc.InferenceRpcVersion;
  /** The caller's envelope; the hop is added once the target is known. */
  envelope: Envelope;
  nodeId: string;
  cancelId: string;
}

type Listing = Extract<inferenceRpc.InferenceRpcCatalogResultV1, { outcome: "catalog" }>;
type ListedDeployment = Listing["deployments"][number];

function unavailable(message: string): { rejection: Rejection } {
  return { rejection: { code: "target-unavailable", message } };
}

/**
 * The owner's own entry for the candidate. A candidate whose epoch the
 * caller knows names the deployment exactly. One the caller learned from
 * a peer snapshot (`deploy/<peer>/<peer>:<model>`, epoch unknown) does not
 * share the worker's naming (`deploy/<worker>/<workload>`), so it is
 * resolved on the owner's catalog by model: the worker must be the
 * declared owner, and exactly one of its deployments must serve the model.
 * None, or more than one, is target-unavailable, never a guess.
 */
function listedTarget(
  plan: SubmitPlan,
  listing: Listing,
): { entry: ListedDeployment | undefined } | { rejection: Rejection } {
  const exact = listing.deployments.find((d) => d.deploymentId === plan.deploymentId);
  if (exact !== undefined || plan.expectedEpoch !== undefined) return { entry: exact };
  // A model is no deployment id: it names no owner, so scope it to the declared one.
  if (plan.ownerNodeId !== undefined && listing.workerId !== plan.ownerNodeId) {
    return unavailable(`the worker answered as '${listing.workerId}', not the declared owner`);
  }
  const serving = listing.deployments.filter((d) =>
    plan.models.some((model) => d.model === model || d.publicModelIds.includes(model)),
  );
  const models = plan.models.join("', '");
  if (serving.length === 0) return unavailable(`the owner lists no deployment serving '${models}'`);
  if (serving.length > 1) {
    return unavailable(`${String(serving.length)} of the owner's deployments serve '${models}'`);
  }
  return { entry: serving[0] };
}

async function targetFor(
  plan: SubmitPlan,
): Promise<{ target: inferenceRpc.InferenceRpcTargetV1 } | { rejection: Rejection }> {
  const listing = await plan.client.catalog();
  if (listing.outcome === "rejected") return { rejection: listing.rejection };
  const listed = listedTarget(plan, listing);
  if ("rejection" in listed) return listed;
  const deploymentId = listed.entry?.deploymentId ?? plan.deploymentId;
  const epoch = plan.expectedEpoch ?? listed.entry?.deploymentEpoch ?? null;
  if (epoch === null) {
    return unavailable(`the worker lists no fenceable deployment '${deploymentId}'`);
  }
  return {
    target: {
      deploymentId,
      expectedDeploymentEpoch: epoch,
      catalogGeneration: listing.catalogGeneration,
      workerIncarnation: listing.workerIncarnation,
    },
  };
}

type SubmitAnswer = inferenceRpc.InferenceRpcSubmitResultV1 | { outcome: "lost" };
type Refused = { outcome: "rejected"; rejection: Rejection };

/** One submit against a freshly read catalog; never retried once it may have been accepted. */
async function submitAgainstCatalog(plan: SubmitPlan): Promise<SubmitAnswer | Refused> {
  let resolved: Awaited<ReturnType<typeof targetFor>>;
  try {
    resolved = await targetFor(plan);
  } catch (err) {
    // Nothing was submitted yet: fail closed.
    return { outcome: "rejected", rejection: refusal(err, "worker RPC catalog failed") };
  }
  if ("rejection" in resolved) return { outcome: "rejected", rejection: resolved.rejection };
  try {
    return await plan.client.submit({
      version: plan.version,
      envelope: withHop(plan.envelope, plan.nodeId, resolved.target.deploymentId),
      target: resolved.target,
      cancelId: plan.cancelId,
    });
  } catch (err) {
    // A refused credential never reached the procedure, so nothing was
    // accepted; any other loss may have been, and is resolved by status.
    if (err instanceof InferenceRpcCredentialRefusedError) {
      return { outcome: "rejected", rejection: refusal(err, "submit") };
    }
    return { outcome: "lost" };
  }
}

async function submitOnce(plan: SubmitPlan): Promise<SubmitAnswer | Refused> {
  for (let refreshed = false; ; refreshed = true) {
    const answer = await submitAgainstCatalog(plan);
    const stale = answer.outcome === "rejected" && answer.rejection.code === "stale-generation";
    if (!stale || refreshed) return answer;
  }
}

async function resolveAccepted(
  client: InferenceRpcClient,
  resolver: Resolver,
  attemptId: string,
  answer: SubmitAnswer,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  if (answer.outcome === "rejected") return { kind: "rejected", rejection: answer.rejection };
  if (answer.outcome === "accepted") return await openStream(client, resolver, attemptId, signal);
  // A duplicate or a lost acknowledgement: only an attempt that is still
  // waiting for its stream may be attached; anything else is surfaced.
  const status = answer.outcome === "existing" ? answer.status : await resolver.status(attemptId);
  if (status?.state === "accepted") return await openStream(client, resolver, attemptId, signal);
  return { kind: "settled", terminal: status === null ? UNKNOWN_OUTCOME : settledFrom(status) };
}
// ---- OpenAI-compatible responses -----------------------------------------

type ResponseHeaders = Record<string, string>;

const REJECTION_STATUS: Record<inferenceRpc.InferenceRpcRejectionCode, number> = {
  "unauthorized-scope": 403,
  "not-owner": 409,
  "stale-generation": 409,
  "deadline-exceeded": 504,
  "hop-limit": 508,
  "target-unavailable": 503,
  "unsupported-feature": 400,
  "unsupported-version": 503,
  overloaded: 429,
};

interface Failure {
  status: number;
  code: string;
  message: string;
}

function failureOf(terminal: ExecutionTerminal): Failure {
  switch (terminal.outcome) {
    case "completed": {
      return {
        status: 409,
        code: "already-terminal",
        message: "the attempt completed on another stream; its output is not replayed",
      };
    }
    case "failed": {
      const status = terminal.error.code === "timeout" ? 504 : 502;
      return { status, code: terminal.error.code, message: terminal.error.message };
    }
    case "cancelled": {
      return { status: 503, code: "cancelled", message: "the attempt was cancelled" };
    }
    case "unknown-outcome": {
      const message = terminal.message ?? "the attempt outcome is unknown";
      return { status: 502, code: "unknown-outcome", message };
    }
  }
}

function errorResponse(envelope: Envelope, failure: Failure, headers: ResponseHeaders): Response {
  const init = { status: failure.status, headers };
  if (envelope.ingressProtocol === "anthropic-messages") {
    return Response.json(
      { type: "error", error: { type: "api_error", message: failure.message } },
      init,
    );
  }
  return Response.json(
    { error: { type: "server_error", code: failure.code, message: failure.message } },
    init,
  );
}

interface ChunkMeta {
  id: string;
  model: string;
  created: number;
}

function chunkFor(payload: ExecutionContentPayload, meta: ChunkMeta): unknown {
  if (payload.type === "chunk") {
    meta.id = payload.chunk.id;
    meta.model = payload.chunk.model;
    meta.created = payload.chunk.created;
    return payload.chunk;
  }
  return {
    ...meta,
    object: "chat.completion.chunk",
    choices: [
      {
        index: payload.choiceIndex,
        delta: { tool_calls: [{ index: 0, ...payload.toolCall }] },
        finish_reason: null,
      },
    ],
  };
}

function terminalFrame(terminal: ExecutionTerminal): string {
  if (terminal.outcome === "completed") return "data: [DONE]\n\n";
  const { code, message } = failureOf(terminal);
  return `data: ${JSON.stringify({ error: { type: "server_error", code, message } })}\n\n`;
}

/** Pull-driven: one attempt item per read, so nothing queues behind a slow client. */
function sseResponse(
  items: AsyncGenerator<AttemptItem>,
  meta: ChunkMeta,
  headers: ResponseHeaders,
  abort: () => void,
  release: () => void,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const next = await items.next();
      if (next.done === true) {
        release();
        controller.close();
        return;
      }
      const item = next.value;
      if (item.type === "content") {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunkFor(item.payload, meta))}\n\n`),
        );
        return;
      }
      controller.enqueue(encoder.encode(terminalFrame(item.terminal)));
      release();
      controller.close();
    },
    cancel(): void {
      abort();
      void items.return(undefined);
      release();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

interface ChoiceAcc {
  content: string;
  toolCalls: Map<number, ToolCallAcc>;
  finish: string | null;
}

function choiceAcc(choices: Map<number, ChoiceAcc>, index: number): ChoiceAcc {
  const existing = choices.get(index);
  if (existing !== undefined) return existing;
  const created: ChoiceAcc = { content: "", toolCalls: new Map(), finish: null };
  choices.set(index, created);
  return created;
}

type ToolCallPart = {
  index?: number;
  id?: string | undefined;
  function?: { name?: string | undefined; arguments?: string | undefined } | undefined;
};

function addToolCall(acc: ChoiceAcc, part: ToolCallPart): void {
  const index = part.index ?? acc.toolCalls.size;
  const call = acc.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
  call.id = part.id ?? call.id;
  call.name += part.function?.name ?? "";
  call.arguments += part.function?.arguments ?? "";
  acc.toolCalls.set(index, call);
}

function accumulate(
  choices: Map<number, ChoiceAcc>,
  payload: ExecutionContentPayload,
  meta: ChunkMeta,
): void {
  if (payload.type === "tool_call") {
    addToolCall(choiceAcc(choices, payload.choiceIndex), payload.toolCall);
    return;
  }
  chunkFor(payload, meta);
  for (const choice of payload.chunk.choices) {
    const acc = choiceAcc(choices, choice.index);
    acc.content += choice.delta.content ?? "";
    for (const part of choice.delta.tool_calls ?? []) addToolCall(acc, part);
    acc.finish = choice.finish_reason ?? acc.finish;
  }
}

function completionBody(
  meta: ChunkMeta,
  choices: Map<number, ChoiceAcc>,
  terminal: Extract<ExecutionTerminal, { outcome: "completed" }>,
): unknown {
  const { usage } = terminal;
  const counted = usage.input_tokens !== undefined && usage.output_tokens !== undefined;
  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [...choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, acc]) => ({
        index,
        message: {
          role: "assistant",
          content: acc.content,
          ...(acc.toolCalls.size > 0
            ? {
                tool_calls: [...acc.toolCalls.values()].map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: acc.finish ?? terminal.finishReason,
      })),
    ...(counted
      ? {
          usage: {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens:
              usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          },
        }
      : {}),
  };
}

async function jsonResponse(
  envelope: Envelope,
  items: AsyncGenerator<AttemptItem>,
  meta: ChunkMeta,
  headers: ResponseHeaders,
): Promise<Response> {
  const choices = new Map<number, ChoiceAcc>();
  let terminal: ExecutionTerminal = UNKNOWN_OUTCOME;
  for await (const item of items) {
    if (item.type === "terminal") {
      terminal = item.terminal;
      break;
    }
    accumulate(choices, item.payload, meta);
  }
  if (terminal.outcome !== "completed") {
    return errorResponse(envelope, failureOf(terminal), headers);
  }
  return Response.json(completionBody(meta, choices, terminal), { headers });
}

async function outcomeResponse(
  envelope: Envelope,
  transport: InferenceRpcTransport,
  outcome: Exclude<AttemptOutcome, { kind: "fallback" }>,
  abort: () => void,
  release: () => void,
): Promise<Response> {
  const headers = {
    "x-llamactl-attempt-id": envelope.attemptId,
    "x-llamactl-worker-transport": transport,
  };
  if (outcome.kind === "rejected") {
    release();
    const { code, message } = outcome.rejection;
    return errorResponse(envelope, { status: REJECTION_STATUS[code], code, message }, headers);
  }
  if (outcome.kind === "settled") {
    release();
    return errorResponse(envelope, failureOf(outcome.terminal), headers);
  }
  const meta: ChunkMeta = {
    id: `chatcmpl-${envelope.attemptId}`,
    model: envelope.publicModelId,
    created: Math.floor(Date.now() / 1000),
  };
  if (envelope.stream) return sseResponse(outcome.items, meta, headers, abort, release);
  try {
    return await jsonResponse(envelope, outcome.items, meta, headers);
  } finally {
    release();
  }
}

// ---- the worker-rpc BackendExecutor ---------------------------------------

export interface WorkerRpcExecutorOptions {
  client: InferenceRpcClient;
  deploymentId: string;
  /** The epoch the caller's catalog selected, when it knows one. */
  expectedEpoch?: string;
  /** The candidate's declared owner; a worker answering as anyone else is refused. */
  ownerNodeId?: string;
  /**
   * The candidate's upstream and public model ids. Without a known epoch
   * the candidate is resolved on the owner's catalog by these.
   */
  models?: readonly string[];
  /** The existing path, kept for workers that positively report no RPC. */
  fallback: BackendExecutor;
  /** The calling node, appended to the visited-node chain. */
  nodeId: string;
  version?: inferenceRpc.InferenceRpcVersion;
  /** How long `status` and `cancel` are retried to resolve a lost attempt. Default 15 s. */
  resolveTimeoutMs?: number;
}

/** The worker enforces the deadline; this past it, a silent transport is abandoned. */
const DEADLINE_GRACE_MS = 5_000;

function withHop(envelope: Envelope, nodeId: string, deploymentId: string): Envelope {
  const internal = envelope.internal ?? {};
  return {
    ...envelope,
    internal: {
      ...internal,
      deploymentId,
      hopCount: (internal.hopCount ?? 0) + 1,
      visitedNodes: [...(internal.visitedNodes ?? []), nodeId],
    },
  };
}

async function runAttempt(
  opts: WorkerRpcExecutorOptions,
  envelope: Envelope,
  ctx: BackendExecutionContext,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const version = opts.version ?? inferenceRpc.INFERENCE_RPC_VERSION;
  let negotiated: inferenceRpc.InferenceRpcNegotiateResultV1;
  try {
    negotiated = await opts.client.negotiate({
      versions: inferenceRpc.inferenceRpcVersionsSpokenAt(version),
      requiredFeatures: ["execution-event-v1"],
    });
  } catch (err) {
    // A worker that predates the route positively reports no RPC.
    if (err instanceof InferenceRpcRouteMissingError) return { kind: "fallback" };
    return { kind: "rejected", rejection: refusal(err, "worker RPC negotiation failed") };
  }
  if (negotiated.outcome === "not-advertised") return { kind: "fallback" };
  if (negotiated.outcome === "rejected") {
    return { kind: "rejected", rejection: negotiated.rejection };
  }
  const answer = await submitOnce({
    client: opts.client,
    deploymentId: opts.deploymentId,
    expectedEpoch: opts.expectedEpoch,
    ownerNodeId: opts.ownerNodeId,
    models: opts.models ?? [],
    version: negotiated.version,
    envelope,
    nodeId: opts.nodeId,
    cancelId: `cancel-${ctx.attemptId}`,
  });
  const resolver = resolverFor(opts.client, opts.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS);
  return await resolveAccepted(opts.client, resolver, envelope.attemptId, answer, signal);
}

export function createWorkerRpcExecutor(opts: WorkerRpcExecutorOptions): BackendExecutor {
  const inFlight = new Map<string, AbortController>();
  // The worker hears the cancel before the local stream is torn down, so
  // its acknowledgement records a cancel rather than a disconnect.
  const cancelOnWorker = (attemptId: string, controller: AbortController): void => {
    void opts.client
      .cancel({ attemptId })
      .catch(() => undefined)
      .finally(() => {
        controller.abort();
      });
  };
  const cancelAll = (): void => {
    for (const [attemptId, controller] of inFlight) cancelOnWorker(attemptId, controller);
  };
  return {
    describe: () => ({
      id: `worker-rpc-executor:${opts.client.transport}`,
      backendKinds: ["local-model"],
      transports: ["worker-rpc"],
    }),
    execute: async (envelope, ctx): Promise<Response> => {
      const controller = new AbortController();
      const watchdog = setTimeout(
        () => {
          controller.abort();
        },
        Math.max(0, ctx.deadline - Date.now()) + DEADLINE_GRACE_MS,
      );
      watchdog.unref();
      const signal = AbortSignal.any([
        controller.signal,
        ctx.req.signal,
        ...(ctx.signal ? [ctx.signal] : []),
      ]);
      inFlight.set(envelope.attemptId, controller);
      const release = (): void => {
        clearTimeout(watchdog);
        inFlight.delete(envelope.attemptId);
      };
      try {
        const outcome = await runAttempt(opts, envelope, ctx, signal);
        if (outcome.kind === "fallback") {
          release();
          return await opts.fallback.execute(envelope, ctx);
        }
        // A consumer that leaves cancels on the worker, so even a client
        // disconnect gets an acknowledged outcome.
        return await outcomeResponse(
          envelope,
          opts.client.transport,
          outcome,
          () => {
            cancelOnWorker(envelope.attemptId, controller);
          },
          release,
        );
      } catch (err) {
        release();
        throw err;
      }
    },
    cancel: (attemptId: string): boolean => {
      const controller = inFlight.get(attemptId);
      if (controller === undefined) return false;
      cancelOnWorker(attemptId, controller);
      return true;
    },
    drain: (): Promise<void> => {
      cancelAll();
      return Promise.resolve();
    },
    close: (): Promise<void> => {
      cancelAll();
      inFlight.clear();
      return Promise.resolve();
    },
  };
}

// ---- transport by declared owner ------------------------------------------

/** Embedded claims for the local proxy: the selected deployment, its own tenant. */
function embeddedClaims(nodeId: string, deploymentId: string, scope: string): Claims {
  return {
    serviceId: `embedded:${nodeId}`,
    operations: [...inferenceRpc.InferenceRpcOperationSchema.options],
    deployments: [deploymentId],
    models: [],
    tenants: [scope],
    credentialScopeId: scope,
  };
}

/** Fails negotiation, so an attempt for an owner that cannot be reached fails closed. */
function unreachableClient(transport: InferenceRpcTransport, message: string): InferenceRpcClient {
  const fail = (): Promise<never> => Promise.reject(new Error(message));
  return {
    transport,
    negotiate: fail,
    catalog: fail,
    submit: fail,
    stream: async function* (): AsyncGenerator<StreamFrame> {
      yield* [];
      await fail();
    },
    status: fail,
    cancel: fail,
  };
}

/** Credentials are resolved only for a selected owner, never at catalog build. */
function configuredPeer(id: string): PeerNode | undefined {
  try {
    return listPeers().find((peer) => peer.id === id);
  } catch {
    return undefined;
  }
}

/**
 * The secret reference to the caller's service credential for `owner`,
 * from the owner's kubeconfig node. Undefined when the node declares no
 * worker-RPC block: the caller has not opted in for that owner.
 */
export function kubeconfigServiceCredentialRef(owner: string): string | undefined {
  try {
    const config = loadConfig();
    const context = currentContext(config);
    const cluster = config.clusters.find((candidate) => candidate.name === context.cluster);
    return cluster?.nodes.find((node) => node.name === owner)?.workerRpc?.serviceCredentialRef;
  } catch {
    return undefined;
  }
}

function directClientFor(peer: PeerNode, serviceCredential: string): InferenceRpcClient {
  return createDirectInferenceRpcClient({
    node: {
      name: peer.id,
      endpoint: peer.endpoint,
      ...(peer.certificate !== undefined ? { certificate: peer.certificate } : {}),
      ...(peer.fingerprint !== undefined ? { certificateFingerprint: peer.fingerprint } : {}),
    },
    serviceCredential,
  });
}

function tunnelClientFor(peer: PeerNode, serviceCredential: string): InferenceRpcClient {
  if (peer.tunnelCentralUrl === undefined) {
    throw new Error(`owner '${peer.id}' prefers the tunnel, but no tunnelCentralUrl is set`);
  }
  const bearer = peer.tunnelRelayToken ?? configuredPeer(peer.id)?.tunnelRelayToken;
  if (bearer === undefined) throw new Error(`no tunnel relay credential for owner '${peer.id}'`);
  return createTunnelInferenceRpcClient({
    centralUrl: peer.tunnelCentralUrl,
    nodeName: peer.tunnelNodeName ?? peer.id,
    bearer,
    serviceCredential,
    ...(peer.tunnelCentralCertificate !== undefined
      ? { centralCertificate: peer.tunnelCentralCertificate }
      : {}),
    ...(peer.tunnelCentralFingerprint !== undefined
      ? { centralFingerprint: peer.tunnelCentralFingerprint }
      : {}),
  });
}

/**
 * The client for a remote owner, over the transport its kubeconfig node
 * declares: the reverse tunnel when it prefers one, else a direct dial
 * pinned to its certificate, presenting the caller's service credential.
 * An owner the caller has not opted in for (no worker-RPC block) keeps
 * the existing path: null. An owner that cannot be reached, or whose
 * credential does not resolve, fails closed; it is never rerouted.
 */
function ownerClient(
  owner: string,
  peers: readonly PeerNode[],
  credentialRef: (owner: string) => string | undefined,
): InferenceRpcClient | null {
  const peer = peers.find((candidate) => candidate.id === owner);
  if (peer === undefined) {
    return unreachableClient("direct", `no kubeconfig agent node declares owner '${owner}'`);
  }
  const ref = credentialRef(owner);
  if (ref === undefined) return null;
  const transport = peer.tunnelPreferred === true ? "tunnel" : "direct";
  try {
    const credential = resolveSecret(ref);
    return transport === "tunnel"
      ? tunnelClientFor(peer, credential)
      : directClientFor(peer, credential);
  } catch (err) {
    return unreachableClient(transport, errorMessage(err));
  }
}

export interface WorkerRpcAcquireOptions {
  nodeId: string;
  scope: string;
  fallback: BackendExecutor;
  /** The kubeconfig agent nodes; the owner's entry picks its transport. */
  peers?: () => readonly PeerNode[];
  /** The caller's service-credential reference for an owner. Defaults to its kubeconfig node's. */
  serviceCredentialRef?: (owner: string) => string | undefined;
}

/**
 * The executor for a `worker-rpc` candidate, over the transport its
 * declared owner selects; null keeps the candidate on the default
 * executor (not a worker-rpc candidate, or an owner not opted in).
 */
export function acquireWorkerRpcExecutor(
  candidate: routingCatalog.RouteCandidate,
  opts: WorkerRpcAcquireOptions,
): BackendExecutor | null {
  const ad = candidate.advertisement;
  if (ad.transport !== "worker-rpc") return null;
  const client =
    ad.ownerNodeId === opts.nodeId
      ? createEmbeddedInferenceRpcClient(embeddedClaims(opts.nodeId, ad.deploymentId, opts.scope))
      : ownerClient(
          ad.ownerNodeId,
          opts.peers?.() ?? [],
          opts.serviceCredentialRef ?? kubeconfigServiceCredentialRef,
        );
  if (client === null) return null;
  return createWorkerRpcExecutor({
    client,
    deploymentId: ad.deploymentId,
    ...(ad.deploymentEpoch.status === "known" ? { expectedEpoch: ad.deploymentEpoch.value } : {}),
    ownerNodeId: ad.ownerNodeId,
    models: [...new Set([ad.upstreamModelId, ...ad.publicModelIds])],
    fallback: opts.fallback,
    nodeId: opts.nodeId,
  });
}
