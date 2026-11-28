/**
 * #282 DF-09 — probe the pinned oMLX native residency contract
 * (OMLX_MODELS_STATUS_PATH at OMLX_NATIVE_STATUS_REVISION) once per process
 * per endpoint and credential, with a declared whole-process fallback when the
 * engine does not answer the native status path. The probe sends the same
 * bearer apiKey the native client would, so an authenticated engine is probed
 * as itself. Definitive outcomes (native, process-fallback) are cached; unknown
 * is never cached so a transient timeout or auth blip re-probes on the next
 * call. The cache key carries a one-way fingerprint of the apiKey (or "none"),
 * never the key itself. No native load or unload is issued unless the
 * capability resolved to native.
 */
import { OMLX_MODELS_STATUS_PATH, parseOmlxModelsStatus } from "@llamactl/core/engines";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { createHash } from "node:crypto";

import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type {
  AgentOmlxNativeClientOptions,
  NativeStatus,
  OmlxNativeClient,
  OmlxNativePin,
} from "./engine-client.js";

import {
  applyAuth,
  buildBaseUrl,
  classifyFetchError,
  createAgentOmlxNativeClient,
  nativeBindingCurrent,
} from "./engine-client.js";

export type OmlxNativeCapability =
  | { mode: "native"; reason: null; httpStatus: number }
  | { mode: "process-fallback"; reason: "NativeStatusUnsupported"; httpStatus: number }
  | {
      mode: "unknown";
      reason:
        | "Timeout"
        | "Unreachable"
        | "MalformedResponse"
        | "NotServingNode"
        | "NativeIdentityUnverified";
      httpStatus: null;
    }
  | { mode: "unknown"; reason: "Unauthorized" | "HttpError"; httpStatus: number };

export const OMLX_CAPABILITY_PROBE_TIMEOUT_MS = 2_000;

// Shorter bound for the status path: residencyStatus must stay responsive even
// while a host's capability is unknown (unknown is never cached, so it is
// re-probed every call).
export const OMLX_STATUS_PROBE_TIMEOUT_MS = 500;

export type OmlxNativeProbeOptions = {
  endpoint: { host: string; port: number };
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  // Bearer token sent as `Authorization: Bearer <apiKey>`; never logged and
  // never stored — the cache key holds only a sha256 fingerprint of it.
  apiKey?: string | undefined;
};

export type OmlxResidencyPathResolution =
  | { path: "native"; capability: OmlxNativeCapability; client: OmlxNativeClient }
  | { path: "process"; capability: OmlxNativeCapability }
  | {
      path: "held";
      capability: OmlxNativeCapability;
      reason:
        | "NativeIdentityUnverified"
        | "NativeCapabilityUnknown"
        | "NativeLeaseRegistryRequired";
    };

export type OmlxNativeStatusRow = {
  workload: string;
  endpoint: string;
  mode: OmlxNativeCapability["mode"];
  reason: string | null;
  httpStatus: number | null;
  modelState?: "discovered" | "loading" | "loaded" | "missing" | "unknown";
  servingState?: "resident" | "ready" | "busy";
};

export type ReadOwnedOmlxStatus = (
  workload: string,
  endpoint: { host: string; port: number },
  signal: AbortSignal,
) => Promise<NativeStatus | null | undefined>;

async function drainBody(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel().catch(() => undefined);
  }
}

function isModelsStatusBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Array.isArray((body as Record<string, unknown>)["models"])
  );
}

async function probeOnce(
  endpoint: { host: string; port: number },
  timeoutMs: number,
  base: typeof globalThis.fetch,
  apiKey: string | undefined,
  inventory?: {
    exact?: OmlxNativePin;
    observe?: (body: unknown) => void;
  },
): Promise<OmlxNativeCapability> {
  const url = `${buildBaseUrl(endpoint.host, endpoint.port)}${OMLX_MODELS_STATUS_PATH}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await base(url, applyAuth(apiKey, { method: "GET", signal, redirect: "error" }));
  } catch (err) {
    return { mode: "unknown", reason: classifyFetchError(signal, err), httpStatus: null };
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    await drainBody(response);
    return {
      mode: "process-fallback",
      reason: "NativeStatusUnsupported",
      httpStatus: response.status,
    };
  }
  if (response.status === 401 || response.status === 403) {
    await drainBody(response);
    return { mode: "unknown", reason: "Unauthorized", httpStatus: response.status };
  }
  if (!response.ok) {
    await drainBody(response);
    return { mode: "unknown", reason: "HttpError", httpStatus: response.status };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { mode: "unknown", reason: "MalformedResponse", httpStatus: null };
  }
  if (!isModelsStatusBody(body)) {
    return { mode: "unknown", reason: "MalformedResponse", httpStatus: null };
  }
  const exact = inventory?.exact;
  if (exact !== undefined && parseOmlxModelsStatus(body, exact.modelId, exact).state === "failed") {
    return unverifiedBinding().capability;
  }
  inventory?.observe?.(body);
  return { mode: "native", reason: null, httpStatus: 200 };
}

export async function probeOmlxNativeCapability(
  opts: OmlxNativeProbeOptions,
): Promise<OmlxNativeCapability> {
  const base = opts.fetch ?? globalThis.fetch;
  return await probeOnce(
    opts.endpoint,
    opts.timeoutMs ?? OMLX_CAPABILITY_PROBE_TIMEOUT_MS,
    base,
    opts.apiKey,
  );
}

const settled = new Map<string, OmlxNativeCapability>();
const inFlight = new Map<string, Promise<OmlxNativeCapability>>();

// A one-way fingerprint of the credential, so a probe made with one apiKey (or
// none) never answers for another; the key itself never enters the cache.
function credentialFingerprint(apiKey: string | undefined): string {
  if (apiKey === undefined) {
    return "none";
  }
  return `sha256:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

function capabilityCacheKey(opts: OmlxNativeProbeOptions): string {
  return `${buildBaseUrl(opts.endpoint.host, opts.endpoint.port)}#auth=${credentialFingerprint(opts.apiKey)}`;
}

export async function ensureOmlxNativeCapability(
  opts: OmlxNativeProbeOptions,
): Promise<OmlxNativeCapability> {
  const key = capabilityCacheKey(opts);
  const cached = settled.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = inFlight.get(key);
  if (pending !== undefined) {
    return await pending;
  }
  const promise = probeOmlxNativeCapability(opts);
  inFlight.set(key, promise);
  try {
    const capability = await promise;
    if (capability.mode !== "unknown") {
      settled.set(key, capability);
    }
    return capability;
  } finally {
    inFlight.delete(key);
  }
}

export function resetOmlxNativeCapabilityCache(): void {
  settled.clear();
  inFlight.clear();
}

/**
 * A wire capability is usable only while the trusted owner still proves the
 * pinned process. The status cache is for diagnostics, not action selection.
 */
export async function resolveOmlxResidencyPath(
  opts: AgentOmlxNativeClientOptions & { probeTimeoutMs?: number },
): Promise<OmlxResidencyPathResolution> {
  const { probeTimeoutMs, ...clientOpts } = opts;
  const binding =
    opts.binding === undefined
      ? undefined
      : Object.freeze({
          ...opts.binding,
          endpoint: Object.freeze({ ...opts.binding.endpoint }),
        });
  if (binding === undefined || !nativeBindingCurrent(binding, opts.endpoint))
    return unverifiedBinding();
  const capability = await probeOnce(
    opts.endpoint,
    probeTimeoutMs ?? OMLX_CAPABILITY_PROBE_TIMEOUT_MS,
    opts.fetch ?? globalThis.fetch,
    opts.apiKey,
    { exact: binding },
  );
  if (!nativeBindingCurrent(binding, opts.endpoint)) return unverifiedBinding();
  if (capability.mode === "unknown") {
    return capability.reason === "NativeIdentityUnverified"
      ? unverifiedBinding()
      : { path: "held", capability, reason: "NativeCapabilityUnknown" };
  }
  if (capability.mode === "process-fallback") return { path: "process", capability };
  if (getResidencyLeaseRegistry() === null) {
    return { path: "held", capability, reason: "NativeLeaseRegistryRequired" };
  }
  return {
    path: "native",
    capability,
    client: createAgentOmlxNativeClient({ ...clientOpts, binding }),
  };
}

function unverifiedBinding(): Extract<OmlxResidencyPathResolution, { path: "held" }> {
  return {
    path: "held",
    reason: "NativeIdentityUnverified",
    capability: { mode: "unknown", reason: "NativeIdentityUnverified", httpStatus: null },
  };
}

function rowFor(
  manifest: ModelHostManifest,
  capability: OmlxNativeCapability,
): OmlxNativeStatusRow {
  return {
    workload: manifest.metadata.name,
    endpoint: `${manifest.spec.endpoint.host}:${String(manifest.spec.endpoint.port)}`,
    mode: capability.mode,
    reason: capability.reason,
    httpStatus: capability.httpStatus,
  };
}

async function readNativeInventory(
  manifest: ModelHostManifest,
  timeoutMs: number,
): Promise<OmlxNativeStatusRow> {
  let modelState: NonNullable<OmlxNativeStatusRow["modelState"]> = "unknown";
  const hosted = manifest.spec.hostedModels[0];
  const capability = await probeOnce(
    manifest.spec.endpoint,
    timeoutMs,
    globalThis.fetch,
    undefined,
    {
      observe(body): void {
        if (hosted === undefined) return;
        const state = parseOmlxModelsStatus(body, hosted.rel);
        modelState =
          state.state !== "failed"
            ? state.state
            : state.reason === "ModelNotListed"
              ? "missing"
              : "unknown";
      },
    },
  );
  return { ...rowFor(manifest, capability), modelState };
}

function privateInventoryRow(
  manifest: ModelHostManifest,
  status: NativeStatus | null,
): OmlxNativeStatusRow {
  if (status === null || status.state === "unknown" || status.state === "failed") {
    return {
      workload: manifest.metadata.name,
      endpoint: `${manifest.spec.endpoint.host}:${String(manifest.spec.endpoint.port)}`,
      mode: "unknown",
      reason: status?.reason ?? "ManagedNativeOmlxOwnerUnavailable",
      httpStatus: status !== null && "httpStatus" in status ? status.httpStatus : null,
      modelState: status?.reason === "ModelNotListed" ? "missing" : "unknown",
    };
  }
  const ready = rowFor(manifest, { mode: "native", reason: null, httpStatus: 200 });
  return "activity" in status
    ? { ...ready, modelState: "loaded", servingState: status.state }
    : { ...ready, modelState: status.state };
}

async function readOmlxStatusRow(
  manifest: ModelHostManifest,
  opts: { timeoutMs: number; managed: boolean; readOwned?: ReadOwnedOmlxStatus | undefined },
): Promise<OmlxNativeStatusRow> {
  const status = await opts.readOwned?.(
    manifest.metadata.name,
    manifest.spec.endpoint,
    AbortSignal.timeout(opts.timeoutMs),
  );
  if (status !== undefined || manifest.spec.omlxNativeResidency !== undefined) {
    return privateInventoryRow(manifest, status ?? null);
  }
  if (opts.managed) return await readNativeInventory(manifest, opts.timeoutMs);
  const capability = await ensureOmlxNativeCapability({
    endpoint: manifest.spec.endpoint,
    timeoutMs: opts.timeoutMs,
  });
  return rowFor(manifest, capability);
}

export async function collectOmlxNativeStatus(opts: {
  node: string;
  servingNode: string | null;
  hosts: readonly ModelHostManifest[];
  timeoutMs?: number;
  ownsNode?: (node: string) => boolean;
  readOwned?: ReadOwnedOmlxStatus | undefined;
}): Promise<OmlxNativeStatusRow[]> {
  const hosts = opts.hosts.filter(
    (h) => h.spec.engine === "omlx" && (opts.ownsNode?.(h.spec.node) ?? h.spec.node === opts.node),
  );
  if (opts.servingNode !== opts.node) {
    const notServing: OmlxNativeCapability = {
      mode: "unknown",
      reason: "NotServingNode",
      httpStatus: null,
    };
    return hosts
      .map((h) => rowFor(h, notServing))
      .sort((a, b) => a.workload.localeCompare(b.workload));
  }
  const timeoutMs = opts.timeoutMs ?? OMLX_STATUS_PROBE_TIMEOUT_MS;
  const rows = await Promise.all(
    hosts.map((host) =>
      readOmlxStatusRow(host, {
        timeoutMs,
        managed: opts.ownsNode !== undefined,
        readOwned: opts.readOwned,
      }),
    ),
  );
  return rows.sort((a, b) => a.workload.localeCompare(b.workload));
}
