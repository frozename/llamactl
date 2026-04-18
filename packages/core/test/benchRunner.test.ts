import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  benchPreset,
  benchVision,
  formatBenchTimestamp,
  parseBenchJsonlStats,
  parseMtmdCliStats,
  resolveReferenceImage,
  writeBenchProfile,
  writeBenchVision,
  type RunCli,
} from '../src/bench/runner.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

describe('bench.parseBenchJsonlStats', () => {
  test('first gen row + first prompt-only row', () => {
    const output = [
      JSON.stringify({ n_gen: 0, n_prompt: 512, avg_ts: 1234.5 }),
      JSON.stringify({ n_gen: 64, n_prompt: 256, avg_ts: 42.1 }),
      JSON.stringify({ n_gen: 128, n_prompt: 0, avg_ts: 99.9 }),
    ].join('\n');
    expect(parseBenchJsonlStats(output)).toEqual({ gen_ts: '42.1', prompt_ts: '1234.5' });
  });
  test('missing metrics report -1', () => {
    expect(parseBenchJsonlStats('')).toEqual({ gen_ts: '-1', prompt_ts: '-1' });
  });
  test('ignores malformed lines', () => {
    const output = [
      'not-json',
      JSON.stringify({ n_gen: 16, avg_ts: 7.2 }),
    ].join('\n');
    expect(parseBenchJsonlStats(output)).toEqual({ gen_ts: '7.2', prompt_ts: '-1' });
  });
});

describe('bench.parseMtmdCliStats', () => {
  test('extracts all four metrics from mtmd-cli stderr', () => {
    const stderr = [
      'llama-mtmd-cli: load time =  1234.56 ms',
      'llama-mtmd-cli: image slice encoded in 789.0 ms',
      'llama-mtmd-cli: prompt eval time =  50.25 ms per token (  55.5 tokens per second)',
      'llama-mtmd-cli: eval time =  100.0 ms per token (   10.2 tokens per second)',
    ].join('\n');
    const r = parseMtmdCliStats(stderr);
    expect(r.load_ms).toBe('1234.56');
    expect(r.image_encode_ms).toBe('789.0');
    expect(r.prompt_tps).toBe('55.5');
    expect(r.gen_tps).toBe('10.2');
  });
  test('defaults to zeros when metrics are absent', () => {
    expect(parseMtmdCliStats('')).toEqual({
      load_ms: '0',
      image_encode_ms: '0',
      prompt_tps: '',
      gen_tps: '',
    });
  });
});

describe('bench.formatBenchTimestamp', () => {
  test('pads fields and includes a numeric offset', () => {
    const d = new Date('2026-04-17T12:34:56-03:00');
    const s = formatBenchTimestamp(d);
    // Local-time representation varies per env; just check shape.
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/);
  });
});

describe('bench writers (integration)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('writeBenchProfile upserts the tuned row and appends history', () => {
    const row = {
      machine: 'macbook-pro-48g',
      rel: 'Demo/demo.gguf',
      mode: 'text' as const,
      ctx: '32768',
      build: 'abc1234',
      profile: 'throughput',
      gen_ts: '42.0',
      prompt_ts: '1234.5',
    };
    writeBenchProfile(row);
    writeBenchProfile({ ...row, profile: 'default', gen_ts: '43.0', prompt_ts: '1240.0' });

    const profileBody = readFileSync(join(temp.runtimeDir, 'llama-bench-profiles.tsv'), 'utf8');
    const profileLines = profileBody.trim().split('\n');
    expect(profileLines.length).toBe(1);
    expect(profileLines[0]).toMatch(/\tdefault\t43.0\t/);

    const historyBody = readFileSync(join(temp.runtimeDir, 'llama-bench-history.tsv'), 'utf8');
    expect(historyBody.trim().split('\n').length).toBe(2);
  });

  test('writeBenchVision keys on (machine, rel, build)', () => {
    const row = {
      machine: 'macbook-pro-48g',
      rel: 'Vision/demo.gguf',
      ctx: '16384',
      build: 'abc1234',
      load_ms: '100',
      image_encode_ms: '50',
      prompt_tps: '123.4',
      gen_tps: '10.5',
    };
    writeBenchVision(row);
    writeBenchVision({ ...row, gen_tps: '11.0' });
    writeBenchVision({ ...row, build: 'def5678', gen_tps: '12.0' });

    const body = readFileSync(join(temp.runtimeDir, 'bench-vision.tsv'), 'utf8');
    const lines = body.trim().split('\n');
    expect(lines.length).toBe(2); // first upserted, second is new build
    const gens = lines.map((l) => l.split('\t')[7]);
    expect(gens).toEqual(['11.0', '12.0']);
  });

  test('resolveReferenceImage materialises a 1×1 PNG when no override exists', () => {
    const path = resolveReferenceImage();
    const buf = readFileSync(path);
    expect(buf.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  test('resolveReferenceImage honours LOCAL_AI_BENCH_IMAGE when the path exists', () => {
    const alt = join(temp.devStorage, 'alt.png');
    writeFileSync(alt, Buffer.from('not-a-png'));
    process.env.LOCAL_AI_BENCH_IMAGE = alt;
    expect(resolveReferenceImage()).toBe(alt);
    delete process.env.LOCAL_AI_BENCH_IMAGE;
  });
});

describe('bench.benchPreset (with injected runCli)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;
  const rel = 'Demo/demo.gguf';

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    // Create the rel + a stand-in llama-bench binary so the existence
    // checks pass without actually running anything.
    const modelDir = join(temp.modelsDir, 'Demo');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'demo.gguf'), '');
    const binDir = join(temp.devStorage, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'llama-bench'), '');
    process.env.LLAMA_CPP_BIN = binDir;
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('picks the profile with the highest gen_ts and writes the tuned row', async () => {
    const scripted: Record<string, string> = {
      default: JSON.stringify({ n_gen: 64, n_prompt: 0, avg_ts: 20.0 }),
      throughput: JSON.stringify({ n_gen: 64, n_prompt: 0, avg_ts: 30.0 }),
      conservative: JSON.stringify({ n_gen: 64, n_prompt: 0, avg_ts: 15.0 }),
    };
    const runCli: RunCli = async (_bin, args) => {
      const joined = args.join(' ');
      const key = joined.includes('-fa 1 -b 4096')
        ? 'throughput'
        : joined.includes('-fa 0')
          ? 'conservative'
          : 'default';
      return { code: 0, stdout: scripted[key] ?? '', stderr: '' };
    };
    const result = await benchPreset({ target: rel, mode: 'text', runCli });
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.bestProfile).toBe('throughput');
    expect(result.gen_ts).toBe('30');
    expect(result.attempts.length).toBe(3);

    const body = readFileSync(join(temp.runtimeDir, 'llama-bench-profiles.tsv'), 'utf8');
    expect(body).toContain('\tthroughput\t');
  });

  test('returns an error when every profile fails', async () => {
    const runCli: RunCli = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    const result = await benchPreset({ target: rel, mode: 'text', runCli });
    expect('error' in result).toBe(true);
  });
});

describe('bench.benchVision (error shapes without a real binary)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    // Force LLAMA_CPP_BIN at an empty temp dir so the bin existence
    // check fires deterministically regardless of the developer's real
    // llama.cpp install.
    process.env.LLAMA_CPP_BIN = join(temp.devStorage, 'nonexistent-bin');
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('errors when the mtmd-cli binary is missing', async () => {
    const result = await benchVision({ target: 'Demo/demo.gguf' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('llama-mtmd-cli binary not found');
    }
  });
});
