import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedEnv } from './types.js';
import { resolveEnv } from './env.js';

export interface WorkloadKey {
  name: string;
}

export interface WorkloadRuntimeEntry {
  name: string;
  pid: number | null;
  alive: boolean;
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

export function listLocalWorkloads(resolved: ResolvedEnv = resolveEnv()): WorkloadRuntimeEntry[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const entries: WorkloadRuntimeEntry[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pidPath = join(root, dirent.name, 'llama-server.pid');
    if (!existsSync(pidPath)) continue;
    let pid: number | null = null;
    try {
      const raw = readFileSync(pidPath, 'utf8').trim();
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) pid = n;
    } catch { pid = null; }
    entries.push({ name: dirent.name, pid, alive: pid !== null && isProcessAlive(pid) });
  }
  return entries;
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
