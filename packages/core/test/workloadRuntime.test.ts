import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  workloadRuntimeDir,
  listLocalWorkloads,
  ensureWorkloadRuntimeDir,
  migrateLegacySingletonRuntime,
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

test('migrateLegacySingletonRuntime moves files under a matching workload dir', () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.runtimeDir, 'llama-server.pid'), '999999\n');
    writeFileSync(join(t.runtimeDir, 'llama-server.state'), JSON.stringify({
      rel: 'granite/granite-4.1-8b-Q4_K_M.gguf', extraArgs: ['--ctx-size', '4096'],
      host: '127.0.0.1', port: '8181', binary: '/x/llama-server',
      pid: 999999, startedAt: 't', tunedProfile: null,
    }));
    writeFileSync(join(t.runtimeDir, 'llama-server.log'), 'old log');

    const out = migrateLegacySingletonRuntime(t.resolved, [
      {
        metadata: { name: 'granite-8b' },
        spec: {
          node: 'local',
          target: { kind: 'rel', value: 'granite/granite-4.1-8b-Q4_K_M.gguf' },
          endpoint: { port: 8181 },
        },
      },
    ]);

    expect(out.kind).toBe('migrated');
    if (out.kind === 'migrated') expect(out.workload).toBe('granite-8b');

    const dest = join(t.runtimeDir, 'workloads', 'granite-8b');
    expect(existsSync(join(dest, 'llama-server.pid'))).toBe(true);
    expect(existsSync(join(dest, 'llama-server.state'))).toBe(true);
    expect(existsSync(join(dest, 'llama-server.log'))).toBe(true);
    expect(existsSync(join(t.runtimeDir, 'llama-server.pid'))).toBe(false);
    expect(existsSync(join(t.runtimeDir, '.migrated-v2'))).toBe(true);
  } finally { t.cleanup(); }
});

test('migrateLegacySingletonRuntime synthesizes an imperative workload when no manifest matches', () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.runtimeDir, 'llama-server.pid'), '999999\n');
    writeFileSync(join(t.runtimeDir, 'llama-server.state'), JSON.stringify({
      rel: 'orphan/orphan.gguf', extraArgs: [], host: '127.0.0.1', port: '9999',
      binary: '/x/llama-server', pid: 999999, startedAt: 't', tunedProfile: null,
    }));
    const out = migrateLegacySingletonRuntime(t.resolved, []);
    expect(out.kind).toBe('synthesized');
    if (out.kind === 'synthesized') expect(out.workload).toMatch(/^imperative-\d+$/);
  } finally { t.cleanup(); }
});

test('migrateLegacySingletonRuntime is a no-op on second invocation', () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.runtimeDir, '.migrated-v2'), '');
    writeFileSync(join(t.runtimeDir, 'llama-server.pid'), '1\n');
    const out = migrateLegacySingletonRuntime(t.resolved, []);
    expect(out.kind).toBe('skipped');
  } finally { t.cleanup(); }
});
