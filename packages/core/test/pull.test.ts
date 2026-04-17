import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pickCandidateFile,
  pullCandidate,
  pullRepo,
  pullRepoFile,
  type PullEvent,
  type RunHf,
} from '../src/pull.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

describe('pull.pickCandidateFile', () => {
  test('returns the caller-supplied file without hitting HF', async () => {
    const result = await pickCandidateFile({
      repo: 'unsloth/demo-GGUF',
      file: 'demo-UD-Q4_K_XL.gguf',
      profile: 'balanced',
    });
    expect(result).toEqual({
      repo: 'unsloth/demo-GGUF',
      file: 'demo-UD-Q4_K_XL.gguf',
      source: 'requested',
      profile: 'balanced',
      eligible: ['demo-UD-Q4_K_XL.gguf'],
    });
  });

  test('normalises a profile alias', async () => {
    const result = await pickCandidateFile({
      repo: 'unsloth/demo',
      file: 'x.gguf',
      profile: 'mbp',
    });
    expect(result?.profile).toBe('macbook-pro-48g');
  });
});

describe('pull.pullRepo (injected runHf)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('defaults target to $LLAMA_CPP_MODELS/<repo-basename> and assembles argv', async () => {
    const captured: string[][] = [];
    const runHf: RunHf = async (args) => {
      captured.push(args);
      return 0;
    };
    const result = await pullRepo({ repo: 'unsloth/demo-GGUF', runHf });
    const expectedTarget = join(temp.modelsDir, 'demo-GGUF');
    expect(result.target).toBe(expectedTarget);
    expect(result.code).toBe(0);
    expect(captured).toEqual([['download', 'unsloth/demo-GGUF', '--local-dir', expectedTarget]]);
  });

  test('honours explicit targetDir', async () => {
    const override = join(temp.devStorage, 'custom');
    const runHf: RunHf = async () => 0;
    const result = await pullRepo({
      repo: 'unsloth/demo',
      targetDir: override,
      runHf,
    });
    expect(result.target).toBe(override);
  });

  test('propagates non-zero exit code', async () => {
    const runHf: RunHf = async () => 2;
    const result = await pullRepo({ repo: 'unsloth/demo', runHf });
    expect(result.code).toBe(2);
  });
});

describe('pull.pullRepoFile (injected runHf)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('wasMissing=true when target is absent; argv omits mmproj when skipMmproj', async () => {
    const captured: string[][] = [];
    const runHf: RunHf = async (args) => {
      captured.push(args);
      return 0;
    };
    const result = await pullRepoFile({
      repo: 'unsloth/demo-GGUF',
      file: 'demo-Q4.gguf',
      runHf,
      skipMmproj: true,
    });
    const target = join(temp.modelsDir, 'demo-GGUF');
    expect(result.rel).toBe('demo-GGUF/demo-Q4.gguf');
    expect(result.target).toBe(target);
    expect(result.wasMissing).toBe(true);
    expect(result.mmproj).toBeNull();
    expect(result.requestedFiles).toEqual(['demo-Q4.gguf']);
    expect(captured).toEqual([
      ['download', 'unsloth/demo-GGUF', 'demo-Q4.gguf', '--local-dir', target],
    ]);
  });

  test('wasMissing=false when file already lives under $LLAMA_CPP_MODELS', async () => {
    const target = join(temp.modelsDir, 'demo-GGUF');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'demo-Q4.gguf'), '');
    const runHf: RunHf = async () => 0;
    const result = await pullRepoFile({
      repo: 'unsloth/demo-GGUF',
      file: 'demo-Q4.gguf',
      runHf,
      skipMmproj: true,
    });
    expect(result.wasMissing).toBe(false);
  });

  test('respects caller-supplied rel-style file (contains /)', async () => {
    const runHf: RunHf = async () => 0;
    const result = await pullRepoFile({
      repo: 'unsloth/demo-GGUF',
      file: 'nested/demo-Q8.gguf',
      runHf,
      skipMmproj: true,
    });
    expect(result.rel).toBe('nested/demo-Q8.gguf');
    expect(result.requestedFiles).toEqual(['nested/demo-Q8.gguf']);
  });

  test('emits a start event before spawn', async () => {
    const events: PullEvent[] = [];
    const runHf: RunHf = async (_, onEvent) => {
      onEvent?.({ type: 'stderr', line: 'progress...' });
      onEvent?.({ type: 'exit', code: 0 });
      return 0;
    };
    await pullRepoFile({
      repo: 'unsloth/demo',
      file: 'demo.gguf',
      runHf,
      skipMmproj: true,
      onEvent: (e) => events.push(e),
    });
    expect(events[0]?.type).toBe('start');
    expect(events.some((e) => e.type === 'stderr' && e.line === 'progress...')).toBe(true);
  });
});

describe('pull.pullCandidate', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('error when HF is disabled and no file override is given', async () => {
    const runHf: RunHf = async () => 0;
    const result = await pullCandidate({ repo: 'unsloth/demo', runHf });
    expect(result).toEqual({ error: 'Unable to resolve a candidate file for unsloth/demo' });
  });

  test('short-circuits to pullRepoFile when caller supplies the file', async () => {
    const captured: string[][] = [];
    const runHf: RunHf = async (args) => {
      captured.push(args);
      return 0;
    };
    const result = await pullCandidate({
      repo: 'unsloth/demo-GGUF',
      file: 'demo-Q4.gguf',
      runHf,
      skipMmproj: true,
    });
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.picked.source).toBe('requested');
    expect(result.rel).toBe('demo-GGUF/demo-Q4.gguf');
    expect(captured).toHaveLength(1);
  });
});
