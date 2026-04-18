import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { makeTempRuntime, runCli } from './helpers.js';

describe('llamactl bench preset / vision (usage + binary-missing paths)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;

  beforeEach(() => {
    temp = makeTempRuntime();
    // Force LLAMA_CPP_BIN at a nonexistent path so the binary check is
    // deterministic regardless of the developer's real llama.cpp install.
    temp.env.LLAMA_CPP_BIN = join(temp.devStorage, 'nonexistent-bin');
  });
  afterEach(() => temp.cleanup());

  test('bench preset without a valid target errors cleanly', () => {
    const r = runCli(['bench', 'preset', 'not-a-real-alias'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test('bench preset --json emits a structured error when the binary is missing', () => {
    const r = runCli(['bench', 'preset', 'Demo/demo.gguf', '--json'], temp.env);
    expect(r.code).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error).toBeDefined();
  });

  test('bench vision --json emits a structured error when the binary is missing', () => {
    const r = runCli(['bench', 'vision', 'Demo/demo.gguf', '--json'], temp.env);
    expect(r.code).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error).toBeDefined();
  });

  test('unknown mode rejects', () => {
    const r = runCli(['bench', 'preset', 'Demo/demo.gguf', 'bogus'], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown bench mode');
  });

  test('unknown flag rejects', () => {
    const r = runCli(['bench', 'preset', 'Demo/demo.gguf', '--bogus'], temp.env);
    expect(r.code).not.toBe(0);
  });
});
