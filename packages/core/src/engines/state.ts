import { join } from "node:path";

import type { ResolvedEnv } from "../types.js";
import type { EngineName } from "./index.js";
import type { ModelHostReadiness } from "./types.js";

import { resolveEnv } from "../env.js";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "../safe-fs.js";
import {
  ensureWorkloadRuntimeDir,
  type WorkloadKey,
  workloadRuntimeDir,
} from "../workloadRuntime.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

export interface ModelHostState {
  kind: "ModelHost";
  engine: EngineName;
  pid: number;
  host: string;
  port: number;
  modelAliases: string[];
  startedAt: string;
  slotSavePath?: string | null;
  /**
   * Stable hash of the launch-affecting spec fields at the time the
   * sidecar was written. Used by the reconciler to detect spec drift
   * (manifest edited under a Running host) and trigger a restart.
   * Optional for back-compat with sidecars written before this field
   * existed; absent → reconciler treats spec as unknown and assumes
   * unchanged (no spurious restart on existing hosts).
   */
  specHash?: string;
  // #516: argv0 basenames this host's process may run under; replaces the
  // engine default in pid-identity checks. Written from spec.binaryNames.
  binaryNames?: string[];
  /** Declared serving probe (#220); absent = legacy behaviour. */
  readiness?: ModelHostReadiness;
}

/**
 * Compute a stable hash of the launch-affecting fields of a ModelHost
 * spec. JSON.stringify is deterministic for the shapes we use (no
 * undefined values in the spec subtree after Zod parse). Consumers
 * compare hashes — they should never inspect the contents.
 */
export function computeModelHostSpecHash(spec: {
  engine: EngineName;
  binary: string;
  endpoint: { host: string; port: number };
  hostedModels: readonly unknown[];
  extraArgs: readonly string[];
  resources?: { expectedMemoryGiB?: number } | undefined;
  restartPolicy: string;
  timeoutSeconds: number;
  env?: Record<string, string> | undefined;
}): string {
  return JSON.stringify({
    engine: spec.engine,
    binary: spec.binary,
    endpoint: spec.endpoint,
    hostedModels: spec.hostedModels,
    extraArgs: spec.extraArgs,
    resources: spec.resources ?? null,
    restartPolicy: spec.restartPolicy,
    timeoutSeconds: spec.timeoutSeconds,
    env: spec.env ?? null,
  });
}

export function modelhostPidFile(resolved: ResolvedEnv = resolveEnv(), key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), "modelhost.pid");
}

export function modelhostStateFile(resolved: ResolvedEnv = resolveEnv(), key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), "modelhost.state");
}

// #317: the state sidecar only exists once the engine is ready, so an agent
// that dies mid-launch loses every track of the child. The starting record is
// written at spawn time (pid + identity fields the pid-file convention uses)
// and removed on readiness or clean teardown; its mtime is the pid-identity
// anchor for a restarted agent to reap the orphan.
export interface ModelHostStartingState {
  kind: "ModelHostStarting";
  engine: EngineName;
  pid: number;
  startedAt: string;
  specHash?: string;
  // #516: argv0 basenames this host's process may run under; replaces the
  // engine default in pid-identity checks. Written from spec.binaryNames.
  binaryNames?: string[];
}

export function modelhostStartingFile(
  resolved: ResolvedEnv = resolveEnv(),
  key: WorkloadKey,
): string {
  return join(workloadRuntimeDir(resolved, key), "modelhost.starting");
}

export function writeModelHostStarting(
  state: ModelHostStartingState,
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  ensureWorkloadRuntimeDir(resolved, key);
  writeFileSync(modelhostStartingFile(resolved, key), JSON.stringify(state, null, 2));
}

function isModelHostEngine(engine: unknown): engine is EngineName {
  return (
    engine === "llamacpp" ||
    engine === "omlx" ||
    engine === "strata" ||
    engine === "kapitsa" ||
    engine === "libosmos"
  );
}

function validBinaryNames(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every(
    (entry) => typeof entry === "string" && entry.length > 0 && !/[\s/\\]/.test(entry),
  );
}

function validateModelHostStarting(
  parsed: Partial<ModelHostStartingState>,
): ModelHostStartingState | null {
  if (parsed.kind !== "ModelHostStarting") return null;
  const { engine, pid, startedAt, specHash, binaryNames } = parsed;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (!isModelHostEngine(engine)) return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  return {
    kind: "ModelHostStarting",
    engine,
    pid,
    startedAt,
    ...(typeof specHash === "string" ? { specHash } : {}),
    ...(validBinaryNames(binaryNames) ? { binaryNames: [...binaryNames] } : {}),
  };
}

export function readModelHostStarting(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): ModelHostStartingState | null {
  const path = modelhostStartingFile(resolved, key);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return validateModelHostStarting(JSON.parse(raw) as Partial<ModelHostStartingState>);
  } catch {
    return null;
  }
}

export function removeModelHostStarting(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  try {
    unlinkSync(modelhostStartingFile(resolved, key));
  } catch {
    // Best-effort cleanup; failures are not actionable here.
  }
}

export function writeModelHostState(
  state: ModelHostState,
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  ensureWorkloadRuntimeDir(resolved, key);
  writeFileSync(modelhostPidFile(resolved, key), `${String(state.pid)}\n`);
  writeFileSync(modelhostStateFile(resolved, key), JSON.stringify(state, null, 2));
}

function validReadiness(readiness: unknown): readiness is ModelHostReadiness {
  if (
    typeof readiness !== "object" ||
    readiness === null ||
    Object.getPrototypeOf(readiness) !== Object.prototype
  ) {
    return false;
  }
  const record = readiness as Record<string, unknown>;
  if (typeof record["path"] !== "string" || !record["path"].startsWith("/")) return false;
  const expectStatus = record["expectStatus"];
  if (
    expectStatus !== undefined &&
    (typeof expectStatus !== "number" || !Number.isInteger(expectStatus))
  ) {
    return false;
  }
  const expectJson = record["expectJson"];
  return expectJson === undefined || validReadinessExpectJson(expectJson);
}

function validReadinessExpectJson(expectJson: unknown): boolean {
  if (
    typeof expectJson !== "object" ||
    expectJson === null ||
    Array.isArray(expectJson) ||
    Object.getPrototypeOf(expectJson) !== Object.prototype
  ) {
    return false;
  }
  return Object.values(expectJson as Record<string, unknown>).every(
    (value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
}

function validModelAliases(modelAliases: unknown): modelAliases is string[] {
  if (!Array.isArray(modelAliases) || modelAliases.length === 0) return false;
  return !modelAliases.some(
    (alias) => typeof alias !== "string" || alias.length === 0 || /[\t\r\n]/.test(alias),
  );
}

function validateModelHostState(parsed: Partial<ModelHostState>): ModelHostState | null {
  if (parsed.kind !== "ModelHost") return null;
  const { engine, host, modelAliases, pid, port, startedAt, binaryNames } = parsed;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!isModelHostEngine(engine)) return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  if (!validModelAliases(modelAliases)) return null;
  return {
    kind: "ModelHost",
    engine,
    pid,
    host,
    port,
    modelAliases,
    startedAt,
    slotSavePath: typeof parsed.slotSavePath === "string" ? parsed.slotSavePath : null,
    ...(typeof parsed.specHash === "string" ? { specHash: parsed.specHash } : {}),
    ...(validBinaryNames(binaryNames) ? { binaryNames: [...binaryNames] } : {}),
    ...(validReadiness(parsed.readiness) ? { readiness: parsed.readiness } : {}),
  };
}

export function readModelHostState(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): ModelHostState | null {
  const path = modelhostStateFile(resolved, key);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return validateModelHostState(JSON.parse(raw) as Partial<ModelHostState>);
  } catch {
    return null;
  }
}

export function removeModelHostState(key: WorkloadKey, resolved: ResolvedEnv = resolveEnv()): void {
  for (const path of [modelhostPidFile(resolved, key), modelhostStateFile(resolved, key)]) {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup; failures are not actionable here.
    }
  }
}

export function modelhostStartAttemptFile(
  resolved: ResolvedEnv = resolveEnv(),
  key: WorkloadKey,
): string {
  return join(workloadRuntimeDir(resolved, key), "modelhost.start-attempt");
}

export function writeModelHostStartAttempt(
  key: WorkloadKey,
  specHash: string,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  ensureWorkloadRuntimeDir(resolved, key);
  writeFileSync(
    modelhostStartAttemptFile(resolved, key),
    JSON.stringify({ specHash, attemptedAt: new Date().toISOString() }, null, 2),
  );
}

export function readModelHostStartAttempt(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): string | null {
  const path = modelhostStartAttemptFile(resolved, key);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { specHash?: string };
    return typeof parsed.specHash === "string" ? parsed.specHash : null;
  } catch {
    return null;
  }
}

export function removeModelHostStartAttempt(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  try {
    unlinkSync(modelhostStartAttemptFile(resolved, key));
  } catch {
    // Best-effort cleanup; failures are not actionable here.
  }
}
