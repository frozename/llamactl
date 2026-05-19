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
    return parsed;
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
