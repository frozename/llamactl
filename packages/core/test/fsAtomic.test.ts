import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLine, atomicWriteFile } from '../src/fsAtomic.js';

describe('fsAtomic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llamactl-fsatomic-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('atomicWriteFile creates the target + leaves no tmp files behind', () => {
    const target = join(dir, 'nested', 'file.tsv');
    atomicWriteFile(target, 'hello\n');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
    // No tmp-* sibling
    const entries = existsSync(join(dir, 'nested'))
      ? require('node:fs').readdirSync(join(dir, 'nested'))
      : [];
    expect(entries.filter((n: string) => n.startsWith('.')).length).toBe(0);
  });

  test('atomicWriteFile replaces contents on subsequent calls', () => {
    const target = join(dir, 'replaceme.tsv');
    atomicWriteFile(target, 'v1');
    atomicWriteFile(target, 'v2');
    expect(readFileSync(target, 'utf8')).toBe('v2');
  });

  test('appendLine creates the file + newline-appends', () => {
    const target = join(dir, 'appendable.tsv');
    appendLine(target, 'row1');
    appendLine(target, 'row2\n');
    appendLine(target, 'row3');
    expect(readFileSync(target, 'utf8')).toBe('row1\nrow2\nrow3\n');
  });
});
