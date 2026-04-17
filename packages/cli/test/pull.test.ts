import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeTempRuntime, runCli } from './helpers.js';

describe('llamactl pull (usage + arg wiring)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;

  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => temp.cleanup());

  test('no args prints USAGE to stdout and exits non-zero', () => {
    const r = runCli(['pull'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('Usage: llamactl pull');
  });

  test('--help prints USAGE and exits 0', () => {
    const r = runCli(['pull', '--help'], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Subcommands:');
  });

  test('pull file without positional repo/file errors', () => {
    const r = runCli(['pull', 'file'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Usage: llamactl pull file');
  });

  test('pull candidate without repo errors', () => {
    const r = runCli(['pull', 'candidate'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Usage: llamactl pull candidate');
  });

  test('pull candidate --json with HF disabled returns structured error on stdout', () => {
    const r = runCli(
      ['pull', 'candidate', '--json', 'unsloth/not-a-real-repo'],
      temp.env,
    );
    expect(r.code).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error).toContain('Unable to resolve a candidate file');
  });

  test('unknown flag is rejected', () => {
    const r = runCli(['pull', 'file', '--bogus'], temp.env);
    expect(r.code).not.toBe(0);
  });
});
