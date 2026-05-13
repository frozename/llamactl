import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveWorkloadName } from '../src/commands/_workload-resolve.js';

const tempEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), 'workload-resolve-'));
  return {
    runtimeDir: dir,
    resolved: { LOCAL_AI_RUNTIME_DIR: dir } as any,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

let current: ReturnType<typeof tempEnv> | null = null;

afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('resolveWorkloadName', () => {
  test('falls back to known workload dirs after stop removes pidfiles', () => {
    current = tempEnv();
    const { runtimeDir, resolved } = current;
    mkdirSync(join(runtimeDir, 'workloads', 'solo'), { recursive: true });
    expect(resolveWorkloadName(undefined, resolved)).toBe('solo');
  });

  test('synthesizes when no workloads exist and requested', () => {
    current = tempEnv();
    const { resolved } = current;
    expect(resolveWorkloadName(undefined, resolved, { synthesizeIfEmpty: true })).toMatch(
      /^imperative-\d+$/,
    );
  });

  test('reports multiple known workloads without pidfiles', () => {
    current = tempEnv();
    const { runtimeDir, resolved } = current;
    mkdirSync(join(runtimeDir, 'workloads', 'a'), { recursive: true });
    mkdirSync(join(runtimeDir, 'workloads', 'b'), { recursive: true });
    expect(() => resolveWorkloadName(undefined, resolved)).toThrow(
      'multiple workloads on this node (a, b); pass --name <workload>',
    );
  });

  test('keeps live workload precedence when pidfiles are present', () => {
    current = tempEnv();
    const { runtimeDir, resolved } = current;
    const a = join(runtimeDir, 'workloads', 'a');
    const b = join(runtimeDir, 'workloads', 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'llama-server.pid'), '123\n');
    expect(resolveWorkloadName(undefined, resolved)).toBe('a');
  });
});
