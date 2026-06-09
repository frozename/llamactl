import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEnv } from '../env.js';
import type { ResolvedEnv } from '../types.js';
import { ensureWorkloadRuntimeDir, workloadRuntimeDir, type WorkloadKey } from '../workloadRuntime.js';
import type { EngineName } from './index.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

export interface ModelHostState {
  kind: 'ModelHost';
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
  hostedModels: ReadonlyArray<unknown>;
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
  return join(workloadRuntimeDir(resolved, key), 'modelhost.pid');
}

export function modelhostStateFile(resolved: ResolvedEnv = resolveEnv(), key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), 'modelhost.state');
}

export function writeModelHostState(
  state: ModelHostState,
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  ensureWorkloadRuntimeDir(resolved, key);
  writeFileSync(modelhostPidFile(resolved, key), `${state.pid}\n`);
  writeFileSync(modelhostStateFile(resolved, key), JSON.stringify(state, null, 2));
}

export function readModelHostState(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): ModelHostState | null {
  const path = modelhostStateFile(resolved, key);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as ModelHostState;
    if (parsed?.kind !== 'ModelHost') return null;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.host !== 'string' || !LOOPBACK_HOSTS.has(parsed.host)) return null;
    if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) return null;
    if (parsed.engine !== 'llamacpp' && parsed.engine !== 'omlx') return null;
    if (typeof parsed.startedAt !== 'string' || Number.isNaN(Date.parse(parsed.startedAt))) return null;
    if (!Array.isArray(parsed.modelAliases) || parsed.modelAliases.length === 0) return null;
    if (
      parsed.modelAliases.some(
        (alias) =>
          typeof alias !== 'string' ||
          alias.length === 0 ||
          /[\t\r\n]/.test(alias),
      )
    ) return null;
    return {
      ...parsed,
      slotSavePath: typeof parsed.slotSavePath === 'string' ? parsed.slotSavePath : null,
    };
  } catch {
    return null;
  }
}

export function removeModelHostState(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  for (const path of [modelhostPidFile(resolved, key), modelhostStateFile(resolved, key)]) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
