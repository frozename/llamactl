import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTempRuntime, runCli } from './helpers.js';

describe('llamactl candidate (usage + error paths)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;

  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => temp.cleanup());

  test('no args prints USAGE and exits non-zero', () => {
    const r = runCli(['candidate'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('Usage: llamactl candidate');
  });

  test('--help prints USAGE and exits 0', () => {
    const r = runCli(['candidate', '--help'], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Subcommands:');
  });

  test('test without repo errors', () => {
    const r = runCli(['candidate', 'test'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Usage: llamactl candidate test');
  });

  test('unknown subcommand errors', () => {
    const r = runCli(['candidate', 'bogus'], temp.env);
    expect(r.code).not.toBe(0);
  });

  test('test --json with HF disabled returns structured error', () => {
    const r = runCli(
      ['candidate', 'test', '--json', 'unsloth/not-a-real-repo'],
      temp.env,
    );
    expect(r.code).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error).toContain('Unable to resolve a candidate file');
  });

  test('unknown flag is rejected', () => {
    const r = runCli(['candidate', 'test', '--bogus'], temp.env);
    expect(r.code).not.toBe(0);
  });
});
