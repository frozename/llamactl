import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uninstall } from '../src/uninstall.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

describe('uninstall (integration)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;
  let customFile: string;
  let overridesFile: string;
  let benchProfileFile: string;
  let benchHistoryFile: string;
  let benchVisionFile: string;

  const rel = 'Test-GGUF/test-Q4.gguf';
  const modelDir = () => join(temp.modelsDir, 'Test-GGUF');
  const modelPath = () => join(modelDir(), 'test-Q4.gguf');
  const mmproj = () => join(modelDir(), 'mmproj-BF16.gguf');
  const cacheDir = () => join(modelDir(), '.cache');

  beforeEach(() => {
    temp = makeTempRuntime();
    const env = envForTemp(temp);
    customFile = env.LOCAL_AI_CUSTOM_CATALOG_FILE!;
    overridesFile = env.LOCAL_AI_PRESET_OVERRIDES_FILE!;
    benchProfileFile = join(temp.runtimeDir, 'llama-bench-profiles.tsv');
    benchHistoryFile = join(temp.runtimeDir, 'llama-bench-history.tsv');
    benchVisionFile = join(temp.runtimeDir, 'bench-vision.tsv');
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }

    // synthesise a model + mmproj + hf cache sidecar + TSV rows
    mkdirSync(modelDir(), { recursive: true });
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(modelPath(), '');
    writeFileSync(mmproj(), '');
    writeFileSync(join(cacheDir(), 'meta.json'), '{}');

    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(
      benchProfileFile,
      `macbook-pro-48g\t${rel}\ttext\t32768\tabc\tdefault\t10\t100\t2026-04-17\n` +
        `unrelated-rel\tthroughput\t20\t200\t2026-04-17\n`,
    );
    writeFileSync(
      benchHistoryFile,
      `2026-04-17\tmacbook-pro-48g\t${rel}\ttext\t32768\tabc\tdefault\t10\t100\t-fa on\n`,
    );
    writeFileSync(
      benchVisionFile,
      `macbook-pro-48g\t${rel}\t32768\tabc\t500\t50\t100\t50\t2026-04-17\n`,
    );
    writeFileSync(
      customFile,
      `test-custom\tTest Custom\tcustom\tgeneral\tcandidate\t${rel}\tunsloth/Test-GGUF\n`,
    );
    writeFileSync(
      overridesFile,
      `balanced\tfast\t${rel}\t2026-04-17\n` +
        `macbook-pro-48g\tbest\tanother/model.gguf\t2026-04-17\n`,
    );
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
    temp.cleanup();
  });

  test('candidate scope: removes model + sidecar + prunes bench TSVs', () => {
    const report = uninstall({ rel });
    expect(report.code).toBe(0);
    expect(report.scope).toBe('candidate');

    // model dir gone
    expect(existsSync(modelDir())).toBe(false);

    // Promotion override still intact (force=false)
    const overridesBody = Bun.file(overridesFile);
    expect(overridesBody).toBeDefined();

    // Bench profile row for rel pruned, unrelated row retained
    const bp = require('node:fs').readFileSync(benchProfileFile, 'utf8');
    expect(bp).not.toContain(rel);
    expect(bp).toContain('unrelated-rel');

    // History + vision fully pruned -> files deleted
    expect(existsSync(benchHistoryFile)).toBe(false);
    expect(existsSync(benchVisionFile)).toBe(false);

    // Custom catalog emptied -> file deleted
    expect(existsSync(customFile)).toBe(false);
  });

  test('refuses non-candidate scope without --force', () => {
    // Change scope to something non-candidate and retry
    writeFileSync(
      customFile,
      `test-custom\tTest Custom\tcustom\tgeneral\tquality\t${rel}\tunsloth/Test-GGUF\n`,
    );
    const report = uninstall({ rel, force: false });
    expect(report.code).toBe(1);
    expect(report.error).toMatch(/scope=quality/);
    // Model file should still be on disk
    expect(existsSync(modelPath())).toBe(true);
  });

  test('--force removes promotion overrides too', () => {
    const report = uninstall({ rel, force: true });
    expect(report.code).toBe(0);
    // Promotion file keeps the unrelated row, but the rel row is gone
    const body = require('node:fs').readFileSync(overridesFile, 'utf8');
    expect(body).not.toContain(rel);
    expect(body).toContain('another/model.gguf');
  });

  test('rejects bogus rel shape', () => {
    const report = uninstall({ rel: 'no-slash-here.gguf' });
    expect(report.code).toBe(1);
    expect(report.error).toMatch(/<repo-dir>\/<file\.gguf>/);
  });

  test('no catalog entry + no file on disk -> refusal', () => {
    const report = uninstall({ rel: 'Does-Not-Exist/file.gguf' });
    expect(report.code).toBe(1);
    expect(report.error).toMatch(/No catalog entry/);
  });
});
