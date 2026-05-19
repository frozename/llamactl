import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedEnv } from './types.js';
import { resolveEnv } from './env.js';
import { readModelHostState, modelhostPidFile } from './engines/state.js';
import { readServerState } from './server.js';
import type { EngineName } from './engines/index.js';

export interface WorkloadKey {
  name: string;
}

export interface WorkloadRuntimeEntry {
  name: string;
  pid: number | null;
  alive: boolean;
}

export interface LocalRoute {
  workload: string;
  model: string;
  host: string;
  port: number;
  engine: EngineName;
  kind: 'ModelRun' | 'ModelHost';
  pid: number;
}

export function workloadRuntimeRoot(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'workloads');
}

export function workloadRuntimeDir(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(workloadRuntimeRoot(resolved), key.name);
}

export function ensureWorkloadRuntimeDir(resolved: ResolvedEnv, key: WorkloadKey): string {
  const dir = workloadRuntimeDir(resolved, key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function listLocalWorkloads(resolved: ResolvedEnv = resolveEnv()): WorkloadRuntimeEntry[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const entries: WorkloadRuntimeEntry[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pidPath = join(root, dirent.name, 'llama-server.pid');
    const modelhostPidPath = join(root, dirent.name, 'modelhost.pid');
    const activePidPath = existsSync(pidPath) ? pidPath : modelhostPidPath;
    if (!existsSync(activePidPath)) continue;
    const pid = readPidFile(activePidPath);
    entries.push({ name: dirent.name, pid, alive: pid !== null && isProcessAlive(pid) });
  }
  return entries;
}

export function listLocalRoutes(resolved: ResolvedEnv = resolveEnv()): LocalRoute[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const out: LocalRoute[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const key = { name: dirent.name };

    const hostPid = readPidFile(modelhostPidFile(resolved, key));
    if (hostPid !== null && isProcessAlive(hostPid)) {
      const state = readModelHostState(key, resolved);
      if (state && state.pid === hostPid) {
        for (const alias of state.modelAliases) {
          out.push({
            workload: dirent.name,
            model: alias,
            host: state.host,
            port: state.port,
            engine: state.engine,
            kind: 'ModelHost',
            pid: hostPid,
          });
        }
        continue;
      }
    }

    const runPid = readPidFile(join(root, dirent.name, 'llama-server.pid'));
    if (runPid === null || !isProcessAlive(runPid)) continue;
    const state = readServerState(key, resolved);
    if (!state?.rel || !state.host || state.port == null) continue;
    out.push({
      workload: dirent.name,
      model: state.rel,
      host: state.host,
      port: Number(state.port),
      engine: 'llamacpp',
      kind: 'ModelRun',
      pid: runPid,
    });
  }
  return out;
}

export function listWorkloadDirs(resolved: ResolvedEnv = resolveEnv()): string[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (dirent.isDirectory()) out.push(dirent.name);
  }
  return out;
}

export type MigrationResult =
  | { kind: 'skipped' }
  | { kind: 'no-legacy' }
  | { kind: 'migrated'; workload: string }
  | { kind: 'synthesized'; workload: string };

interface MinimalManifestForMigration {
  metadata: { name: string };
  spec: {
    node: string;
    target: { kind: 'rel' | 'alias'; value: string };
    endpoint?: { host?: string; port?: number };
  };
}

export function migrateLegacySingletonRuntime(
  resolved: ResolvedEnv,
  manifests: MinimalManifestForMigration[],
): MigrationResult {
  const root = resolved.LOCAL_AI_RUNTIME_DIR;
  const flag = join(root, '.migrated-v2');
  if (existsSync(flag)) return { kind: 'skipped' };

  const legacyPid = join(root, 'llama-server.pid');
  const legacyState = join(root, 'llama-server.state');
  const legacyLog = join(root, 'llama-server.log');
  if (!existsSync(legacyPid) && !existsSync(legacyState)) {
    writeFileSync(flag, '');
    return { kind: 'no-legacy' };
  }

  let stateRel: string | null = null;
  let statePort: number | null = null;
  try {
    const raw = readFileSync(legacyState, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.rel === 'string') stateRel = parsed.rel;
    if (typeof parsed.port === 'string') statePort = Number.parseInt(parsed.port, 10);
    if (typeof parsed.port === 'number') statePort = parsed.port;
  } catch {}

  const match = manifests.find((manifest) =>
    manifest.spec.target.value === stateRel &&
    (manifest.spec.endpoint?.port === undefined || manifest.spec.endpoint.port === statePort),
  );

  const workloadName = match?.metadata.name ?? `imperative-${Date.now()}`;
  const destDir = ensureWorkloadRuntimeDir(resolved, { name: workloadName });

  const moveIfExists = (src: string, dstName: string) => {
    if (existsSync(src)) {
      try {
        renameSync(src, join(destDir, dstName));
      } catch {}
    }
  };
  moveIfExists(legacyPid, 'llama-server.pid');
  moveIfExists(legacyState, 'llama-server.state');
  moveIfExists(legacyLog, 'llama-server.log');

  writeFileSync(flag, '');
  return match ? { kind: 'migrated', workload: workloadName } : { kind: 'synthesized', workload: workloadName };
}
