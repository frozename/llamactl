import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deletePresetOverride,
  readPresetOverrides,
  resolvePreset,
  writePresetOverride,
} from '../src/presets.js';
import { envForTemp, FIXTURE_DIR, makeTempRuntime } from './helpers.js';

describe('presets.readPresetOverrides', () => {
  test('parses the fixture file, preserves updated_at', () => {
    const rows = readPresetOverrides(join(FIXTURE_DIR, 'preset-overrides.tsv'));
    expect(rows.length).toBe(2);
    expect(rows[0]?.profile).toBe('macbook-pro-48g');
    expect(rows[0]?.preset).toBe('fast');
    expect(rows[0]?.updated_at).toBe('2026-04-17T12:00:00-0300');
  });
  test('missing file returns []', () => {
    expect(readPresetOverrides('/tmp/does-not-exist.tsv')).toEqual([]);
  });
});

describe('presets.resolvePreset', () => {
  test('builtin macbook-pro-48g:best', () => {
    const res = resolvePreset('macbook-pro-48g', 'best', {} as NodeJS.ProcessEnv);
    expect(res.rel).toBe('gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf');
    expect(res.source).toBeNull();
  });
  test('env-var override wins over file override', () => {
    const temp = makeTempRuntime();
    const overridesFile = join(temp.runtimeDir, 'preset-overrides.tsv');
    try {
      copyFileSync(
        join(FIXTURE_DIR, 'preset-overrides.tsv'),
        (Bun.file(overridesFile), overridesFile),
      );
    } catch {
      // fall back: write the fixture contents without mkdir yet
    }
    const env = {
      ...envForTemp(temp),
      LOCAL_AI_PRESET_OVERRIDES_FILE: overridesFile,
      LOCAL_AI_PRESET_MACBOOK_PRO_48G_FAST_MODEL: 'env/override.gguf',
    } as NodeJS.ProcessEnv;
    const res = resolvePreset('macbook-pro-48g', 'fast', env);
    expect(res.rel).toBe('env/override.gguf');
    expect(res.source).toBe('env');
    temp.cleanup();
  });
});

describe('presets.writePresetOverride (round-trip)', () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);

  afterEach(() => {
    // Wipe any file we may have written so subsequent tests start empty.
    try {
      const file = env.LOCAL_AI_PRESET_OVERRIDES_FILE!;
      if (existsSync(file)) Bun.write(file, '');
    } catch {
      // no-op
    }
  });

  test('new row appended on first write', () => {
    writePresetOverride('balanced', 'best', 'some/model.gguf', env);
    const file = env.LOCAL_AI_PRESET_OVERRIDES_FILE!;
    const body = readFileSync(file, 'utf8');
    expect(body).toContain('balanced\tbest\tsome/model.gguf');
  });

  test('re-promote replaces in place (no row growth)', () => {
    writePresetOverride('balanced', 'best', 'first/model.gguf', env);
    writePresetOverride('balanced', 'best', 'second/model.gguf', env);
    const rows = readPresetOverrides(env.LOCAL_AI_PRESET_OVERRIDES_FILE!);
    expect(rows.length).toBe(1);
    expect(rows[0]?.rel).toBe('second/model.gguf');
  });
});

describe('presets.deletePresetOverride', () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);

  afterEach(() => {
    try {
      const file = env.LOCAL_AI_PRESET_OVERRIDES_FILE!;
      if (existsSync(file)) Bun.write(file, '');
    } catch {
      // no-op
    }
  });

  test('removes the matching row and preserves others', () => {
    writePresetOverride('balanced', 'best', 'a/one.gguf', env);
    writePresetOverride('balanced', 'fast', 'a/two.gguf', env);
    expect(deletePresetOverride('balanced', 'best', env)).toBe(true);
    const rows = readPresetOverrides(env.LOCAL_AI_PRESET_OVERRIDES_FILE!);
    expect(rows.length).toBe(1);
    expect(rows[0]?.preset).toBe('fast');
  });

  test('unlinks the file when the last row is removed', () => {
    writePresetOverride('balanced', 'best', 'only/one.gguf', env);
    expect(deletePresetOverride('balanced', 'best', env)).toBe(true);
    expect(existsSync(env.LOCAL_AI_PRESET_OVERRIDES_FILE!)).toBe(false);
  });

  test('no-op when no row matches', () => {
    writePresetOverride('balanced', 'best', 'kept/row.gguf', env);
    expect(deletePresetOverride('macbook-pro-48g', 'fast', env)).toBe(false);
    const rows = readPresetOverrides(env.LOCAL_AI_PRESET_OVERRIDES_FILE!);
    expect(rows.length).toBe(1);
  });

  test('returns false when the file does not exist', () => {
    // presumes the afterEach or earlier tests cleared the file
    expect(deletePresetOverride('balanced', 'best', env)).toBe(false);
  });
});
