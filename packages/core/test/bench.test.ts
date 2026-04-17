import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  findLatestProfile,
  findLatestVision,
  findLegacyProfile,
  readBenchHistory,
  readBenchProfiles,
  readBenchVision,
  serverProfileArgs,
  benchProfileArgs,
  defaultModeForRel,
} from '../src/bench/index.js';
import { resolveEnv } from '../src/env.js';
import { FIXTURE_DIR } from './helpers.js';

describe('bench.readBenchProfiles', () => {
  const rows = readBenchProfiles(join(FIXTURE_DIR, 'bench-profiles.tsv'));

  test('splits current + legacy rows by field count', () => {
    expect(rows.current.length).toBe(2);
    expect(rows.legacy.length).toBe(1);
  });
  test('preserves raw numeric strings (including trailing zeros)', () => {
    const row = rows.current[0];
    expect(row).toBeDefined();
    expect(row?.gen_ts).toBe('42.632656');
    expect(row?.prompt_ts).toBe('715.181562');
  });
  test('findLatestProfile matches the full key', () => {
    const match = findLatestProfile(rows, {
      machine: 'macbook-pro-48g',
      rel: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
      mode: 'text',
      ctx: '65536',
      build: '82764d8f4',
    });
    expect(match?.profile).toBe('default');
    expect(match?.gen_ts).toBe('42.632656');
  });
  test('findLegacyProfile matches rel-only rows', () => {
    const legacy = findLegacyProfile(
      rows,
      'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
    );
    expect(legacy?.profile).toBe('throughput');
  });
});

describe('bench.readBenchHistory', () => {
  const rows = readBenchHistory(join(FIXTURE_DIR, 'bench-history.tsv'));
  test('splits current and 6-column legacy rows', () => {
    expect(rows.current.length).toBe(2);
    expect(rows.legacy.length).toBe(1);
  });
});

describe('bench.readBenchVision + findLatestVision', () => {
  const rows = readBenchVision(join(FIXTURE_DIR, 'bench-vision.tsv'));
  test('parses one vision row', () => {
    expect(rows.length).toBe(1);
    expect(rows[0]?.load_ms).toBe('1167.15');
  });
  test('findLatestVision matches (machine, rel, build)', () => {
    const match = findLatestVision(rows, {
      machine: 'macbook-pro-48g',
      rel: 'Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf',
      build: '82764d8f4',
    });
    expect(match?.gen_tps).toBe('50.79');
  });
});

describe('bench.serverProfileArgs / benchProfileArgs', () => {
  test('named profile maps to flag shape', () => {
    expect(serverProfileArgs('default')).toBe('-fa on -b 2048 -ub 512');
    expect(serverProfileArgs('throughput')).toBe('-fa on -b 4096 -ub 1024');
    expect(serverProfileArgs('conservative')).toBe('-fa off -b 1024 -ub 256');
    expect(benchProfileArgs('default')).toBe('-fa 1 -b 2048 -ub 512');
    expect(benchProfileArgs('throughput')).toBe('-fa 1 -b 4096 -ub 1024');
  });
  test('unknown profile falls back to default', () => {
    expect(serverProfileArgs('bogus')).toBe('-fa on -b 2048 -ub 512');
  });
});

describe('bench.defaultModeForRel', () => {
  const env = resolveEnv({
    DEV_STORAGE: '/tmp/ds',
    LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    LOCAL_AI_RECOMMENDATIONS_SOURCE: 'off',
  } as NodeJS.ProcessEnv);

  test('Qwen 3.5 27B locked to text', () => {
    expect(
      defaultModeForRel('Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf', env),
    ).toBe('text');
  });
  test('catalog multimodal (Gemma 4) -> vision', () => {
    expect(
      defaultModeForRel('gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf', env),
    ).toBe('vision');
  });
  test('unknown -> text', () => {
    expect(defaultModeForRel('foo/bar.gguf', env)).toBe('text');
  });
});
