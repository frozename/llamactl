import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEnv } from '../env.js';
import type { ResolvedEnv } from '../types.js';
import { ensureWorkloadRuntimeDir, workloadRuntimeDir, type WorkloadKey } from '../workloadRuntime.js';
import type { EngineName } from './index.js';

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
    if (typeof parsed.pid !== 'number') return null;
    if (typeof parsed.host !== 'string') return null;
    if (typeof parsed.port !== 'number') return null;
    if (!Array.isArray(parsed.modelAliases)) return null;
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
