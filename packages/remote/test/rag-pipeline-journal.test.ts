import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openJournal } from '../src/rag/pipeline/journal.js';

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-pipeline-journal-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('openJournal', () => {
  test('creates the file on first open and accepts appends', async () => {
    const path = join(tmp, 'journal.jsonl');
    const j = await openJournal(path);
    await j.append({
      kind: 'run-started',
      ts: '2026-04-21T00:00:00.000Z',
      spec_hash: 'abc',
      sources: ['p:0:filesystem'],
    });
    await j.append({
      kind: 'doc-ingested',
      ts: '2026-04-21T00:00:01.000Z',
      source: 'p:0:filesystem',
      doc_id: 'doc-1',
      sha: 'deadbeef',
      chunks: 3,
    });
    await j.close();
    const raw = readFileSync(path, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0]!).kind).toBe('run-started');
    expect(JSON.parse(raw[1]!).kind).toBe('doc-ingested');
  });

  test('seen() returns false before doc-ingested and true after', async () => {
    const path = join(tmp, 'journal.jsonl');
    const j = await openJournal(path);
    expect(await j.seen('p:0:filesystem', 'doc-1', 'deadbeef')).toBe(false);
    await j.append({
      kind: 'doc-ingested',
      ts: '2026-04-21T00:00:01.000Z',
      source: 'p:0:filesystem',
      doc_id: 'doc-1',
      sha: 'deadbeef',
      chunks: 2,
    });
    expect(await j.seen('p:0:filesystem', 'doc-1', 'deadbeef')).toBe(true);
    // Different sha → not seen.
    expect(await j.seen('p:0:filesystem', 'doc-1', 'other-sha')).toBe(false);
    await j.close();
  });

  test('re-open reads prior entries into the dedupe set', async () => {
    const path = join(tmp, 'journal.jsonl');
    const j1 = await openJournal(path);
    await j1.append({
      kind: 'doc-ingested',
      ts: '2026-04-21T00:00:01.000Z',
      source: 'p:0:filesystem',
      doc_id: 'doc-1',
      sha: 'hash-a',
      chunks: 1,
    });
    await j1.close();
    const j2 = await openJournal(path);
    expect(await j2.seen('p:0:filesystem', 'doc-1', 'hash-a')).toBe(true);
    await j2.close();
  });

  test('malformed lines are ignored', async () => {
    const path = join(tmp, 'journal.jsonl');
    writeFileSync(
      path,
      [
        '{"kind":"doc-ingested","source":"p:0:filesystem","doc_id":"doc-1","sha":"hash-a","chunks":1,"ts":"2026-04-21T00:00:01Z"}',
        '{"this is broken',
        '',
        'not even json',
        '{"kind":"doc-ingested","source":"p:0:filesystem","doc_id":"doc-2","sha":"hash-b","chunks":1,"ts":"2026-04-21T00:00:02Z"}',
      ].join('\n'),
    );
    const j = await openJournal(path);
    expect(await j.seen('p:0:filesystem', 'doc-1', 'hash-a')).toBe(true);
    expect(await j.seen('p:0:filesystem', 'doc-2', 'hash-b')).toBe(true);
    expect(await j.seen('p:0:filesystem', 'missing', 'none')).toBe(false);
    await j.close();
  });

  test('non-doc-ingested entries are not counted for seen()', async () => {
    const path = join(tmp, 'journal.jsonl');
    const j = await openJournal(path);
    await j.append({
      kind: 'doc-skipped',
      ts: '2026-04-21T00:00:01.000Z',
      source: 'p:0:filesystem',
      doc_id: 'doc-1',
      reason: 'duplicate',
    });
    await j.close();
    const j2 = await openJournal(path);
    expect(await j2.seen('p:0:filesystem', 'doc-1', 'hash-a')).toBe(false);
    await j2.close();
  });
});
