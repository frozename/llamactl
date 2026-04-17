import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRuntime, runCli } from './helpers.js';

describe('llamactl bench', () => {
  let temp: ReturnType<typeof makeTempRuntime>;

  // Gemma 4 is classified as multimodal in the builtin catalog, so
  // `defaultModeForRel` resolves to `vision`. There's no llama.cpp
  // checkout in the temp $DEV_STORAGE so `resolveBuildId` falls all
  // the way back to literal `unknown`. The seed TSV rows must use
  // the same key shape or `findLatestProfile` will miss them.
  const seedBenchFiles = () => {
    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(
      join(temp.runtimeDir, 'llama-bench-profiles.tsv'),
      `macbook-pro-48g\tgemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf\tvision\t32768\tunknown\tdefault\t11.134248\t103.179705\t2026-04-17T08:00:00-0300\n`,
    );
    writeFileSync(
      join(temp.runtimeDir, 'llama-bench-history.tsv'),
      `2026-04-17T08:00:00-0300\tmacbook-pro-48g\tgemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf\tvision\t32768\tunknown\tdefault\t11.134248\t103.179705\t-fa on -b 2048 -ub 512\n`,
    );
  };

  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => temp.cleanup());

  test('bench show reports legacy/none without records', () => {
    const r = runCli(['bench', 'show', 'quality'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('No tuned launch profile');
  });

  test('bench show with seeded tsv prints key=value block', () => {
    seedBenchFiles();
    // `quality` preset on macbook-pro-48g resolves to gemma 31B Q4 — present in seed
    const r = runCli(['bench', 'show', 'quality'], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('model=gemma-4-31B-it-GGUF/');
    expect(r.stdout).toContain('profile=default');
    expect(r.stdout).toContain('gen_tps=11.134248');
    expect(r.stdout).toContain('prompt_tps=103.179705');
    expect(r.stdout).toContain('launch_args=-fa on -b 2048 -ub 512');
  });

  test('bench history all on empty state prints "No benchmark history"', () => {
    const r = runCli(['bench', 'history', 'all'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('No benchmark history');
  });

  test('bench history all with seed prints a row', () => {
    seedBenchFiles();
    const r = runCli(['bench', 'history', 'all'], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('model=gemma-4-31B-it-GGUF/');
    expect(r.stdout).toContain('profile=default');
  });

  test('bench history bogus target exits non-zero', () => {
    const r = runCli(['bench', 'history', 'totally-not-a-target'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown model target');
  });

  test('bench compare all with no records prints error + exits 1', () => {
    const r = runCli(['bench', 'compare', 'all', 'all'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('No tuned launch profiles');
  });

  test('bench compare after seed shows the matching catalog row', () => {
    seedBenchFiles();
    const r = runCli(['bench', 'compare', 'multimodal', 'quality'], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Gemma 4 31B Q4');
    expect(r.stdout).toContain('class=multimodal');
    expect(r.stdout).toContain('tuned=default');
  });
});
