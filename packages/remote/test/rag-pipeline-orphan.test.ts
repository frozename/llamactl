import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_STALE_THRESHOLD_MS,
  detectOrphanedRuns,
  findTrailingOrphan,
} from '../src/rag/pipeline/orphan.js';
import type { PipelineRecord } from '../src/rag/pipeline/store.js';
import type { RagPipelineManifest } from '../src/rag/pipeline/schema.js';

/**
 * `findTrailingOrphan` is pure (string in, struct out) — every case
 * below tests a journal-shaped string directly. `detectOrphanedRuns`
 * is the I/O wrapper; tests inject `listPipelines` + `readJournalTail`
 * seams so no disk touch.
 */

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function journal(...entries: Array<Record<string, unknown>>): string {
  return `${entries.map(line).join('\n')}\n`;
}

function manifest(name: string): RagPipelineManifest {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'RagPipeline',
    metadata: { name },
    spec: {
      destination: { ragNode: 'kb-pg', collection: 'docs' },
      sources: [{ kind: 'filesystem', root: '/tmp', glob: '**/*' }],
      transforms: [],
      concurrency: 4,
      on_duplicate: 'skip',
    },
  } as RagPipelineManifest;
}

describe('findTrailingOrphan', () => {
  const NOW = Date.UTC(2026, 3, 22, 1, 0, 0);
  const ELEVEN_MIN_AGO = new Date(NOW - 11 * 60 * 1000).toISOString();
  const NINE_MIN_AGO = new Date(NOW - 9 * 60 * 1000).toISOString();

  test('returns null for an empty journal', () => {
    expect(findTrailingOrphan('', DEFAULT_STALE_THRESHOLD_MS, NOW)).toBeNull();
  });

  test('returns null when the newest run-started has a paired run-complete', () => {
    const raw = journal(
      { kind: 'run-started', ts: ELEVEN_MIN_AGO, spec_hash: 'x', sources: ['s'] },
      { kind: 'run-complete', ts: ELEVEN_MIN_AGO, total_docs: 1, total_chunks: 1, elapsed_ms: 10 },
    );
    expect(findTrailingOrphan(raw, DEFAULT_STALE_THRESHOLD_MS, NOW)).toBeNull();
  });

  test('returns null when the unpaired start is younger than the threshold', () => {
    const raw = journal(
      { kind: 'run-started', ts: NINE_MIN_AGO, spec_hash: 'x', sources: ['s'] },
    );
    expect(findTrailingOrphan(raw, DEFAULT_STALE_THRESHOLD_MS, NOW)).toBeNull();
  });

  test('flags an unpaired run-started older than the threshold', () => {
    const raw = journal(
      { kind: 'run-started', ts: ELEVEN_MIN_AGO, spec_hash: 'x', sources: ['s0', 's1'] },
      { kind: 'source-started', ts: ELEVEN_MIN_AGO, source: 's0' },
      { kind: 'doc-ingested', ts: ELEVEN_MIN_AGO, source: 's0', doc_id: 'd', sha: 'h', chunks: 1 },
      // No run-complete; agent crashed here.
    );
    const o = findTrailingOrphan(raw, DEFAULT_STALE_THRESHOLD_MS, NOW);
    expect(o).not.toBeNull();
    expect(o!.startedAt).toBe(ELEVEN_MIN_AGO);
    expect(o!.sources).toEqual(['s0', 's1']);
  });

  test('only the newest unpaired run-started is reported', () => {
    // Three generations: oldest had a complete, middle was orphaned
    // (interrupted), newest orphaned too. We only surface the newest.
    const veryOld = new Date(NOW - 50 * 60 * 1000).toISOString();
    const midOld = new Date(NOW - 30 * 60 * 1000).toISOString();
    const recent = new Date(NOW - 11 * 60 * 1000).toISOString();
    const raw = journal(
      { kind: 'run-started', ts: veryOld, spec_hash: 'x', sources: ['a'] },
      { kind: 'run-complete', ts: veryOld, total_docs: 0, total_chunks: 0, elapsed_ms: 1 },
      { kind: 'run-started', ts: midOld, spec_hash: 'x', sources: ['b'] },
      // orphan 1
      { kind: 'run-started', ts: recent, spec_hash: 'x', sources: ['c'] },
      // orphan 2 (newest)
    );
    const o = findTrailingOrphan(raw, DEFAULT_STALE_THRESHOLD_MS, NOW);
    expect(o?.startedAt).toBe(recent);
    expect(o?.sources).toEqual(['c']);
  });

  test('malformed JSON lines are ignored', () => {
    const raw = [
      '{not json',
      line({ kind: 'run-started', ts: ELEVEN_MIN_AGO, spec_hash: 'x', sources: ['s'] }),
      'garbage',
      '',
    ].join('\n');
    const o = findTrailingOrphan(raw, DEFAULT_STALE_THRESHOLD_MS, NOW);
    expect(o?.startedAt).toBe(ELEVEN_MIN_AGO);
  });

  test('entries with non-string ts are skipped', () => {
    const raw = journal(
      { kind: 'run-started', ts: 1234567890, spec_hash: 'x', sources: [] },
    );
    expect(findTrailingOrphan(raw, DEFAULT_STALE_THRESHOLD_MS, NOW)).toBeNull();
  });

  test('missing sources field → empty array', () => {
    const raw = journal(
      { kind: 'run-started', ts: ELEVEN_MIN_AGO, spec_hash: 'x' },
    );
    const o = findTrailingOrphan(raw, DEFAULT_STALE_THRESHOLD_MS, NOW);
    expect(o?.sources).toEqual([]);
  });
});

describe('detectOrphanedRuns', () => {
  const NOW = Date.UTC(2026, 3, 22, 1, 0, 0);
  const OLD = new Date(NOW - 20 * 60 * 1000).toISOString();

  test('lists orphans across applied pipelines, skips live ones', () => {
    // Three pipelines in the registry; journals shaped differently.
    const records: PipelineRecord[] = [
      { name: 'fresh', manifest: manifest('fresh') },
      { name: 'orphaned', manifest: manifest('orphaned') },
      { name: 'never-ran', manifest: manifest('never-ran') },
    ];
    const journals: Record<string, string | null> = {
      fresh: journal(
        { kind: 'run-started', ts: OLD, spec_hash: 'x', sources: ['s'] },
        { kind: 'run-complete', ts: OLD, total_docs: 1, total_chunks: 1, elapsed_ms: 1 },
      ),
      orphaned: journal(
        { kind: 'run-started', ts: OLD, spec_hash: 'x', sources: ['o'] },
      ),
      'never-ran': null,
    };
    const out = detectOrphanedRuns({
      now: () => NOW,
      listPipelines: () => records,
      readJournalTail: (name) => journals[name] ?? null,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('orphaned');
    expect(out[0]!.sources).toEqual(['o']);
  });

  test('respects a custom staleThresholdMs', () => {
    const records: PipelineRecord[] = [{ name: 'young', manifest: manifest('young') }];
    const journals: Record<string, string> = {
      young: journal(
        { kind: 'run-started', ts: new Date(NOW - 2 * 60 * 1000).toISOString(), spec_hash: 'x', sources: [] },
      ),
    };
    // With the default 10-min threshold, 2 minutes is not stale.
    const defaulted = detectOrphanedRuns({
      now: () => NOW,
      listPipelines: () => records,
      readJournalTail: (n) => journals[n] ?? null,
    });
    expect(defaulted).toHaveLength(0);
    // With a 1-min threshold it is.
    const aggressive = detectOrphanedRuns({
      staleThresholdMs: 60 * 1000,
      now: () => NOW,
      listPipelines: () => records,
      readJournalTail: (n) => journals[n] ?? null,
    });
    expect(aggressive).toHaveLength(1);
  });
});
