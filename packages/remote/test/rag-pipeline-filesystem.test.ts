import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { filesystemFetcher } from '../src/rag/pipeline/fetchers/filesystem.js';
import { looksBinary } from '../src/rag/pipeline/fetchers/filesystem.js';
import type { RawDoc } from '../src/rag/pipeline/types.js';

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-pipeline-fs-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function collect(spec: unknown): Promise<RawDoc[]> {
  const logs: Array<{ level: string; msg: string }> = [];
  const ctx = {
    spec,
    log: (e: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) =>
      logs.push({ level: e.level, msg: e.msg }),
    signal: new AbortController().signal,
    env: process.env,
  };
  const out: RawDoc[] = [];
  for await (const doc of filesystemFetcher.fetch(ctx)) out.push(doc);
  // expose logs on out via a hidden prop for assertions if needed
  (out as unknown as { logs: typeof logs }).logs = logs;
  return out;
}

describe('filesystemFetcher', () => {
  test('yields text files with expected metadata', async () => {
    mkdirSync(join(tmp, 'docs'), { recursive: true });
    writeFileSync(join(tmp, 'docs', 'a.md'), '# A\n\nHello world.\n');
    writeFileSync(join(tmp, 'docs', 'b.txt'), 'plain text\n');

    const docs = await collect({
      kind: 'filesystem',
      root: tmp,
      glob: '**/*',
      tag: { team: 'platform' },
    });
    // Two text files expected
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual(['docs/a.md', 'docs/b.txt']);
    const a = docs.find((d) => d.id === 'docs/a.md')!;
    expect(a.content).toContain('Hello world.');
    expect(a.metadata.source_kind).toBe('filesystem');
    expect(a.metadata.team).toBe('platform');
    expect(typeof a.metadata.path).toBe('string');
  });

  test('skips binary files and logs a warn', async () => {
    writeFileSync(join(tmp, 'text.md'), 'hello');
    const bin = Buffer.alloc(600);
    for (let i = 0; i < bin.length; i++) bin[i] = i % 256;
    writeFileSync(join(tmp, 'blob.bin'), bin);

    const docs = await collect({ kind: 'filesystem', root: tmp });
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual(['text.md']);
    const logs = (docs as unknown as { logs: Array<{ level: string; msg: string }> }).logs;
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('binary'))).toBe(true);
  });

  test('honors the glob pattern (only .md)', async () => {
    writeFileSync(join(tmp, 'a.md'), '# a');
    writeFileSync(join(tmp, 'b.txt'), 'plain');
    mkdirSync(join(tmp, 'sub'), { recursive: true });
    writeFileSync(join(tmp, 'sub', 'c.md'), '# c');
    const docs = await collect({ kind: 'filesystem', root: tmp, glob: '**/*.md' });
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual(['a.md', 'sub/c.md']);
  });

  test('applies spec tags into metadata', async () => {
    writeFileSync(join(tmp, 'a.md'), 'hi');
    const docs = await collect({
      kind: 'filesystem',
      root: tmp,
      tag: { source: 'local-docs', team: 'platform' },
    });
    expect(docs[0]!.metadata.source).toBe('local-docs');
    expect(docs[0]!.metadata.team).toBe('platform');
  });
});

describe('looksBinary', () => {
  test('returns false for utf-8 text', () => {
    expect(looksBinary(Buffer.from('hello world\n'))).toBe(false);
  });

  test('returns true for a buffer of non-printable bytes', () => {
    const buf = Buffer.alloc(300);
    for (let i = 0; i < buf.length; i++) buf[i] = 0x01;
    expect(looksBinary(buf)).toBe(true);
  });

  test('returns false on empty buffer', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });
});
