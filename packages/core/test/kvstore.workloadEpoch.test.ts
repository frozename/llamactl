import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEnv } from '../src/env.js';
import {
  computeWorkloadEpoch,
  readWorkloadEpoch,
} from '../src/kvstore/index.js';
import {
  ensureWorkloadRuntimeDir,
  workloadRuntimeDir,
  type WorkloadKey,
} from '../src/workloadRuntime.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

test('computeWorkloadEpoch is deterministic for the same input', () => {
  const input = {
    startedAt: '2026-05-24T14:00:00.000Z',
    rel: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
  };
  const first = computeWorkloadEpoch(input);
  const second = computeWorkloadEpoch(input);
  expect(first).toBe(second);
});

test('computeWorkloadEpoch changes when input fields change', () => {
  const base = computeWorkloadEpoch({
    startedAt: '2026-05-24T14:00:00.000Z',
    rel: 'a.gguf',
  });
  const startedAtChanged = computeWorkloadEpoch({
    startedAt: '2026-05-24T14:00:01.000Z',
    rel: 'a.gguf',
  });
  const relChanged = computeWorkloadEpoch({
    startedAt: '2026-05-24T14:00:00.000Z',
    rel: 'b.gguf',
  });

  expect(startedAtChanged).not.toBe(base);
  expect(relChanged).not.toBe(base);
});

test('computeWorkloadEpoch returns a 40-char hex sha1', () => {
  const epoch = computeWorkloadEpoch({
    startedAt: '2026-05-24T14:00:00.000Z',
    rel: 'model.gguf',
  });
  expect(epoch).toMatch(/^[0-9a-f]{40}$/);
});

test('readWorkloadEpoch returns null when workload sidecars are missing', () => {
  const temp = makeTempRuntime();
  try {
    const resolved = resolveEnv(envForTemp(temp));
    const epoch = readWorkloadEpoch({ name: 'missing-workload' }, resolved);
    expect(epoch).toBeNull();
  } finally {
    temp.cleanup();
  }
});

test('readWorkloadEpoch returns computed epoch for ModelRun sidecars', () => {
  const temp = makeTempRuntime();
  try {
    const resolved = resolveEnv(envForTemp(temp));
    const key: WorkloadKey = { name: 'workload-a' };
    ensureWorkloadRuntimeDir(resolved, key);

    const runtimeDir = workloadRuntimeDir(resolved, key);
    const startedAt = '2026-05-24T15:30:00.000Z';
    const rel = 'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf';
    writeFileSync(join(runtimeDir, 'llama-server.pid'), `43210\n`);
    writeFileSync(
      join(runtimeDir, 'llama-server.state'),
      JSON.stringify({
        rel,
        extraArgs: [],
        host: '127.0.0.1',
        port: '8080',
        binary: '/tmp/llama-server',
        pid: 43210,
        startedAt,
        tunedProfile: null,
      }),
    );

    const epoch = readWorkloadEpoch(key, resolved);
    expect(epoch).toBe(computeWorkloadEpoch({ startedAt, rel }));
  } finally {
    temp.cleanup();
  }
});
