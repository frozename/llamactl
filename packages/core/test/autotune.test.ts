import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoTuneEnabled, autoVisionBenchEnabled, maybeTuneAfterPull } from '../src/autotune.js';
import type { RunCli } from '../src/bench/runner.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

describe('autotune env flags', () => {
  test('autoTuneEnabled defaults to true, respects off-style values', () => {
    expect(autoTuneEnabled({})).toBe(true);
    expect(autoTuneEnabled({ LLAMA_CPP_AUTO_TUNE_ON_PULL: 'true' })).toBe(true);
    for (const raw of ['0', 'false', 'FALSE', 'no', 'NO', 'off', 'OFF']) {
      expect(autoTuneEnabled({ LLAMA_CPP_AUTO_TUNE_ON_PULL: raw })).toBe(false);
    }
  });
  test('autoVisionBenchEnabled defaults to true and follows the same rules', () => {
    expect(autoVisionBenchEnabled({})).toBe(true);
    expect(autoVisionBenchEnabled({ LLAMA_CPP_AUTO_BENCH_VISION: 'off' })).toBe(false);
  });
});

describe('maybeTuneAfterPull', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;
  const rel = 'Demo/demo.gguf';

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    // Stand up a fake llama-bench binary so the binary existence check
    // passes deterministically.
    const binDir = join(temp.devStorage, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'llama-bench'), '');
    process.env.LLAMA_CPP_BIN = binDir;
    // And the model file so benchPreset's existence check passes.
    const modelDir = join(temp.modelsDir, 'Demo');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'demo.gguf'), '');
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('skip when the file was already present', async () => {
    const runCli: RunCli = async () => ({ code: 0, stdout: '', stderr: '' });
    const report = await maybeTuneAfterPull({ rel, wasMissing: false, runCli });
    expect(report.preset.ran).toBe(false);
    if (!report.preset.ran) expect(report.preset.reason.kind).toBe('not-missing');
  });

  test('skip when auto-tune env flag is disabled', async () => {
    process.env.LLAMA_CPP_AUTO_TUNE_ON_PULL = 'off';
    const runCli: RunCli = async () => ({ code: 0, stdout: '', stderr: '' });
    const report = await maybeTuneAfterPull({ rel, wasMissing: true, runCli });
    if (!report.preset.ran) {
      expect(report.preset.reason.kind).toBe('auto-tune-disabled');
    } else {
      throw new Error('preset should not have run');
    }
  });

  test('skip when llama-bench binary is missing', async () => {
    process.env.LLAMA_CPP_BIN = join(temp.devStorage, 'nonexistent-bin');
    const runCli: RunCli = async () => ({ code: 0, stdout: '', stderr: '' });
    const report = await maybeTuneAfterPull({ rel, wasMissing: true, runCli });
    if (!report.preset.ran) {
      expect(report.preset.reason.kind).toBe('bench-binary-missing');
    } else {
      throw new Error('preset should not have run');
    }
  });

  test('runs benchPreset and records the profile when all conditions hold', async () => {
    let calls = 0;
    const runCli: RunCli = async () => {
      calls += 1;
      return {
        code: 0,
        stdout: JSON.stringify({ n_gen: 64, n_prompt: 0, avg_ts: 25.0 }),
        stderr: '',
      };
    };
    const report = await maybeTuneAfterPull({ rel, wasMissing: true, runCli });
    expect(calls).toBe(3); // one per profile
    expect(report.preset.ran).toBe(true);
    if (report.preset.ran) {
      expect(report.preset.result.gen_ts).toBe('25');
    }
  });
});
