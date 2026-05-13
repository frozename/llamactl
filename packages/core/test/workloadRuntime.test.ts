import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  workloadRuntimeDir,
  listLocalWorkloads,
  ensureWorkloadRuntimeDir,
} from '../src/workloadRuntime.js';

const tempEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), 'workloadrt-'));
  return {
    runtimeDir: dir,
    resolved: { LOCAL_AI_RUNTIME_DIR: dir } as any,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test('workloadRuntimeDir composes the expected path', () => {
  const t = tempEnv();
  try {
    expect(workloadRuntimeDir(t.resolved, { name: 'gemma' })).toBe(
      join(t.runtimeDir, 'workloads', 'gemma'),
    );
  } finally { t.cleanup(); }
});

test('ensureWorkloadRuntimeDir creates the directory', () => {
  const t = tempEnv();
  try {
    const d = ensureWorkloadRuntimeDir(t.resolved, { name: 'gemma' });
    expect(existsSync(d)).toBe(true);
  } finally { t.cleanup(); }
});

test('listLocalWorkloads returns names of workload subdirs with pidfiles', () => {
  const t = tempEnv();
  try {
    const a = join(t.runtimeDir, 'workloads', 'a');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, 'llama-server.pid'), '99999\n');
    mkdirSync(join(t.runtimeDir, 'workloads', 'b'), { recursive: true });
    const entries = listLocalWorkloads(t.resolved);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['a']);
    expect(entries[0]!.pid).toBe(99999);
    expect(entries[0]!.alive).toBe(false);
  } finally { t.cleanup(); }
});
