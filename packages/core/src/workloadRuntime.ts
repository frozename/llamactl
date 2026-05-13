import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
