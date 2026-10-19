/**
 * InferenceRpcV1 caller side (P4.1): the embedded client and the
 * `worker-rpc` BackendExecutor the unified proxy acquires. The embedded
 * client drives the worker procedures in-process through the same tRPC
 * input parsing the wire uses, so its semantics match the remote clients.
 *
 * The executor negotiates, fences on the worker's catalog, submits, then
 * consumes the stream, checking every event with Nova's sequence rules.
 * It never re-submits once a submit may have been accepted: a lost
 * acknowledgement or a broken stream is resolved through `status`, and an
 * outcome it cannot establish is surfaced as `unknown-outcome`. Only a
 * stale generation is retried, once, after a single catalog refresh.
 */
import { type inferenceContracts, inferenceRpc, type routingCatalog } from "@llamactl/core";
import {
  type ExecutionContentPayload,
  type ExecutionEventV1,
  type ExecutionTerminal,
  INITIAL_EXECUTION_SEQUENCE_STATE,
  stepExecutionSequence,
} from "@novaproto/contracts";

import type { BackendExecutionContext, BackendExecutor } from "../proxy/create-proxy.js";

import { inferenceRpcRouter } from "./procedures.js";

type Claims = inferenceRpc.InferenceServiceClaimsV1;
type Envelope = inferenceContracts.InferenceEnvelopeV1;
type Rejection = inferenceRpc.InferenceRpcRejectionV1;
type StreamFrame = inferenceRpc.InferenceRpcStreamFrameV1;
type AttemptStatus = inferenceRpc.InferenceRpcAttemptStatusV1;

export type InferenceRpcTransport = "embedded";

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

function unavailable(message: string): AttemptOutcome {
  return { kind: "rejected", rejection: { code: "target-unavailable", message } };
}

/** The only outcome a non-terminal status can resolve to: never a replay. */
function settledFrom(status: AttemptStatus): ExecutionTerminal {
  return status.terminal ?? UNKNOWN_OUTCOME;
}

async function statusOf(
  client: InferenceRpcClient,
  attemptId: string,
): Promise<AttemptStatus | null> {
  try {
    const result = await client.status({ attemptId });
    return result.outcome === "status" ? result : null;
  } catch {
    return null;
  }
}

/**
 * Validated attempt items: every received event is stepped through Nova's
 * sequence rules, and a stream that breaks or ends without its terminal
 * is resolved through `status` rather than re-run.
 */
async function* attemptItems(
  client: InferenceRpcClient,
  attemptId: string,
  frames: AsyncIterator<StreamFrame>,
  first: ExecutionEventV1,
): AsyncGenerator<AttemptItem> {
  let sequence = stepExecutionSequence(INITIAL_EXECUTION_SEQUENCE_STATE, first).state;
  try {
    for (let next = await frames.next(); next.done !== true; next = await frames.next()) {
      if (next.value.frame !== "event") break;
      const step = stepExecutionSequence(sequence, next.value.event);
      sequence = step.state;
      const event = step.event;
      if (step.violations.length > 0 || event === undefined) {
        await client.cancel({ attemptId }).catch(() => undefined);
        const message = step.violations.map((v) => v.message).join("; ");
        yield { type: "terminal", terminal: protocolError(message) };
        return;
      }
      if (event.type === "terminal") {
        yield { type: "terminal", terminal: event.terminal };
        return;
      }
      if (event.type === "content") yield { type: "content", payload: event.payload };
    }
  } catch {
    // A broken stream is resolved below, never re-run.
  } finally {
    await frames.return?.();
  }
  const status = await statusOf(client, attemptId);
  yield { type: "terminal", terminal: status === null ? UNKNOWN_OUTCOME : settledFrom(status) };
}

function protocolError(message: string): ExecutionTerminal {
  return {
    outcome: "failed",
    started: true,
    error: { code: "protocol-error", message, retryable: false },
    usage: { source: "unknown" },
  };
}

async function openStream(
  client: InferenceRpcClient,
  attemptId: string,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const frames = client.stream({ attemptId }, signal)[Symbol.asyncIterator]();
  let first: IteratorResult<StreamFrame>;
  try {
    first = await frames.next();
  } catch {
    const status = await statusOf(client, attemptId);
    return { kind: "settled", terminal: status === null ? UNKNOWN_OUTCOME : settledFrom(status) };
  }
  if (first.done === true) return { kind: "settled", terminal: UNKNOWN_OUTCOME };
  const frame = first.value;
  switch (frame.frame) {
    case "rejected": {
      return { kind: "rejected", rejection: frame.rejection };
    }
    case "unavailable": {
      return { kind: "settled", terminal: settledFrom(frame.status) };
    }
    case "event": {
      return { kind: "stream", items: attemptItems(client, attemptId, frames, frame.event) };
    }
  }
}

// ---- submit with the single stale-generation refresh ----------------------

interface SubmitPlan {
  client: InferenceRpcClient;
  deploymentId: string;
  expectedEpoch: string | undefined;
  version: inferenceRpc.InferenceRpcVersion;
  envelope: Envelope;
  cancelId: string;
}

async function targetFor(
  plan: SubmitPlan,
): Promise<{ target: inferenceRpc.InferenceRpcTargetV1 } | { rejection: Rejection }> {
  const listing = await plan.client.catalog();
  if (listing.outcome === "rejected") return { rejection: listing.rejection };
  const entry = listing.deployments.find((d) => d.deploymentId === plan.deploymentId);
  const epoch = plan.expectedEpoch ?? entry?.deploymentEpoch ?? null;
  if (epoch === null) {
    return {
      rejection: {
        code: "target-unavailable",
        message: `the worker lists no fenceable deployment '${plan.deploymentId}'`,
      },
    };
  }
  return {
    target: {
      deploymentId: plan.deploymentId,
      expectedDeploymentEpoch: epoch,
      catalogGeneration: listing.catalogGeneration,
      workerIncarnation: listing.workerIncarnation,
    },
  };
}

type SubmitAnswer = inferenceRpc.InferenceRpcSubmitResultV1 | { outcome: "lost" };

async function submitOnce(
  plan: SubmitPlan,
): Promise<SubmitAnswer | { outcome: "rejected"; rejection: Rejection }> {
  for (let refreshed = false; ; refreshed = true) {
    const resolved = await targetFor(plan);
    if ("rejection" in resolved) return { outcome: "rejected", rejection: resolved.rejection };
    let answer: SubmitAnswer;
    try {
      answer = await plan.client.submit({
        version: plan.version,
        envelope: plan.envelope,
        target: resolved.target,
        cancelId: plan.cancelId,
      });
    } catch {
      return { outcome: "lost" };
    }
    const stale = answer.outcome === "rejected" && answer.rejection.code === "stale-generation";
    if (!stale || refreshed) return answer;
  }
}

async function resolveAccepted(
  client: InferenceRpcClient,
  attemptId: string,
  answer: SubmitAnswer,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  if (answer.outcome === "rejected") return { kind: "rejected", rejection: answer.rejection };
  if (answer.outcome === "accepted") return await openStream(client, attemptId, signal);
  // A duplicate or a lost acknowledgement: only an attempt that is still
  // waiting for its stream may be attached; anything else is surfaced.
  const status = answer.outcome === "existing" ? answer.status : await statusOf(client, attemptId);
  if (status?.state === "accepted") return await openStream(client, attemptId, signal);
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
  /** The existing path, kept for workers that positively report no RPC. */
  fallback: BackendExecutor;
  /** The calling node, appended to the visited-node chain. */
  nodeId: string;
  version?: inferenceRpc.InferenceRpcVersion;
}

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
  } catch {
    return unavailable("worker RPC negotiation failed");
  }
  if (negotiated.outcome === "not-advertised") return { kind: "fallback" };
  if (negotiated.outcome === "rejected") {
    return { kind: "rejected", rejection: negotiated.rejection };
  }
  const answer = await submitOnce({
    client: opts.client,
    deploymentId: opts.deploymentId,
    expectedEpoch: opts.expectedEpoch,
    version: negotiated.version,
    envelope: withHop(envelope, opts.nodeId, opts.deploymentId),
    cancelId: `cancel-${ctx.attemptId}`,
  });
  return await resolveAccepted(opts.client, envelope.attemptId, answer, signal);
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
      const signal = AbortSignal.any([
        controller.signal,
        ctx.req.signal,
        ...(ctx.signal ? [ctx.signal] : []),
      ]);
      inFlight.set(envelope.attemptId, controller);
      const release = (): void => {
        inFlight.delete(envelope.attemptId);
      };
      try {
        const outcome = await runAttempt(opts, envelope, ctx, signal);
        if (outcome.kind === "fallback") {
          release();
          return await opts.fallback.execute(envelope, ctx);
        }
        return await outcomeResponse(
          envelope,
          opts.client.transport,
          outcome,
          () => {
            controller.abort();
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

/**
 * The executor for a `worker-rpc` candidate, chosen by its declared owner.
 * Only the embedded transport exists so far, so a candidate owned by
 * another node gets null and stays on the existing path.
 */
export function acquireWorkerRpcExecutor(
  candidate: routingCatalog.RouteCandidate,
  opts: { nodeId: string; scope: string; fallback: BackendExecutor },
): BackendExecutor | null {
  const ad = candidate.advertisement;
  if (ad.transport !== "worker-rpc" || ad.ownerNodeId !== opts.nodeId) return null;
  return createWorkerRpcExecutor({
    client: createEmbeddedInferenceRpcClient(
      embeddedClaims(opts.nodeId, ad.deploymentId, opts.scope),
    ),
    deploymentId: ad.deploymentId,
    ...(ad.deploymentEpoch.status === "known" ? { expectedEpoch: ad.deploymentEpoch.value } : {}),
    fallback: opts.fallback,
    nodeId: opts.nodeId,
  });
}
