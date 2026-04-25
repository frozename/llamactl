import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchLogs } from '../src/search/logs';

describe('searchLogs', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'search-logs-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('matches line content with line numbers', async () => {
    const path = join(tmp, 'a.log');
    writeFileSync(path, ['line one', 'error: boom', 'line three'].join('\n'), 'utf8');
    const out = await searchLogs({
      query: 'boom',
      files: [{ label: 'a', path }],
      limit: 30,
    });
    expect(out.length).toBe(1);
    expect(out[0]!.matches[0]!.lineNumber).toBe(2);
  });

  test('rolling window drops content beyond windowBytes', async () => {
    const path = join(tmp, 'b.log');
    const head = 'noise\n'.repeat(2000);  // ~12 KB
    const tail = 'needle line\n';
    writeFileSync(path, head + tail, 'utf8');
    const out = await searchLogs({
      query: 'needle',
      files: [{ label: 'b', path }],
      limit: 30,
      windowBytes: 64,
    });
    expect(out.length).toBe(1);
  });

  test('multi-file fan-in', async () => {
    const a = join(tmp, 'a.log'); const b = join(tmp, 'b.log');
    writeFileSync(a, 'foo here', 'utf8');
    writeFileSync(b, 'foo there', 'utf8');
    const out = await searchLogs({
      query: 'foo',
      files: [{ label: 'a', path: a }, { label: 'b', path: b }],
      limit: 30,
    });
    expect(out.map((h) => h.fileLabel).sort()).toEqual(['a', 'b']);
  });

  test('missing file is skipped, no throw', async () => {
    const out = await searchLogs({
      query: 'foo',
      files: [{ label: 'missing', path: join(tmp, 'nope.log') }],
      limit: 30,
    });
    expect(out).toEqual([]);
  });
});
