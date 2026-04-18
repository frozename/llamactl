import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHfBin } from '../src/pull.js';
import { makeTempRuntime } from './helpers.js';

describe('resolveHfBin', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('LOCAL_AI_HF_BIN override wins', () => {
    const override = join(temp.devStorage, 'my-hf');
    expect(
      resolveHfBin({
        LOCAL_AI_HF_BIN: override,
        PATH: '',
      }),
    ).toBe(override);
  });

  test('falls back to literal `hf` when nothing is on PATH', () => {
    expect(resolveHfBin({ PATH: join(temp.devStorage, 'empty') })).toBe('hf');
  });

  test('picks `hf` on PATH when present', () => {
    const bin = join(temp.devStorage, 'bin');
    mkdirSync(bin, { recursive: true });
    const full = join(bin, 'hf');
    writeFileSync(full, '#!/bin/sh\nexit 0\n');
    chmodSync(full, 0o755);
    expect(resolveHfBin({ PATH: bin })).toBe(full);
  });

  test('falls back to `huggingface-cli` when only it is available', () => {
    const bin = join(temp.devStorage, 'bin');
    mkdirSync(bin, { recursive: true });
    const full = join(bin, 'huggingface-cli');
    writeFileSync(full, '#!/bin/sh\nexit 0\n');
    chmodSync(full, 0o755);
    expect(resolveHfBin({ PATH: bin })).toBe(full);
  });
});
