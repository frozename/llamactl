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

  test('priorIngestions returns every wet ingestion for a doc', async () => {
    const path = join(tmp, 'journal.jsonl');
    const j = await openJournal(path);
    await j.append({
      kind: 'doc-ingested',
      ts: '2026-04-21T00:00:01.000Z',
      source: 'p:0:filesystem',
      doc_id: 'doc-1',
      sha: 'sha-a',
      chunks: 2,
      chunk_ids: ['doc-1#0', 'doc-1#1'],
    });
    await j.append({
      kind: 'doc-ingested',
      ts: '2026-04-21T00:00:02.000Z',
      source: 'p:0:filesystem',
      doc_id: 'doc-1',
      sha: 'sha-b',
      chunks: 3,
      chunk_ids: ['doc-1@shab#0', 'doc-1@shab#1', 'doc-1@shab#2'],
    });
    // Different doc — should NOT appear.
    await j.append({
      kind: 'doc-ingested',
      ts: '2026-04-21T00:00:03.000Z',
      source: 'p:0:filesystem',
      doc_id: 'other',
      sha: 'sha-x',
      chunks: 1,
      chunk_ids: ['other#0'],
    });
    // Different source but same doc_id — should NOT appear.
    await j.append({
      kind: 'doc-ingested',
      ts: '2026-04-21T00:00:04.000Z',
      source: 'p:1:http',
      doc_id: 'doc-1',
      sha: 'sha-cross',
      chunks: 1,
      chunk_ids: ['doc-1#cross'],
    });
    const prior = await j.priorIngestions('p:0:filesystem', 'doc-1');
    expect(prior).toHaveLength(2);
    expect(prior[0]!.sha).toBe('sha-a');
    expect(prior[0]!.chunk_ids).toEqual(['doc-1#0', 'doc-1#1']);
    expect(prior[1]!.sha).toBe('sha-b');
    expect(prior[1]!.chunk_ids).toEqual(['doc-1@shab#0', 'doc-1@shab#1', 'doc-1@shab#2']);
    await j.close();
  });

  test('priorIngestions is empty when no prior wet ingestion exists', async () => {
    const path = join(tmp, 'journal.jsonl');
    const j = await openJournal(path);
    // Dry-run entry must NOT count — it never wrote to the store.
    await j.append({
      kind: 'doc-would-ingest',
      ts: '2026-04-21T00:00:01.000Z',
      source: 'p:0:filesystem',
      doc_id: 'doc-1',
      sha: 'sha-a',
      chunks: 2,
      chunk_ids: ['doc-1#0', 'doc-1#1'],
    });
    expect(await j.priorIngestions('p:0:filesystem', 'doc-1')).toEqual([]);
    await j.close();
  });

  test('priorIngestions survives re-open', async () => {
    const path = join(tmp, 'journal.jsonl');
    const j1 = await openJournal(path);
    await j1.append({
      kind: 'doc-ingested',
      ts: '2026-04-21T00:00:01.000Z',
      source: 'p:0:filesystem',
      doc_id: 'doc-1',
      sha: 'sha-a',
      chunks: 1,
      chunk_ids: ['doc-1#0'],
    });
    await j1.close();
    const j2 = await openJournal(path);
    const prior = await j2.priorIngestions('p:0:filesystem', 'doc-1');
    expect(prior).toHaveLength(1);
    expect(prior[0]!.chunk_ids).toEqual(['doc-1#0']);
    await j2.close();
  });

  test('priorIngestions handles legacy entries without chunk_ids', async () => {
    // Pre-R2.a journals may have doc-ingested entries with only `chunks`
    // and no `chunk_ids` field. Those should still surface in priorIngestions
    // with an empty chunk_ids array — replace mode will no-op on them.
    const path = join(tmp, 'journal.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({
        kind: 'doc-ingested',
        ts: '2026-04-21T00:00:01.000Z',
        source: 'p:0:filesystem',
        doc_id: 'legacy',
        sha: 'sha-legacy',
        chunks: 4,
      })}\n`,
    );
    const j = await openJournal(path);
    const prior = await j.priorIngestions('p:0:filesystem', 'legacy');
    expect(prior).toHaveLength(1);
    expect(prior[0]!.sha).toBe('sha-legacy');
    expect(prior[0]!.chunk_ids).toEqual([]);
    await j.close();
  });
});
