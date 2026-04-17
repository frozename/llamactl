import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRuntime, runCli } from './helpers.js';

describe('llamactl uninstall', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  const rel = 'E2E-Uninstall-GGUF/e2e.gguf';
  const primeFs = () => {
    const modelDir = join(temp.modelsDir, 'E2E-Uninstall-GGUF');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'e2e.gguf'), '');
    writeFileSync(join(modelDir, 'mmproj-BF16.gguf'), '');
    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(
      join(temp.runtimeDir, 'curated-models.tsv'),
      `e2e-uninstall\tE2E Uninstall\tcustom\tgeneral\tcandidate\t${rel}\tunsloth/E2E-Uninstall-GGUF\n`,
    );
  };

  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => temp.cleanup());

  test('candidate uninstall removes the model and prunes catalog', () => {
    primeFs();
    const r = runCli(['uninstall', rel], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Uninstalling');
    expect(existsSync(join(temp.modelsDir, 'E2E-Uninstall-GGUF'))).toBe(false);
    // Custom catalog file should be gone (last row pruned -> empty)
    expect(existsSync(join(temp.runtimeDir, 'curated-models.tsv'))).toBe(false);
  });

  test('non-candidate refuses without --force', () => {
    primeFs();
    // Rewrite catalog with a non-candidate scope
    writeFileSync(
      join(temp.runtimeDir, 'curated-models.tsv'),
      `e2e\tE2E\tcustom\tgeneral\tquality\t${rel}\tunsloth/E2E-Uninstall-GGUF\n`,
    );
    const r = runCli(['uninstall', rel], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Refusing to uninstall');
    // Model still on disk
    expect(existsSync(join(temp.modelsDir, 'E2E-Uninstall-GGUF', 'e2e.gguf'))).toBe(true);
  });

  test('non-candidate + --force succeeds and also removes promotion overrides', () => {
    primeFs();
    writeFileSync(
      join(temp.runtimeDir, 'curated-models.tsv'),
      `e2e\tE2E\tcustom\tgeneral\tquality\t${rel}\tunsloth/E2E-Uninstall-GGUF\n`,
    );
    writeFileSync(
      join(temp.runtimeDir, 'preset-overrides.tsv'),
      `balanced\tfast\t${rel}\t2026-04-17\n` +
        `macbook-pro-48g\tbest\tother/model.gguf\t2026-04-17\n`,
    );
    const r = runCli(['uninstall', rel, '--force'], temp.env);
    expect(r.code).toBe(0);
    const promos = require('node:fs').readFileSync(
      join(temp.runtimeDir, 'preset-overrides.tsv'),
      'utf8',
    );
    expect(promos).not.toContain(rel);
    expect(promos).toContain('other/model.gguf');
  });

  test('unknown flag exits non-zero', () => {
    const r = runCli(['uninstall', '--bogus'], temp.env);
    expect(r.code).not.toBe(0);
  });

  test('missing rel prints USAGE + exits non-zero', () => {
    const r = runCli(['uninstall'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('Usage:');
  });
});
