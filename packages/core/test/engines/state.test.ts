import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  modelhostStateFile,
  readModelHostState,
  removeModelHostState,
  writeModelHostState,
  type ModelHostState,
} from '../../src/engines/state.js';
import type { ResolvedEnv } from '../../src/types.js';

const KEY = { name: 'mlx-host-test' };

let tmp: string;
let env: ResolvedEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-state-'));
  env = { LOCAL_AI_RUNTIME_DIR: tmp } as ResolvedEnv;
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe('engines/state', () => {
  test('roundtrips a ModelHostState through write + read', () => {
    const state: ModelHostState = {
      kind: 'ModelHost',
      engine: 'omlx',
      pid: 4242,
      host: '127.0.0.1',
      port: 8094,
      modelAliases: ['mlx-community/Qwen3-8B-MLX-4bit', 'Qwen3-8B-MLX-4bit'],
      startedAt: '2026-05-19T00:00:00Z',
    };
    writeModelHostState(state, KEY, env);
    expect(readModelHostState(KEY, env)).toEqual(state);
  });

  test('returns null when no state file exists', () => {
    expect(readModelHostState(KEY, env)).toBeNull();
  });

  test('returns null on a corrupt state file', () => {
    const state: ModelHostState = {
      kind: 'ModelHost',
      engine: 'omlx',
      pid: 1,
      host: 'h',
      port: 1,
      modelAliases: [],
      startedAt: 't',
    };
    writeModelHostState(state, KEY, env);
    writeFileSync(modelhostStateFile(env, KEY), 'not json');
    expect(readModelHostState(KEY, env)).toBeNull();
  });

  test('removeModelHostState clears both pid + state files', () => {
    const state: ModelHostState = {
      kind: 'ModelHost',
      engine: 'omlx',
      pid: 1,
      host: 'h',
      port: 1,
      modelAliases: [],
      startedAt: 't',
    };
    writeModelHostState(state, KEY, env);
    expect(readModelHostState(KEY, env)).not.toBeNull();
    removeModelHostState(KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();
  });
});
