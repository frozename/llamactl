import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTempRuntime, runCli } from './helpers.js';

describe('llamactl catalog', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => temp.cleanup());

  test('catalog list (no custom file) returns just builtin', () => {
    const r = runCli(['catalog', 'list'], temp.env);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.length).toBe(10);
    expect(lines[0]).toContain('gemma4-e4b-q8');
  });

  test('catalog list --json returns a JSON array', () => {
    const r = runCli(['catalog', 'list', '--json'], temp.env);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].rel).toContain('.gguf');
  });

  test('catalog list bogus scope exits non-zero', () => {
    const r = runCli(['catalog', 'list', 'bogus-scope'], temp.env);
    expect(r.code).not.toBe(0);
  });

  test('catalog status on curated rel reports class_source=catalog', () => {
    const r = runCli(
      ['catalog', 'status', 'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf'],
      temp.env,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('class_source=catalog');
    expect(r.stdout).toContain('quant=q4');
  });

  test('catalog status missing rel exits non-zero', () => {
    const r = runCli(['catalog', 'status'], temp.env);
    expect(r.code).not.toBe(0);
  });

  test('catalog add -> list round-trip', () => {
    const add = runCli(
      [
        'catalog',
        'add',
        'unsloth/E2E-Test-GGUF',
        'e2e-test-Q4.gguf',
        'E2E Test',
        'custom',
        'general',
        'candidate',
      ],
      temp.env,
    );
    expect(add.code).toBe(0);
    expect(add.stdout).toContain('Added curated entry');

    const list = runCli(['catalog', 'list', 'custom'], temp.env);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('E2E-Test-GGUF/e2e-test-Q4.gguf');
  });

  test('catalog add with an existing rel fails', () => {
    const args = [
      'catalog',
      'add',
      'unsloth/Dupe-E2E-GGUF',
      'dupe.gguf',
      'Dupe',
      'custom',
      'general',
      'candidate',
    ];
    runCli(args, temp.env);
    const r = runCli(args, temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('already contains');
  });

  test('catalog promote + promotions round-trip', () => {
    // Need a rel to promote — add one first
    runCli(
      [
        'catalog',
        'add',
        'unsloth/Promote-E2E-GGUF',
        'promote-e2e.gguf',
        'Promote',
        'custom',
        'general',
        'candidate',
      ],
      temp.env,
    );

    const promote = runCli(
      [
        'catalog',
        'promote',
        'balanced',
        'fast',
        'Promote-E2E-GGUF/promote-e2e.gguf',
      ],
      temp.env,
    );
    expect(promote.code).toBe(0);
    expect(promote.stdout).toContain('Promoted Promote-E2E-GGUF/promote-e2e.gguf');
    expect(promote.stdout).toContain('profile=balanced preset=fast');

    const promotions = runCli(['catalog', 'promotions'], temp.env);
    expect(promotions.code).toBe(0);
    expect(promotions.stdout).toContain('profile=balanced preset=fast');
  });

  test('catalog promote rejects unknown preset name', () => {
    const r = runCli(
      ['catalog', 'promote', 'balanced', 'super-fast', 'some/rel.gguf'],
      temp.env,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown preset');
  });

  test('catalog promotions on empty file prints message + exits 1', () => {
    const r = runCli(['catalog', 'promotions'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('No preset promotions recorded');
  });
});
