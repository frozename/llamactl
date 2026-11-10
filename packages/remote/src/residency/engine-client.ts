/**
 * oMLX native residency client — status, load and unload over HTTP.
 *
 * The BackendBusy/ActivityUnknown guard is advisory and racy: it is a
 * check-then-act against oMLX's immediate-abort unload, so a request that
 * arrives between the activity GET and the unload POST is still aborted.
 * llamactl-side ResidencyLeases fencing lands in the next #282 slice.
 *
 * DFlash caveat: DFlash-hosted model activity is invisible to /api/status at
 * feec0a0e (server.py:3171-3188 walks engine._engine.engine._output_collectors
 * and DFlashEngine has no _engine attribute). Callers therefore pass
 * `hostedModel.dflash?.enabled !== true` for activityObservable, so a false
 * value makes unload fail closed.
 */
import type {
  ModelHostReadiness,
  NativeModelActivity,
  NativeModelStatusObservation,
} from "@llamactl/core/engines";

import {
  checkServingReadiness,
  deriveOmlxResidency,
  formatHostForUrl,
  OMLX_ACTIVITY_PATH,
  OMLX_MODELS_STATUS_PATH,
  omlxModelActionPath,
  parseOmlxActivity,
  parseOmlxModelsStatus,
} from "@llamactl/core/engines";

const OBSERVABLE_ENGINES = new Set(["batched"]);

function engineIsObservable(engineType: string | undefined): boolean {
  return engineType !== undefined && OBSERVABLE_ENGINES.has(engineType);
}

// --- public types ---

export type NativeStatus =
  | { state: "discovered" | "loading"; modelId: string }
  | {
      state: "resident" | "ready" | "busy";
      modelId: string;
      actualSize: number | null;
      residentEstimatedSize: number | null;
      activity: NativeModelActivity | "unknown";
    }
  | { state: "failed"; reason: "ModelNotListed" | "MalformedStatus" }
  | {
      state: "failed";
      reason: "Unauthorized" | "NativeStatusUnsupported" | "StatusHttpError";
      httpStatus: number;
    }
  | { state: "unknown"; reason: "StatusUnreachable" };

export type NativeLoadResult =
  | { kind: "loaded" | "already-loaded"; modelId: string }
  | { kind: "refused"; reason: "StatusUnavailable" | "LoadInProgress" | "OperationInProgress" }
  | {
      kind: "failed";
      reason: "ModelNotListed" | "InsufficientMemory" | "Conflict" | "Unauthorized";
      httpStatus: number;
    }
  | { kind: "ambiguous"; reason: "HttpError"; reservation: "uncertain"; httpStatus: number }
  | {
      kind: "ambiguous";
      reason: "Timeout" | "Unreachable" | "MalformedResponse";
      reservation: "uncertain";
    };

export type NativeUnloadResult =
  | { kind: "unloaded" | "already-unloaded"; modelId: string; reservation: "released" }
  | {
      kind: "refused";
      reason:
        | "StatusUnavailable"
        | "LoadInProgress"
        | "OperationInProgress"
        | "BackendBusy"
        | "ActivityUnknown";
      reservation: "held";
    }
  | {
      kind: "failed";
      reason: "ModelNotListed" | "Unauthorized";
      reservation: "held";
      httpStatus: number;
    }
  | {
      kind: "ambiguous";
      reason: "HttpError" | "UnloadUnconfirmed";
      reservation: "uncertain";
      httpStatus: number;
    }
  | {
      kind: "ambiguous";
      reason: "Timeout" | "Unreachable" | "MalformedResponse";
      reservation: "uncertain";
    };

export type OmlxNativeClientOptions = {
  endpoint: { host: string; port: number };
  hostedRel: string;
  /**
   * Callers pass `hostedModel.dflash?.enabled !== true`. DFlashEngine activity
   * is invisible to /api/status at feec0a0e (server.py:3171-3188 walks
   * engine._engine only), so false makes unload fail closed.
   */
  activityObservable: boolean;
  apiKey?: string;
  readiness?: ModelHostReadiness;
  requestTimeoutMs?: number;
  statusTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export type OmlxNativeClient = {
  status(): Promise<NativeStatus>;
  load(): Promise<NativeLoadResult>;
  unload(): Promise<NativeUnloadResult>;
};

// --- internal context ---

type ClientCtx = {
  baseUrl: string;
  endpoint: { host: string; port: number };
  hostedRel: string;
  activityObservable: boolean;
  apiKey: string | undefined;
  readiness: ModelHostReadiness | undefined;
  requestTimeoutMs: number;
  statusTimeoutMs: number;
  base: typeof globalThis.fetch;
};

type SendResult =
  | { ok: true; response: Response }
  | { ok: false; error: "Timeout" | "Unreachable" };

// --- single-flight map ---

type SingleFlightEntry = { op: "load" | "unload"; promise: Promise<unknown> };

const singleFlight = new Map<string, SingleFlightEntry>();

// --- request helpers ---

function buildBaseUrl(host: string, port: number): string {
  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${formatHostForUrl(normalizedHost)}:${String(port)}`;
}

function applyAuth(apiKey: string | undefined, init: RequestInit): RequestInit {
  if (apiKey === undefined) {
    return init;
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return { ...init, headers };
}

function errorName(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = err.name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

// Bun rejects an AbortSignal.timeout fetch with a DOMException named
// "TimeoutError"; treat that, "AbortError" or an aborted signal as a timeout
// and anything else as an unreachable network failure.
function classifyFetchError(signal: AbortSignal, err: unknown): "Timeout" | "Unreachable" {
  const name = errorName(err);
  if (signal.aborted || name === "TimeoutError" || name === "AbortError") {
    return "Timeout";
  }
  return "Unreachable";
}

async function send(
  ctx: ClientCtx,
  path: string,
  method: "GET" | "POST",
  timeoutMs: number,
): Promise<SendResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await ctx.base(
      `${ctx.baseUrl}${path}`,
      applyAuth(ctx.apiKey, { method, signal }),
    );
    return { ok: true, response };
  } catch (err) {
    return { ok: false, error: classifyFetchError(signal, err) };
  }
}

// checkServingReadiness builds its own absolute URL and passes only a signal,
// so this wrapper only injects the bearer header while keeping the signal.
function authFetch(
  base: typeof globalThis.fetch,
  apiKey: string | undefined,
): typeof globalThis.fetch {
  if (apiKey === undefined) {
    return base;
  }
  const wrapper = (input: URL | Request | string, init?: RequestInit): Promise<Response> =>
    base(input, applyAuth(apiKey, init ?? {}));
  // @types/bun adds a `preconnect` member to `typeof fetch` that a bare
  // function lacks; carry it through so the wrapper stays a valid fetch.
  return Object.assign(wrapper, { preconnect: base.preconnect.bind(base) });
}

// --- status ---

function activityKnown(activity: NativeModelActivity | "unknown"): activity is NativeModelActivity {
  return activity !== "unknown";
}

async function fetchActivity(
  ctx: ClientCtx,
  engineType: string | undefined,
): Promise<NativeModelActivity | "unknown"> {
  if (!ctx.activityObservable) {
    return "unknown";
  }
  if (!engineIsObservable(engineType)) {
    return "unknown";
  }
  const sent = await send(ctx, OMLX_ACTIVITY_PATH, "GET", ctx.statusTimeoutMs);
  if (!sent.ok || !sent.response.ok) {
    return "unknown";
  }
  try {
    const parsed = parseOmlxActivity(await sent.response.json());
    return parsed ?? "unknown";
  } catch {
    return "unknown";
  }
}

function loadedStatus(
  observation: Extract<NativeModelStatusObservation, { state: "loaded" }>,
  activity: NativeModelActivity | "unknown",
): NativeStatus {
  if (activityKnown(activity) && activity.activeRequests + activity.waitingRequests > 0) {
    return {
      state: "busy",
      modelId: observation.modelId,
      actualSize: observation.actualSize,
      residentEstimatedSize: observation.residentEstimatedSize,
      activity,
    };
  }
  return {
    state: "ready",
    modelId: observation.modelId,
    actualSize: observation.actualSize,
    residentEstimatedSize: observation.residentEstimatedSize,
    activity,
  };
}

async function statusInner(ctx: ClientCtx): Promise<NativeStatus> {
  const sent = await send(ctx, OMLX_MODELS_STATUS_PATH, "GET", ctx.statusTimeoutMs);
  if (!sent.ok) {
    return { state: "unknown", reason: "StatusUnreachable" };
  }
  const response = sent.response;
  if (response.status === 401 || response.status === 403) {
    return { state: "failed", reason: "Unauthorized", httpStatus: response.status };
  }
  if (response.status === 404) {
    return { state: "failed", reason: "NativeStatusUnsupported", httpStatus: response.status };
  }
  if (!response.ok) {
    return { state: "failed", reason: "StatusHttpError", httpStatus: response.status };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: "failed", reason: "MalformedStatus" };
  }

  const observation = parseOmlxModelsStatus(body, ctx.hostedRel);
  if (observation.state !== "loaded") {
    return observation;
  }

  const engineType = "engineType" in observation ? observation.engineType : undefined;
  const activity = await fetchActivity(ctx, engineType);
  if (
    ctx.readiness === undefined ||
    (activityKnown(activity) && activity.activeRequests + activity.waitingRequests > 0)
  ) {
    return loadedStatus(observation, activity);
  }

  const readinessOk = await checkServingReadiness(ctx.endpoint, ctx.readiness, {
    fetch: authFetch(ctx.base, ctx.apiKey),
    timeoutMs: ctx.statusTimeoutMs,
  });
  const derived = deriveOmlxResidency(observation, readinessOk);
  return {
    state: derived.state === "resident" ? "resident" : "ready",
    modelId: observation.modelId,
    actualSize: observation.actualSize,
    residentEstimatedSize: observation.residentEstimatedSize,
    activity,
  };
}

// --- load / unload bodies ---

function classifyLoadResponse(body: unknown, modelId: string): NativeLoadResult {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (record["status"] === "ok") {
      const message = record["message"];
      if (typeof message === "string" && message.startsWith("Already loaded")) {
        return { kind: "already-loaded", modelId };
      }
      return { kind: "loaded", modelId };
    }
  }
  return { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" };
}

async function runLoad(ctx: ClientCtx): Promise<NativeLoadResult> {
  const statusResult = await statusInner(ctx);
  if (statusResult.state === "failed" || statusResult.state === "unknown") {
    return { kind: "refused", reason: "StatusUnavailable" };
  }
  if (statusResult.state === "loading") {
    return { kind: "refused", reason: "LoadInProgress" };
  }
  if (statusResult.state !== "discovered") {
    return { kind: "already-loaded", modelId: statusResult.modelId };
  }

  const sent = await send(
    ctx,
    omlxModelActionPath("load", statusResult.modelId),
    "POST",
    ctx.requestTimeoutMs,
  );
  if (!sent.ok) {
    return { kind: "ambiguous", reason: sent.error, reservation: "uncertain" };
  }
  const response = sent.response;
  if (response.ok) {
    try {
      return classifyLoadResponse(await response.json(), statusResult.modelId);
    } catch {
      return { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" };
    }
  }
  const httpStatus = response.status;
  if (httpStatus === 404) {
    return { kind: "failed", reason: "ModelNotListed", httpStatus };
  }
  if (httpStatus === 507) {
    return { kind: "failed", reason: "InsufficientMemory", httpStatus };
  }
  if (httpStatus === 409) {
    return { kind: "failed", reason: "Conflict", httpStatus };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "failed", reason: "Unauthorized", httpStatus };
  }
  return { kind: "ambiguous", reason: "HttpError", reservation: "uncertain", httpStatus };
}

// A 400 means "not loaded"; only a follow-up status that parses as discovered
// confirms it, so a stale 400 stays ambiguous rather than claiming release.
async function confirmUnload400(ctx: ClientCtx, modelId: string): Promise<NativeUnloadResult> {
  const reSent = await send(ctx, OMLX_MODELS_STATUS_PATH, "GET", ctx.statusTimeoutMs);
  if (reSent.ok && reSent.response.ok) {
    try {
      const reObservation = parseOmlxModelsStatus(await reSent.response.json(), ctx.hostedRel);
      if (reObservation.state === "discovered") {
        return { kind: "already-unloaded", modelId, reservation: "released" };
      }
    } catch {
      // fall through to unconfirmed
    }
  }
  return {
    kind: "ambiguous",
    reason: "UnloadUnconfirmed",
    reservation: "uncertain",
    httpStatus: 400,
  };
}

function classifyUnloadResponse(body: unknown, modelId: string): NativeUnloadResult {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (record["status"] === "ok") {
      return { kind: "unloaded", modelId, reservation: "released" };
    }
  }
  return { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" };
}

type ResidentStatus = Extract<NativeStatus, { state: "busy" | "resident" | "ready" }>;

async function postUnload(ctx: ClientCtx, modelId: string): Promise<NativeUnloadResult> {
  const sent = await send(
    ctx,
    omlxModelActionPath("unload", modelId),
    "POST",
    ctx.requestTimeoutMs,
  );
  if (!sent.ok) {
    return { kind: "ambiguous", reason: sent.error, reservation: "uncertain" };
  }
  const response = sent.response;
  if (response.ok) {
    try {
      return classifyUnloadResponse(await response.json(), modelId);
    } catch {
      return { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" };
    }
  }
  const httpStatus = response.status;
  if (httpStatus === 400) {
    return await confirmUnload400(ctx, modelId);
  }
  if (httpStatus === 404) {
    return { kind: "failed", reason: "ModelNotListed", reservation: "held", httpStatus };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "failed", reason: "Unauthorized", reservation: "held", httpStatus };
  }
  return { kind: "ambiguous", reason: "HttpError", reservation: "uncertain", httpStatus };
}

// A resident model only unloads when activity is known idle; unknown or busy
// activity is refused (advisory guard) so a live request is never aborted.
async function unloadResident(
  ctx: ClientCtx,
  statusResult: ResidentStatus,
): Promise<NativeUnloadResult> {
  if (!activityKnown(statusResult.activity)) {
    return { kind: "refused", reason: "ActivityUnknown", reservation: "held" };
  }
  if (statusResult.activity.activeRequests + statusResult.activity.waitingRequests > 0) {
    return { kind: "refused", reason: "BackendBusy", reservation: "held" };
  }
  return await postUnload(ctx, statusResult.modelId);
}

async function runUnload(ctx: ClientCtx): Promise<NativeUnloadResult> {
  const statusResult = await statusInner(ctx);
  if (
    statusResult.state === "resident" ||
    statusResult.state === "ready" ||
    statusResult.state === "busy"
  ) {
    return await unloadResident(ctx, statusResult);
  }
  if (statusResult.state === "discovered") {
    return { kind: "already-unloaded", modelId: statusResult.modelId, reservation: "released" };
  }
  if (statusResult.state === "loading") {
    return { kind: "refused", reason: "LoadInProgress", reservation: "held" };
  }
  return { kind: "refused", reason: "StatusUnavailable", reservation: "held" };
}

// --- single-flight wrapper ---

// The entry is committed synchronously at entry (before any await) so a
// concurrent call from another client sees it; same op shares the promise, the
// other op is refused without issuing a request.
function singleFlightRun<T>(
  ctx: ClientCtx,
  op: "load" | "unload",
  busyResult: () => T,
  body: () => Promise<T>,
): Promise<T> {
  const key = `${ctx.baseUrl}|${ctx.hostedRel}`;
  const existing = singleFlight.get(key);
  if (existing !== undefined) {
    if (existing.op === op) {
      return existing.promise as Promise<T>;
    }
    return Promise.resolve(busyResult());
  }
  const promise = body();
  singleFlight.set(key, { op, promise });
  return promise.finally(() => {
    singleFlight.delete(key);
  });
}

// --- public factory ---

export function createOmlxNativeClient(opts: OmlxNativeClientOptions): OmlxNativeClient {
  const ctx: ClientCtx = {
    baseUrl: buildBaseUrl(opts.endpoint.host, opts.endpoint.port),
    endpoint: opts.endpoint,
    hostedRel: opts.hostedRel,
    activityObservable: opts.activityObservable,
    apiKey: opts.apiKey,
    readiness: opts.readiness,
    requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
    statusTimeoutMs: opts.statusTimeoutMs ?? 5_000,
    base: opts.fetch ?? globalThis.fetch,
  };

  return {
    async status(): Promise<NativeStatus> {
      return await statusInner(ctx);
    },
    async load(): Promise<NativeLoadResult> {
      return await singleFlightRun(
        ctx,
        "load",
        () => ({ kind: "refused", reason: "OperationInProgress" }),
        () => runLoad(ctx),
      );
    },
    async unload(): Promise<NativeUnloadResult> {
      return await singleFlightRun(
        ctx,
        "unload",
        () => ({ kind: "refused", reason: "OperationInProgress", reservation: "held" }),
        () => runUnload(ctx),
      );
    },
  };
}
