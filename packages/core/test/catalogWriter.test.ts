import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { addCurated } from '../src/catalogWriter.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

describe('catalogWriter.addCurated (integration)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
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

  test('appends a new row with derived family + label', async () => {
    const result = await addCurated({
      repo: 'unsloth/Shim-Test-GGUF',
      fileOrRel: 'shim-test-Q4.gguf',
      class: 'general',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.family).toBe('custom'); // repo name doesn't match gemma/qwen/deepseek
    expect(result.entry.label).toBe('shim-test-Q4');
    expect(result.entry.scope).toBe('candidate');
    expect(result.entry.rel).toBe('Shim-Test-GGUF/shim-test-Q4.gguf');

    const body = readFileSync(result.file, 'utf8');
    expect(body.trim().split('\n').length).toBe(1);
    expect(body).toContain('Shim-Test-GGUF/shim-test-Q4.gguf');
  });

  test('derives gemma4 / qwen35 / qwen36 / deepseek families from repo id', async () => {
    const fam = async (repo: string, file: string): Promise<string> => {
      const r = await addCurated({ repo, fileOrRel: file, class: 'general' });
      if (!r.ok) throw new Error(r.error);
      return r.entry.family;
    };
    expect(await fam('unsloth/gemma-4-X-GGUF', 'a.gguf')).toBe('gemma4');
    expect(await fam('unsloth/qwen3.5-X-GGUF', 'b.gguf')).toBe('qwen35');
    expect(await fam('unsloth/Qwen3.6-X-GGUF', 'c.gguf')).toBe('qwen36');
    expect(await fam('unsloth/deepseek-X-GGUF', 'd.gguf')).toBe('deepseek');
  });

  test('refuses duplicate rel', async () => {
    await addCurated({
      repo: 'unsloth/Dupe-GGUF',
      fileOrRel: 'dupe.gguf',
      class: 'general',
    });
    const second = await addCurated({
      repo: 'unsloth/Dupe-GGUF',
      fileOrRel: 'dupe.gguf',
      class: 'general',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already contains/i);
  });

  test('rejects missing args', async () => {
    const r = await addCurated({ repo: '', fileOrRel: '' });
    expect(r.ok).toBe(false);
  });

  test('full-relpath input is honoured as-is', async () => {
    const r = await addCurated({
      repo: 'unsloth/Foo-GGUF',
      fileOrRel: 'subdir/foo.gguf',
      class: 'general',
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.entry.rel).toBe('subdir/foo.gguf');
    expect(existsSync(r.file)).toBe(true);
  });
});
