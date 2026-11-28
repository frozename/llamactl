/**
 * oMLX native residency client — status, load and unload over HTTP.
 *
 * The BackendBusy/ActivityUnknown guard is advisory and racy: it is a
 * check-then-act against oMLX's immediate-abort unload, so a request that
 * arrives between the activity GET and the unload POST is still aborted.
 *
 * When `leases` is supplied, the activity guard is backed by lease fencing
 * for llamactl-routed requests: beginDrain() fences before any HTTP call,
 * cancelDrain() reopens admission on non-terminal outcomes, and
 * commitUnload() fences until a native load reopens.  Traffic that bypasses
 * llamactl still races the activity check.
 *
 * DFlash caveat: DFlash-hosted model activity is invisible to /api/status at
 * feec0a0e (server.py:3171-3188 walks engine._engine.engine._output_collectors
 * and DFlashEngine has no _engine attribute). Callers therefore pass
 * `hostedModel.dflash?.enabled !== true` for activityObservable, so a false
 * value makes unload fail closed.
 *
 * Session fence (#520): with leases, a bound session (in flight or idle within
 * its timeout) refuses the unload as SessionsActive, and a registry whose
 * checkUnload throws refuses it as SessionsUnknown. Both refusals run after the
 * LeasesActive check, cancel the drain and send no unload request. The unload
 * never releases sessions.
 */
import type {
  ModelHostReadiness,
  NativeModelActivity,
  NativeModelStatusObservation,
} from "@llamactl/core/engines";
import type { DrainToken, ResidencyLeases } from "@llamactl/core/residency/leases";
import type { SessionRefcounts } from "@llamactl/core/residency/sessions";

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
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { currentSessionRefcounts } from "@llamactl/core/residency/sessions";
import { isIP } from "node:net";
import { basename, isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
  | { state: "failed"; reason: "ModelNotListed" | "MalformedStatus" | "IdentityUnverified" }
  | {
      state: "failed";
      reason: "Unauthorized" | "NativeStatusUnsupported" | "StatusHttpError";
      httpStatus: number;
    }
  | { state: "unknown"; reason: "StatusUnreachable" };

export type NativeLoadResult =
  | { kind: "loaded" | "already-loaded"; modelId: string }
  | {
      kind: "refused";
      reason:
        | "StatusUnavailable"
        | "IdentityUnverified"
        | "LoadInProgress"
        | "OperationInProgress"
        | "ManagedReservationUnavailable";
    }
  | {
      kind: "failed";
      reason: "ModelNotListed" | "InsufficientMemory" | "Conflict" | "Unauthorized";
      httpStatus: number;
    }
  | { kind: "ambiguous"; reason: "HttpError"; reservation: "uncertain"; httpStatus: number }
  | {
      kind: "ambiguous";
      reason: "Timeout" | "Unreachable" | "MalformedResponse" | "LoadUnconfirmed";
      reservation: "uncertain";
    };

export type NativeUnloadResult =
  | { kind: "unloaded" | "already-unloaded"; modelId: string; reservation: "released" }
  | {
      kind: "refused";
      reason:
        | "StatusUnavailable"
        | "IdentityUnverified"
        | "LoadInProgress"
        | "OperationInProgress"
        | "BackendBusy"
        | "ActivityUnknown"
        | "DrainInProgress"
        | "ManagedReservationUnavailable";
      reservation: "held";
    }
  | {
      kind: "refused";
      reason: "LeasesActive" | "SessionsActive" | "SessionsUnknown";
      reservation: "held";
      active: string[];
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
      reason:
        | "Timeout"
        | "Unreachable"
        | "MalformedResponse"
        | "DrainChanged"
        | "ManagedReleaseUnverified";
      reservation: "uncertain";
    };

type NativeLeasesOption = {
  registry: ResidencyLeases;
  workload: string;
  /** undefined: resolve the installed session registry at unload time; null: opt out (#520). */
  sessions?: SessionRefcounts | null;
};

type NativeEndpoint = Readonly<{ host: string; port: number }>;

export type OmlxNativePin = Readonly<{
  endpoint: NativeEndpoint;
  modelId: string;
  modelPath: string;
  artifactRevision: string;
  runtimeGeneration: string;
}>;

export type OmlxNativeBinding = OmlxNativePin & {
  /** Trusted local proof that the exact artifact and owning listener generation still match. */
  stillCurrent: (pin: OmlxNativePin) => boolean;
};

function localNativeEndpoint(endpoint: NativeEndpoint): boolean {
  const { host, port } = endpoint;
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    (isIP(host) === 4 && host.startsWith("127."));
  return loopback && Number.isInteger(port) && port > 0 && port <= 65535;
}

export function nativeBindingCurrent(
  binding: OmlxNativeBinding | undefined,
  endpoint: NativeEndpoint,
): boolean {
  if (binding === undefined) return false;
  const { stillCurrent, ...pin } = binding;
  if (!localNativeEndpoint(endpoint) || !isDeepStrictEqual(pin.endpoint, endpoint)) return false;
  if (
    !isAbsolute(pin.modelPath) ||
    normalize(pin.modelPath) !== pin.modelPath ||
    pin.modelPath.includes("\0")
  )
    return false;
  if (
    [pin.modelId, pin.artifactRevision, pin.runtimeGeneration].some(
      (value) => value.trim().length === 0,
    )
  )
    return false;
  if (pin.modelId === "." || pin.modelId === "..") return false;
  try {
    return stillCurrent(Object.freeze(pin));
  } catch {
    return false;
  }
}

export type OmlxNativeClientOptions = {
  endpoint: { host: string; port: number };
  hostedRel: string;
  binding?: OmlxNativeBinding;
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
  /** ModelHost workload key for residency lease fencing. */
  leases?: NativeLeasesOption;
};

export type OmlxNativeLoadLease = Readonly<{
  registry: ResidencyLeases;
  token: Readonly<DrainToken>;
  phase: "open" | "unloaded";
}>;

export type OmlxNativeLoadReceipt = Readonly<{
  modelId: string;
  binding: OmlxNativePin | undefined;
  lease: OmlxNativeLoadLease;
}>;

type OmlxNativeLoadCommit = {
  workload: string;
  commitReady(receipt: OmlxNativeLoadReceipt): boolean;
  expectedLease?: OmlxNativeLoadLease;
  beforeDispatch?: (receipt: OmlxNativeLoadReceipt) => boolean;
};

export type OmlxNativeUnloadReceipt = Readonly<{
  modelId: string;
  binding: OmlxNativePin;
  registry: ResidencyLeases;
  token: Readonly<DrainToken>;
}>;

type OmlxNativeUnloadCommit = {
  workload: string;
  beforeDispatch(receipt: OmlxNativeUnloadReceipt): boolean;
  commitParked(receipt: OmlxNativeUnloadReceipt): boolean;
};

type BeforeNativeAction = (modelId: string) => boolean;

export type OmlxNativeClient = {
  status(): Promise<NativeStatus>;
  load(): Promise<NativeLoadResult>;
  loadWithCommit?(commit: OmlxNativeLoadCommit): Promise<NativeLoadResult>;
  unload(): Promise<NativeUnloadResult>;
  unloadWithCommit?(commit: OmlxNativeUnloadCommit): Promise<NativeUnloadResult>;
};

// --- internal context ---

type ClientCtx = {
  baseUrl: string;
  endpoint: { host: string; port: number };
  hostedRel: string;
  binding: OmlxNativeBinding | undefined;
  activityObservable: boolean;
  apiKey: string | undefined;
  readiness: ModelHostReadiness | undefined;
  requestTimeoutMs: number;
  statusTimeoutMs: number;
  base: typeof globalThis.fetch;
  leases: NativeLeasesOption | undefined;
};

type SendResult =
  | { ok: true; response: Response }
  | { ok: false; error: "Timeout" | "Unreachable" };

// --- single-flight map ---

type SingleFlightEntry = {
  op: "load" | "unload";
  promise: Promise<unknown>;
  ctx: ClientCtx;
  exclusive: boolean;
};

const singleFlight = new Map<string, SingleFlightEntry>();

// --- request helpers ---

export function buildBaseUrl(host: string, port: number): string {
  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${formatHostForUrl(normalizedHost)}:${String(port)}`;
}

export function applyAuth(apiKey: string | undefined, init: RequestInit): RequestInit {
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
export function classifyFetchError(signal: AbortSignal, err: unknown): "Timeout" | "Unreachable" {
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
      applyAuth(ctx.apiKey, { method, signal, redirect: "error" }),
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
  const wrapper = (input: URL | Request | string, init?: RequestInit): Promise<Response> =>
    base(input, applyAuth(apiKey, { ...init, redirect: "error" }));
  // @types/bun adds a `preconnect` member to `typeof fetch` that a bare
  // function lacks; carry it through so the wrapper stays a valid fetch.
  return Object.assign(wrapper, {
    preconnect: (...args: Parameters<typeof base.preconnect>): void => {
      base.preconnect(...args);
    },
  });
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

function identityCurrent(ctx: ClientCtx): boolean {
  return ctx.binding === undefined || nativeBindingCurrent(ctx.binding, ctx.endpoint);
}

function identityFailure(): { state: "failed"; reason: "IdentityUnverified" } {
  return { state: "failed", reason: "IdentityUnverified" };
}

function statusRefusal(status: NativeStatus): "IdentityUnverified" | "StatusUnavailable" {
  return "reason" in status && status.reason === "IdentityUnverified"
    ? "IdentityUnverified"
    : "StatusUnavailable";
}

type NativeObservation =
  | NativeModelStatusObservation
  | Extract<NativeStatus, { state: "failed" | "unknown" }>;

async function observeNativeModel(ctx: ClientCtx): Promise<NativeObservation> {
  if (!identityCurrent(ctx)) return identityFailure();
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

  if (!identityCurrent(ctx)) return identityFailure();
  return parseOmlxModelsStatus(body, ctx.hostedRel, ctx.binding);
}

async function statusInner(ctx: ClientCtx): Promise<NativeStatus> {
  const observation = await observeNativeModel(ctx);
  if (observation.state !== "loaded") {
    return observation;
  }

  const engineType = "engineType" in observation ? observation.engineType : undefined;
  const activity = await fetchActivity(ctx, engineType);
  if (!identityCurrent(ctx)) return identityFailure();
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
  if (!identityCurrent(ctx)) return identityFailure();
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

function classifyLoadResponse(
  body: unknown,
  modelId: string,
  qualified: boolean,
): NativeLoadResult {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (validNativeReceipt(record, modelId, qualified)) {
      const message = record["message"];
      if (typeof message === "string" && message.startsWith("Already loaded")) {
        return { kind: "already-loaded", modelId };
      }
      return { kind: "loaded", modelId };
    }
  }
  return { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" };
}

function validNativeReceipt(
  record: Record<string, unknown>,
  modelId: string,
  qualified: boolean,
): boolean {
  return (
    record["status"] === "ok" &&
    (record["model_id"] === modelId || (!qualified && record["model_id"] === undefined))
  );
}

function loadConfirmed(ctx: ClientCtx, status: NativeStatus): status is ResidentStatus {
  return (
    identityCurrent(ctx) &&
    (status.state === "ready" || (ctx.readiness === undefined && status.state === "busy"))
  );
}

async function exactLoadedObservation(
  ctx: ClientCtx,
  modelId: string,
  requireObservable: boolean,
): Promise<boolean> {
  const observation = await observeNativeModel(ctx);
  return (
    observation.state === "loaded" &&
    observation.modelId === modelId &&
    (!requireObservable || engineIsObservable(observation.engineType)) &&
    identityCurrent(ctx)
  );
}

async function confirmedNativeLoad(
  ctx: ClientCtx,
  status: NativeStatus,
  modelId: string,
): Promise<boolean> {
  if (!loadConfirmed(ctx, status) || status.modelId !== modelId) return false;
  return ctx.binding === undefined || (await exactLoadedObservation(ctx, modelId, false));
}

function unconfirmedLoad(): NativeLoadResult {
  return { kind: "ambiguous", reason: "LoadUnconfirmed", reservation: "uncertain" };
}

async function verifyLoadReceipt(
  ctx: ClientCtx,
  response: Response,
  modelId: string,
): Promise<NativeLoadResult> {
  let receipt: NativeLoadResult;
  try {
    receipt = classifyLoadResponse(await response.json(), modelId, ctx.binding !== undefined);
  } catch {
    return { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" };
  }
  if (receipt.kind !== "loaded" && receipt.kind !== "already-loaded") return receipt;
  const status = await statusInner(ctx);
  return (await confirmedNativeLoad(ctx, status, modelId)) ? receipt : unconfirmedLoad();
}

async function runLoad(
  ctx: ClientCtx,
  beforeDispatch?: BeforeNativeAction,
): Promise<NativeLoadResult> {
  const statusResult = await statusInner(ctx);
  if (statusResult.state === "failed" || statusResult.state === "unknown") {
    return { kind: "refused", reason: statusRefusal(statusResult) };
  }
  if (statusResult.state === "loading") {
    return { kind: "refused", reason: "LoadInProgress" };
  }
  if (statusResult.state !== "discovered") {
    return (await confirmedNativeLoad(ctx, statusResult, statusResult.modelId))
      ? { kind: "already-loaded", modelId: statusResult.modelId }
      : unconfirmedLoad();
  }

  if (!identityCurrent(ctx)) return { kind: "refused", reason: "IdentityUnverified" };
  if (beforeDispatch?.(statusResult.modelId) === false) {
    return { kind: "refused", reason: "ManagedReservationUnavailable" };
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
  if (!identityCurrent(ctx)) {
    void response.body?.cancel().catch(() => undefined);
    return unconfirmedLoad();
  }
  if (response.status === 202) {
    void response.body?.cancel().catch(() => undefined);
    return unconfirmedLoad();
  }
  if (response.ok) {
    return await verifyLoadReceipt(ctx, response, statusResult.modelId);
  }
  return classifyLoadHttpError(response.status);
}

function classifyLoadHttpError(httpStatus: number): NativeLoadResult {
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

function loadLeaseCurrent(lease: OmlxNativeLoadLease): boolean {
  const current = lease.registry.snapshot(lease.token.workload);
  return current.epoch === lease.token.epoch && current.phase === lease.phase;
}

function sameLoadLease(a: OmlxNativeLoadLease, b: OmlxNativeLoadLease): boolean {
  return (
    a.registry === b.registry &&
    a.token.workload === b.token.workload &&
    a.token.epoch === b.token.epoch &&
    a.phase === b.phase
  );
}

function confirmNativeProof(check: () => boolean): boolean {
  try {
    const confirmed: unknown = check();
    return confirmed === true;
  } catch {
    return false;
  }
}

function loadCommitRefusal(
  ctx: ClientCtx,
  lease: OmlxNativeLoadLease,
  commit: OmlxNativeLoadCommit | undefined,
): NativeLoadResult | undefined {
  if (commit === undefined) return undefined;
  if (commit.workload !== lease.token.workload) {
    return { kind: "refused", reason: "IdentityUnverified" };
  }
  if (
    commit.beforeDispatch !== undefined &&
    (commit.expectedLease?.phase !== "unloaded" || ctx.readiness === undefined)
  ) {
    return { kind: "refused", reason: "ManagedReservationUnavailable" };
  }
  if (commit.expectedLease === undefined) return undefined;
  if (!sameLoadLease(commit.expectedLease, lease)) {
    return { kind: "refused", reason: "OperationInProgress" };
  }
  return ctx.binding === undefined ? { kind: "refused", reason: "IdentityUnverified" } : undefined;
}

function publishConfirmedLoad(
  ctx: ClientCtx,
  lease: OmlxNativeLoadLease,
  modelId: string,
  commit: OmlxNativeLoadCommit | undefined,
): boolean {
  if (!loadLeaseCurrent(lease)) return false;
  if (commit !== undefined) {
    const receipt = Object.freeze({ modelId, binding: ctx.binding, lease });
    if (
      !identityCurrent(ctx) ||
      !confirmNativeProof(() => commit.commitReady(receipt)) ||
      !identityCurrent(ctx) ||
      !loadLeaseCurrent(lease)
    ) {
      return false;
    }
  }
  return lease.phase === "open" || lease.registry.reopen(lease.token);
}

async function runLoadWithLeases(
  ctx: ClientCtx,
  commit?: OmlxNativeLoadCommit,
): Promise<NativeLoadResult> {
  const leases = ctx.leases;
  if (leases === undefined) return await runLoad(ctx);
  const started = leases.registry.snapshot(leases.workload);
  if (started.phase === "draining") {
    return { kind: "refused", reason: "OperationInProgress" };
  }
  const lease = Object.freeze({
    registry: leases.registry,
    token: Object.freeze({ workload: leases.workload, epoch: started.epoch }),
    phase: started.phase,
  });
  const refusal = loadCommitRefusal(ctx, lease, commit);
  if (refusal !== undefined) return refusal;
  const beforeDispatch = commit?.beforeDispatch;
  const result = await runLoad(
    ctx,
    beforeDispatch === undefined
      ? undefined
      : (modelId): boolean =>
          loadLeaseCurrent(lease) &&
          confirmNativeProof(() =>
            beforeDispatch(Object.freeze({ modelId, binding: ctx.binding, lease })),
          ) &&
          identityCurrent(ctx) &&
          loadLeaseCurrent(lease),
  );
  if (result.kind !== "loaded" && result.kind !== "already-loaded") return result;
  return publishConfirmedLoad(ctx, lease, result.modelId, commit) ? result : unconfirmedLoad();
}

async function confirmNativeUnload(
  ctx: ClientCtx,
  modelId: string,
  result: "unloaded" | "already-unloaded",
  httpStatus: number,
): Promise<NativeUnloadResult> {
  const observation = await observeNativeModel(ctx);
  if (
    observation.state === "discovered" &&
    observation.modelId === modelId &&
    identityCurrent(ctx)
  ) {
    return { kind: result, modelId, reservation: "released" };
  }
  return {
    kind: "ambiguous",
    reason: "UnloadUnconfirmed",
    reservation: "uncertain",
    httpStatus,
  };
}

async function verifyUnloadReceipt(
  ctx: ClientCtx,
  response: Response,
  modelId: string,
): Promise<NativeUnloadResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" };
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !validNativeReceipt(body as Record<string, unknown>, modelId, ctx.binding !== undefined)
  ) {
    return { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" };
  }
  return await confirmNativeUnload(ctx, modelId, "unloaded", response.status);
}

type ResidentStatus = Extract<NativeStatus, { state: "busy" | "resident" | "ready" }>;

function refuseUnboundUnload(): NativeUnloadResult {
  return { kind: "refused", reason: "IdentityUnverified", reservation: "held" };
}

function unloadAdmissionRefusal(): NativeUnloadResult {
  return { kind: "refused", reason: "ManagedReservationUnavailable", reservation: "held" };
}

async function postUnload(
  ctx: ClientCtx,
  modelId: string,
  beforeDispatch: BeforeNativeAction | undefined,
): Promise<NativeUnloadResult> {
  if (ctx.binding !== undefined && !(await exactLoadedObservation(ctx, modelId, true))) {
    return refuseUnboundUnload();
  }
  if (!identityCurrent(ctx)) return refuseUnboundUnload();
  if (beforeDispatch?.(modelId) === false) return unloadAdmissionRefusal();
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
  if (!identityCurrent(ctx)) {
    void response.body?.cancel().catch(() => undefined);
    return {
      kind: "ambiguous",
      reason: "UnloadUnconfirmed",
      reservation: "uncertain",
      httpStatus: response.status,
    };
  }
  if (response.status === 202) {
    void response.body?.cancel().catch(() => undefined);
    return {
      kind: "ambiguous",
      reason: "UnloadUnconfirmed",
      reservation: "uncertain",
      httpStatus: 202,
    };
  }
  if (response.ok) {
    return await verifyUnloadReceipt(ctx, response, modelId);
  }
  const httpStatus = response.status;
  if (httpStatus === 400) {
    return await confirmNativeUnload(ctx, modelId, "already-unloaded", httpStatus);
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
  beforeDispatch: BeforeNativeAction | undefined,
): Promise<NativeUnloadResult> {
  if (!activityKnown(statusResult.activity)) {
    return { kind: "refused", reason: "ActivityUnknown", reservation: "held" };
  }
  if (statusResult.activity.activeRequests + statusResult.activity.waitingRequests > 0) {
    return { kind: "refused", reason: "BackendBusy", reservation: "held" };
  }
  return await postUnload(ctx, statusResult.modelId, beforeDispatch);
}

async function runUnload(
  ctx: ClientCtx,
  beforeDispatch?: BeforeNativeAction,
): Promise<NativeUnloadResult> {
  const statusResult = await statusInner(ctx);
  if (
    statusResult.state === "resident" ||
    statusResult.state === "ready" ||
    statusResult.state === "busy"
  ) {
    return await unloadResident(ctx, statusResult, beforeDispatch);
  }
  if (statusResult.state === "discovered") {
    if (!identityCurrent(ctx)) return refuseUnboundUnload();
    if (beforeDispatch?.(statusResult.modelId) === false) return unloadAdmissionRefusal();
    return { kind: "already-unloaded", modelId: statusResult.modelId, reservation: "released" };
  }
  if (statusResult.state === "loading") {
    return { kind: "refused", reason: "LoadInProgress", reservation: "held" };
  }
  return { kind: "refused", reason: statusRefusal(statusResult), reservation: "held" };
}

export function sessionUnloadRefusal(
  sessions: Pick<SessionRefcounts, "checkUnload"> | null | undefined,
  workload: string,
): Extract<NativeUnloadResult, { active: string[] }> | null {
  const resolved = sessions === undefined ? currentSessionRefcounts() : sessions;
  if (resolved === null) return null;
  let check;
  try {
    check = resolved.checkUnload(workload);
  } catch {
    return { kind: "refused", reason: "SessionsUnknown", reservation: "held", active: [] };
  }
  if (check.ok) return null;
  return {
    kind: "refused",
    reason: "SessionsActive",
    reservation: "held",
    active: [...check.sessions],
  };
}

function drainRefusal(
  leases: NativeLeasesOption,
  token: Readonly<DrainToken>,
  active: string[],
): NativeUnloadResult | null {
  const refusal =
    active.length > 0
      ? ({ kind: "refused", reason: "LeasesActive", reservation: "held", active } as const)
      : sessionUnloadRefusal(leases.sessions, leases.workload);
  if (refusal !== null) leases.registry.cancelDrain(token);
  return refusal;
}

function managedUnloadUnconfirmed(): NativeUnloadResult {
  return { kind: "ambiguous", reason: "ManagedReleaseUnverified", reservation: "uncertain" };
}

function drainChanged(): NativeUnloadResult {
  return { kind: "ambiguous", reason: "DrainChanged", reservation: "uncertain" };
}

function unverifiedBoundUnload(result: NativeUnloadResult): boolean {
  return (
    result.reservation === "uncertain" ||
    (result.kind === "refused" && result.reason === "IdentityUnverified")
  );
}

function settleUnloadBeforeDispatch(
  ctx: ClientCtx,
  registry: ResidencyLeases,
  token: Readonly<DrainToken>,
  result: NativeUnloadResult,
): NativeUnloadResult {
  const outcome = identityCurrent(ctx) ? result : refuseUnboundUnload();
  if (unverifiedBoundUnload(outcome)) {
    return registry.commitUnload(token).ok ? outcome : drainChanged();
  }
  registry.cancelDrain(token);
  return outcome;
}

async function unloadWithDurableProof(
  ctx: ClientCtx,
  registry: ResidencyLeases,
  token: Readonly<DrainToken>,
  binding: OmlxNativePin,
  commit: OmlxNativeUnloadCommit,
): Promise<NativeUnloadResult> {
  let receipt: OmlxNativeUnloadReceipt | undefined;
  const stillDraining = (): boolean => {
    const lease = registry.snapshot(token.workload);
    return lease.phase === "draining" && lease.epoch === token.epoch;
  };
  const beforeDispatch = (modelId: string): boolean => {
    const pending = Object.freeze({ modelId, binding, registry, token });
    if (!stillDraining() || !confirmNativeProof(() => commit.beforeDispatch(pending))) return false;
    receipt = pending;
    return identityCurrent(ctx) && stillDraining();
  };
  let result: NativeUnloadResult;
  try {
    result = await runUnload(ctx, beforeDispatch);
  } catch (error) {
    if (receipt === undefined) {
      settleUnloadBeforeDispatch(ctx, registry, token, unloadAdmissionRefusal());
      throw error;
    }
    result = managedUnloadUnconfirmed();
  }

  const confirmed = receipt;
  if (confirmed === undefined) return settleUnloadBeforeDispatch(ctx, registry, token, result);
  return settleDurableUnload(ctx, commit, confirmed, result);
}

function settleDurableUnload(
  ctx: ClientCtx,
  commit: OmlxNativeUnloadCommit,
  receipt: OmlxNativeUnloadReceipt,
  result: NativeUnloadResult,
): NativeUnloadResult {
  if (!receipt.registry.commitUnload(receipt.token).ok) return drainChanged();
  if (result.reservation === "released") {
    return identityCurrent(ctx) && confirmNativeProof(() => commit.commitParked(receipt))
      ? result
      : managedUnloadUnconfirmed();
  }
  return result.kind === "ambiguous" ? result : managedUnloadUnconfirmed();
}

async function unloadWithLocalDrain(
  ctx: ClientCtx,
  registry: ResidencyLeases,
  token: Readonly<DrainToken>,
): Promise<NativeUnloadResult> {
  let result: NativeUnloadResult;
  try {
    result = await runUnload(ctx);
  } catch (error) {
    registry.cancelDrain(token);
    throw error;
  }
  const unverified = ctx.binding !== undefined && unverifiedBoundUnload(result);
  if (result.reservation === "released" || unverified) {
    return registry.commitUnload(token).ok ? result : drainChanged();
  }
  registry.cancelDrain(token);
  return result;
}

async function runUnloadWithLeases(
  ctx: ClientCtx,
  commit?: OmlxNativeUnloadCommit,
): Promise<NativeUnloadResult> {
  const leases = ctx.leases;
  if (leases === undefined) return await runUnload(ctx);

  const { registry, workload } = leases;
  const binding = ctx.binding;
  if (commit !== undefined && (commit.workload !== workload || binding === undefined)) {
    return unloadAdmissionRefusal();
  }
  const drain = registry.beginDrain(workload);
  if (!drain.ok) {
    if (drain.reason === "AlreadyDraining") {
      return { kind: "refused", reason: "DrainInProgress", reservation: "held" };
    }
    return commit === undefined ? await runUnload(ctx) : unloadAdmissionRefusal();
  }
  const refusal = drainRefusal(leases, drain.token, drain.active);
  if (refusal !== null) return refusal;
  return commit === undefined || binding === undefined
    ? await unloadWithLocalDrain(ctx, registry, drain.token)
    : await unloadWithDurableProof(
        ctx,
        registry,
        Object.freeze({ ...drain.token }),
        binding,
        commit,
      );
}

// --- single-flight wrapper ---

function canShareNativeFlight(a: ClientCtx, b: ClientCtx): boolean {
  return (
    a.hostedRel === b.hostedRel &&
    isDeepStrictEqual(a.binding, b.binding) &&
    a.apiKey === b.apiKey &&
    a.base === b.base &&
    a.activityObservable === b.activityObservable &&
    a.requestTimeoutMs === b.requestTimeoutMs &&
    a.statusTimeoutMs === b.statusTimeoutMs &&
    isDeepStrictEqual(a.readiness, b.readiness) &&
    a.leases?.registry === b.leases?.registry &&
    a.leases?.workload === b.leases?.workload &&
    a.leases?.sessions === b.leases?.sessions
  );
}

// The entry is committed synchronously at entry (before any await) so a
// concurrent call from another client sees it. A matching operation may join
// only when the caller would apply the same proof and admission policy.
//
// When ctx.leases is set for unload, beginDrain() fences before any HTTP call;
// the drain is visible synchronously to callers that have not awaited unload().
function singleFlightRun<T>(
  ctx: ClientCtx,
  op: "load" | "unload",
  busyResult: () => T,
  body: () => Promise<T>,
  exclusive = false,
): Promise<T> {
  const key = `${ctx.baseUrl}|${basename(ctx.hostedRel)}`;
  const existing = singleFlight.get(key);
  if (existing !== undefined) {
    if (
      !exclusive &&
      !existing.exclusive &&
      existing.op === op &&
      canShareNativeFlight(existing.ctx, ctx)
    ) {
      return existing.promise as Promise<T>;
    }
    return Promise.resolve(busyResult());
  }
  const promise = body();
  singleFlight.set(key, { op, promise, ctx, exclusive });
  return promise.finally(() => {
    singleFlight.delete(key);
  });
}

// --- public factory ---

export function createOmlxNativeClient(opts: OmlxNativeClientOptions): OmlxNativeClient {
  const ctx: ClientCtx = {
    baseUrl: buildBaseUrl(opts.endpoint.host, opts.endpoint.port),
    endpoint: Object.freeze({ ...opts.endpoint }),
    hostedRel: opts.hostedRel,
    binding:
      opts.binding === undefined
        ? undefined
        : Object.freeze({
            ...opts.binding,
            endpoint: Object.freeze({ ...opts.binding.endpoint }),
          }),
    activityObservable: opts.activityObservable,
    apiKey: opts.apiKey,
    readiness: opts.readiness,
    requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
    statusTimeoutMs: opts.statusTimeoutMs ?? 5_000,
    base: opts.fetch ?? globalThis.fetch,
    leases: opts.leases,
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
        () => runLoadWithLeases(ctx),
      );
    },
    ...(ctx.leases === undefined
      ? {}
      : {
          async unloadWithCommit(commit: OmlxNativeUnloadCommit): Promise<NativeUnloadResult> {
            return await singleFlightRun(
              ctx,
              "unload",
              () => ({ kind: "refused", reason: "OperationInProgress", reservation: "held" }),
              () => runUnloadWithLeases(ctx, commit),
              true,
            );
          },
          async loadWithCommit(commit: OmlxNativeLoadCommit): Promise<NativeLoadResult> {
            return await singleFlightRun(
              ctx,
              "load",
              () => ({ kind: "refused", reason: "OperationInProgress" }),
              () => runLoadWithLeases(ctx, commit),
              true,
            );
          },
        }),
    async unload(): Promise<NativeUnloadResult> {
      return await singleFlightRun(
        ctx,
        "unload",
        () => ({ kind: "refused", reason: "OperationInProgress", reservation: "held" }),
        () => runUnloadWithLeases(ctx),
      );
    },
  };
}

export type AgentOmlxNativeClientOptions = Omit<OmlxNativeClientOptions, "leases"> & {
  workload: string;
};

/**
 * Agent-side construction seam for #282. A native unload built through this
 * factory drains leases from the same ledger as proxy admission (openaiProxy
 * acquireProxyResidencyLease) and Worker RPC (serve.ts).
 *
 * The registry is captured once at construction, so unload's commitUnload and
 * load's reopen always hit one ledger even if the seam is cleared afterwards.
 * The session registry (#520) is captured the same way, next to the lease
 * registry, and sessions are fenced only when a lease registry is published:
 * a captured null session registry opts out.
 *
 * Callers MUST construct per operation, not once per process: a client built
 * before the registry was published is not fenced by it. That is a known
 * limitation, not a supported mode. This factory never writes the seam.
 *
 * With no published registry (LLAMACTL_RESIDENCY_LEASES unset) the result is
 * exactly createOmlxNativeClient without leases.
 */
export function createAgentOmlxNativeClient(opts: AgentOmlxNativeClientOptions): OmlxNativeClient {
  const registry = getResidencyLeaseRegistry();
  const { workload, ...rest } = opts;
  if (registry === null) {
    return createOmlxNativeClient(rest);
  }
  const sessions = currentSessionRefcounts();
  return createOmlxNativeClient({ ...rest, leases: { registry, workload, sessions } });
}
