import type {
  LocalEngineDispatch,
  LocalEngineForwarder,
  LocalEngineRequest,
} from "@llamactl/core/residency/engine-forwarder";

import {
  type ExecutionAdmissionConfig,
  ExecutionAdmissionSchema,
} from "@llamactl/core/config/agent-config";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  modelKeyOf,
  type QueueModelRef,
  type QueueSnapshot,
  type RequestPriority,
} from "@llamactl/core/residency/queue-policy";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { bearerFromHeader } from "../server/auth.js";
import { admissionErrorResponse } from "../server/chat-admission.js";
import { boundOwnerRequest, type OwnerRequestBounds } from "./owner-request-bounds.js";
import {
  type AdmissionRequest,
  createRequestAdmission,
  type Release,
  RequestAdmissionError,
  type ReservableRequestAdmission,
} from "./request-admission.js";

interface ExecutionGroup {
  model: QueueModelRef;
  admission: ReservableRequestAdmission;
  bounds: OwnerRequestBounds;
  unconfirmed: AbortController;
  stopping: AbortController;
}

export type OwnerAdmissionSnapshot = Pick<QueueSnapshot, "queued" | "executing" | "queuedBytes"> & {
  group: string;
  fenced: boolean;
};

export interface OwnerPermit {
  send: (send: LocalEngineDispatch["send"], actualBody?: string | null) => Promise<Response>;
  releaseUnused: () => void;
}

export type OwnerReservation =
  | { pending: Promise<OwnerPermit> }
  | { refusal: RequestAdmissionError };

export type OwnerPreflight =
  | { request: Omit<AdmissionRequest, "model" | "requestId">; body: string | undefined }
  | { refusal: RequestAdmissionError };

export interface OwnerAdmission {
  preflightCold: (request: LocalEngineRequest, model: string) => OwnerPreflight | undefined;
  acquire: (request: LocalEngineRequest) => OwnerReservation | undefined;
  forward: LocalEngineForwarder;
  stop: () => void;
  snapshot: () => OwnerAdmissionSnapshot[];
}

function loopbackPort(target: string): number | undefined {
  const { hostname, port, protocol } = new URL(target);
  if (protocol !== "http:") return undefined;
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  return loopback ? Number(port || "80") : undefined;
}

function principalOf(principal: LocalEngineDispatch["principal"], noAuth: boolean): string {
  if ("scope" in principal) return JSON.stringify(["rpc", principal.service, principal.scope]);
  const bearer = noAuth ? null : bearerFromHeader(principal.bearer);
  return bearer === null ? "local" : "http:" + createHash("sha256").update(bearer).digest("hex");
}

function fencedResponse(): Response {
  return Response.json(
    {
      error: {
        type: "model_unavailable",
        code: "execution_group_fenced",
        message:
          "Engine completion could not be confirmed. Verify group engines are idle before restarting admission.",
      },
    },
    { status: 503 },
  );
}

function fence(group: ExecutionGroup): void {
  group.unconfirmed.abort();
}

/** A disconnected client must not make a still-running engine slot available. */
function bindEngineBody(
  response: Response,
  dispatch: LocalEngineDispatch,
  hard: AbortSignal,
  finish: (confirmed: boolean) => void,
): Response {
  if (response.body === null) {
    finish(!hard.aborted);
    return response;
  }
  const reader = response.body.getReader();
  const client = dispatch.clientSignal;
  let detached = false;
  let settled = false;
  let reading = Promise.resolve();
  let output: ReadableStreamDefaultController<Uint8Array>;

  const settle = (confirmed: boolean): void => {
    if (settled) return;
    settled = true;
    client.removeEventListener("abort", clientAbort);
    hard.removeEventListener("abort", engineAbort);
    finish(confirmed);
  };
  const read = async (): Promise<void> => {
    try {
      const chunk = await reader.read();
      if (settled) return;
      if (chunk.done) {
        settle(!hard.aborted);
        if (!detached) output.close();
      } else if (!detached) {
        output.enqueue(chunk.value);
      }
    } catch (error) {
      if (settled) return;
      settle(false);
      if (!detached) output.error(error);
    }
  };
  const detach = (): void => {
    if (detached || settled) return;
    detached = true;
    void reading.then(async () => {
      while (!settled) await read();
    });
  };
  const clientAbort = (): void => {
    if (detached || settled) return;
    output.error(client.reason);
    detach();
  };
  const engineAbort = (): void => {
    if (!detached) output.error(hard.reason);
    settle(false);
    void reader.cancel().catch(() => undefined);
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      output = controller;
    },
    pull(): Promise<void> {
      reading = read();
      return reading;
    },
    cancel: detach,
  });

  hard.addEventListener("abort", engineAbort, { once: true });
  client.addEventListener("abort", clientAbort, { once: true });
  if (client.aborted) clientAbort();
  if (hard.aborted) engineAbort();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function hardSignal(group: ExecutionGroup, dispatch: LocalEngineRequest): AbortSignal {
  const left = Math.min(2_147_483_647, Math.max(0, dispatch.deadlineMs - Date.now()));
  return AbortSignal.any([
    AbortSignal.timeout(left),
    group.stopping.signal,
    ...(dispatch.engineSignal === undefined ? [] : [dispatch.engineSignal]),
  ]);
}

function beforeDialRefusal(
  dispatch: LocalEngineDispatch,
  hard: AbortSignal,
  group: ExecutionGroup,
): Response | undefined {
  if (dispatch.clientSignal.aborted) return new Response(null, { status: 499 });
  if (Date.now() >= dispatch.deadlineMs) {
    return admissionErrorResponse(
      new RequestAdmissionError("DeadlineExceeded", null, "engine-dispatch"),
    );
  }
  if (hard.aborted || group.unconfirmed.signal.aborted) return fencedResponse();
  if (dispatch.stillOwnsTarget?.() === false) {
    return Response.json(
      { error: { type: "model_unavailable", code: "execution_target_changed" } },
      { status: 503 },
    );
  }
  return undefined;
}

async function forwardGranted(
  group: ExecutionGroup,
  dispatch: LocalEngineDispatch,
  hard: AbortSignal,
  release: Release,
): Promise<Response> {
  const client = dispatch.clientSignal;
  let refusal: Response | undefined;
  try {
    refusal = beforeDialRefusal(dispatch, hard, group);
  } catch (error) {
    release();
    throw error;
  }
  if (refusal !== undefined) {
    release();
    return refusal;
  }
  const acquired =
    dispatch.workload === undefined
      ? undefined
      : getResidencyLeaseRegistry()?.acquire(dispatch.workload);
  if (acquired?.ok === false) {
    release();
    return Response.json(
      { error: { type: acquired.reason === "Draining" ? "model_draining" : "model_not_loaded" } },
      { status: 503 },
    );
  }
  const lease = acquired?.lease;
  const engineSignal = lease === undefined ? hard : AbortSignal.any([hard, lease.signal]);
  const complete = (confirmed: boolean): void => {
    if (!confirmed) fence(group);
    lease?.release();
    release();
  };

  // Once the dial starts, the HTTP connection stays alive until terminal
  // output or its engine deadline. The caller can leave immediately.
  const { promise: cancelled, resolve } = Promise.withResolvers<Response>();
  const clientAbort = (): void => {
    resolve(new Response(null, { status: 499 }));
  };
  client.addEventListener("abort", clientAbort, { once: true });

  const work = (async (): Promise<Response> => {
    try {
      const response = await dispatch.send(engineSignal);
      return bindEngineBody(response, dispatch, engineSignal, complete);
    } catch {
      complete(false);
      return fencedResponse();
    } finally {
      client.removeEventListener("abort", clientAbort);
    }
  })();
  return await Promise.race([work, cancelled]);
}

class EngineGroupFencedError extends RequestAdmissionError {
  constructor() {
    super("LoadFailed", null, "engine dispatch unconfirmed");
  }
}

function permitFor(
  group: ExecutionGroup,
  request: LocalEngineRequest,
  release: Release,
  checkedBody: string | undefined,
): OwnerPermit {
  let unused = true;
  return {
    send: async (send, actualBody): Promise<Response> => {
      if (!unused) return new Response(null, { status: 409 });
      unused = false;
      const body =
        actualBody === undefined
          ? checkedBody
          : boundOwnerRequest({ ...request, body: actualBody }, group.bounds);
      if (typeof body === "object" && "code" in body) {
        release();
        return admissionErrorResponse(
          new RequestAdmissionError(body.code, null, "engine-dispatch"),
        );
      }
      const bounded = typeof body === "object" ? body.body : body;
      return await forwardGranted(
        group,
        { ...request, send: (signal) => send(signal, bounded) },
        hardSignal(group, request),
        release,
      );
    },
    releaseUnused: (): void => {
      if (!unused) return;
      unused = false;
      release();
    },
  };
}

function preflightMatched(
  group: ExecutionGroup,
  priority: RequestPriority,
  request: LocalEngineRequest,
  noAuth: boolean,
  expectedModel?: string,
): OwnerPreflight {
  const id = "owner-preflight";
  if (group.unconfirmed.signal.aborted) return { refusal: new EngineGroupFencedError() };
  if (group.stopping.signal.aborted)
    return { refusal: new RequestAdmissionError("LoadFailed", null, id) };
  if (request.clientSignal.aborted)
    return { refusal: new RequestAdmissionError("Aborted", null, id) };
  if (request.deadlineMs <= Date.now())
    return { refusal: new RequestAdmissionError("DeadlineExceeded", null, id) };
  const bounded = boundOwnerRequest(request, group.bounds, expectedModel);
  if ("code" in bounded) return { refusal: new RequestAdmissionError(bounded.code, null, id) };
  return {
    body: bounded.body,
    request: {
      principal: principalOf(request.principal, noAuth),
      priority,
      bytes: bounded.bytes,
      promptTokens: bounded.promptTokens,
      maxCompletionTokens: bounded.completionTokens,
    },
  };
}

function acquireMatched(
  group: ExecutionGroup,
  priority: RequestPriority,
  request: LocalEngineRequest,
  noAuth: boolean,
): OwnerReservation {
  const preflight = preflightMatched(group, priority, request, noAuth);
  if ("refusal" in preflight) return preflight;
  const signal = AbortSignal.any([
    request.clientSignal,
    group.stopping.signal,
    group.unconfirmed.signal,
    ...(request.engineSignal === undefined ? [] : [request.engineSignal]),
  ]);
  const reservation = group.admission.reserve(
    { ...preflight.request, requestId: randomUUID(), model: group.model },
    { signal, deadlineMs: request.deadlineMs },
  );
  if ("refusal" in reservation) return reservation;
  return {
    pending: reservation.pending.then(
      (release) => permitFor(group, request, release, preflight.body),
      (error: unknown) => {
        if (group.unconfirmed.signal.aborted) throw new EngineGroupFencedError();
        throw error;
      },
    ),
  };
}

async function forwardWithPermit(
  pending: Promise<OwnerPermit>,
  dispatch: LocalEngineDispatch,
): Promise<Response> {
  try {
    const permit = await pending;
    return await permit.send(dispatch.send);
  } catch (error) {
    return error instanceof EngineGroupFencedError
      ? fencedResponse()
      : admissionErrorResponse(error);
  }
}

export function createOwnerAdmission(
  config: ExecutionAdmissionConfig,
  options: { noAuth?: boolean } = {},
): OwnerAdmission {
  const targets = new Map<number, { group: ExecutionGroup; priority: RequestPriority }>();
  const groups = ExecutionAdmissionSchema.parse(config).map((spec): ExecutionGroup => {
    const model = { name: spec.name, revision: "owner-execution" };
    const group: ExecutionGroup = {
      model,
      bounds: spec,
      unconfirmed: new AbortController(),
      stopping: new AbortController(),
      admission: createRequestAdmission({
        exclusiveBackground: true,
        resident: [modelKeyOf(model)],
        load: () => Promise.reject(new Error("owner execution groups contain resident targets")),
        limits: {
          maxExecutions: spec.foregroundConcurrency,
          maxQueued: spec.maxQueued,
          maxQueuedBytes: spec.maxQueuedBytes,
          maxQueueWaitMs: spec.maxQueueWaitMs,
          maxPerPrincipal: spec.maxPerPrincipal,
          starvationBoundMs: spec.starvationBoundMs,
          maxContextTokens: spec.maxContextTokens ?? Number.MAX_SAFE_INTEGER,
          retryAfterMs: 1_000,
        },
      }),
    };
    for (const port of spec.foregroundPorts) targets.set(port, { group, priority: "interactive" });
    for (const port of spec.backgroundPorts) targets.set(port, { group, priority: "background" });
    return group;
  });

  const matchTarget = (
    target: string,
  ): { group: ExecutionGroup; priority: RequestPriority } | undefined => {
    const port = loopbackPort(target);
    return port === undefined ? undefined : targets.get(port);
  };
  const acquire = (request: LocalEngineRequest): OwnerReservation | undefined => {
    const match = matchTarget(request.target);
    return match === undefined
      ? undefined
      : acquireMatched(match.group, match.priority, request, options.noAuth === true);
  };
  return {
    acquire,
    preflightCold: (request, model): OwnerPreflight | undefined => {
      const match = matchTarget(request.target);
      if (match === undefined) return undefined;
      const { maxCompletionTokens, maxContextTokens } = match.group.bounds;
      if (maxCompletionTokens === undefined || maxContextTokens === undefined) {
        return { refusal: new RequestAdmissionError("ContextUnverified", null, "cold-owner") };
      }
      return preflightMatched(match.group, match.priority, request, options.noAuth === true, model);
    },
    forward: (dispatch): Promise<Response> | undefined => {
      const ticket = acquire(dispatch);
      if (ticket === undefined) return undefined;
      if ("refusal" in ticket) {
        const error = ticket.refusal;
        return Promise.resolve(
          error instanceof EngineGroupFencedError
            ? fencedResponse()
            : admissionErrorResponse(error),
        );
      }
      return forwardWithPermit(ticket.pending, dispatch);
    },
    stop: (): void => {
      for (const group of groups) group.stopping.abort();
    },
    snapshot: (): OwnerAdmissionSnapshot[] =>
      groups.map(({ admission, model, unconfirmed }) => {
        const { queued, queuedBytes, executing } = admission.snapshot();
        return {
          group: model.name,
          queued,
          queuedBytes,
          executing,
          fenced: unconfirmed.signal.aborted,
        };
      }),
  };
}
