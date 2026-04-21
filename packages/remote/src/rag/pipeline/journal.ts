/**
 * JSONL journal for a RAG ingestion run. Every pipeline run appends
 * events — `run-started`, per-source and per-doc outcomes,
 * `run-complete` — to the journal file so operators can audit what
 * happened, re-run idempotently, and tail live progress. Dedupe
 * lookup reads the full journal on open and answers
 * `{source, doc_id, sha} already ingested?` from an in-memory Set,
 * so re-runs against an unchanged source produce zero embed/store
 * round-trips.
 *
 * Writes go through Bun.file's appendable writer when Bun is
 * available, and fall back to `node:fs/promises` otherwise — the
 * journal format itself is just newline-delimited JSON either way.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type JournalEntry =
  | { kind: 'run-started'; ts: string; spec_hash: string; sources: string[] }
  | { kind: 'source-started'; ts: string; source: string }
  | {
      kind: 'doc-skipped';
      ts: string;
      source: string;
      doc_id: string;
      reason: 'duplicate';
    }
  | {
      kind: 'doc-ingested';
      ts: string;
      source: string;
      doc_id: string;
      sha: string;
      chunks: number;
      /**
       * IDs of every chunk stored for this ingestion. Used by
       * `on_duplicate: replace` to drive a targeted delete before
       * re-ingesting an updated doc. Older journal lines may predate
       * this field — consumers treat missing `chunk_ids` as "unknown"
       * and fall back to a no-op delete.
       */
      chunk_ids?: string[];
    }
  | {
      // Dry-run variant — the doc was fetched + chunked but `adapter.store`
      // was skipped. Distinct kind (rather than a flag on `doc-ingested`)
      // so a single `grep kind=doc-ingested` counts only wet writes and
      // downstream tooling (dedupe, retrieval-backfill) doesn't
      // accidentally treat dry-run entries as source of truth.
      kind: 'doc-would-ingest';
      ts: string;
      source: string;
      doc_id: string;
      sha: string;
      chunks: number;
      chunk_ids?: string[];
    }
  | {
      kind: 'source-complete';
      ts: string;
      source: string;
      docs: number;
      chunks: number;
      errors: number;
    }
  | {
      kind: 'run-complete';
      ts: string;
      total_docs: number;
      total_chunks: number;
      elapsed_ms: number;
    }
  | {
      kind: 'error';
      ts: string;
      source?: string;
      doc_id?: string;
      message: string;
    };

export interface PriorIngestion {
  sha: string;
  chunk_ids: string[];
}

export interface Journal {
  /** Append a single entry as a single JSON line. */
  append(entry: JournalEntry): Promise<void>;
  /**
   * True if `{source, doc_id, sha}` was already ingested in any past
   * run recorded in this journal file.
   */
  seen(source: string, doc_id: string, sha: string): Promise<boolean>;
  /**
   * Every wet ingestion the journal has recorded for `{source, doc_id}`,
   * regardless of sha. Callers use this to drive `on_duplicate: replace`
   * (delete the union of all prior `chunk_ids` before storing) and
   * `on_duplicate: version` (skip when the incoming sha already exists).
   * Dry-run entries (`doc-would-ingest`) are intentionally excluded —
   * they never wrote to the store so there's nothing to reconcile
   * against. Ordered chronologically; most recent last.
   */
  priorIngestions(source: string, doc_id: string): Promise<PriorIngestion[]>;
  close(): Promise<void>;
}

function key(source: string, doc_id: string, sha: string): string {
  return `${source}\u0000${doc_id}\u0000${sha}`;
}

function docKey(source: string, doc_id: string): string {
  return `${source}\u0000${doc_id}`;
}

export async function openJournal(path: string): Promise<Journal> {
  await mkdir(dirname(path), { recursive: true });

  const { seen: seenSet, prior } = await loadIndexes(path);

  return {
    async append(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      // Bun.file + writer is a touch faster for high-volume streams;
      // node:fs/promises is the portable fallback and is plenty for
      // our per-doc cadence. We re-open on each append to keep the
      // code dead-simple — the pipeline's write rate is bounded by
      // embed + store round-trips, not by disk syscalls.
      await appendFile(path, line, 'utf8');
      if (entry.kind === 'doc-ingested') {
        seenSet.add(key(entry.source, entry.doc_id, entry.sha));
        const pk = docKey(entry.source, entry.doc_id);
        const list = prior.get(pk) ?? [];
        list.push({ sha: entry.sha, chunk_ids: entry.chunk_ids ?? [] });
        prior.set(pk, list);
      }
    },
    async seen(source, doc_id, sha) {
      return seenSet.has(key(source, doc_id, sha));
    },
    async priorIngestions(source, doc_id) {
      // Return a defensive copy so callers mutating the list can't
      // corrupt the in-memory index.
      return (prior.get(docKey(source, doc_id)) ?? []).map((p) => ({
        sha: p.sha,
        chunk_ids: [...p.chunk_ids],
      }));
    },
    async close() {
      // No resources held between calls — appendFile opens/closes
      // per call. Keeping the method in the contract so a future
      // batched-writer swap doesn't reshape the API.
    },
  };
}

interface JournalIndexes {
  seen: Set<string>;
  prior: Map<string, PriorIngestion[]>;
}

async function loadIndexes(path: string): Promise<JournalIndexes> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First run — ensure the file exists so subsequent open() calls
      // take the happy path and the file shows up in `ls` for the
      // operator.
      await writeFile(path, '', 'utf8');
      return { seen: new Set(), prior: new Map() };
    }
    throw err;
  }
  const seen = new Set<string>();
  const prior = new Map<string, PriorIngestion[]>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed line — skip silently. Re-running after a crash is
      // allowed to produce a partial JSONL stream; the in-memory set
      // is advisory anyway (a missed dedupe surfaces as a re-embed,
      // not a correctness bug).
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const entry = parsed as Partial<JournalEntry>;
    if (entry.kind !== 'doc-ingested') continue;
    const e = entry as Extract<JournalEntry, { kind: 'doc-ingested' }>;
    if (
      typeof e.source !== 'string' ||
      typeof e.doc_id !== 'string' ||
      typeof e.sha !== 'string'
    ) {
      continue;
    }
    seen.add(key(e.source, e.doc_id, e.sha));
    const pk = docKey(e.source, e.doc_id);
    const list = prior.get(pk) ?? [];
    list.push({ sha: e.sha, chunk_ids: Array.isArray(e.chunk_ids) ? [...e.chunk_ids] : [] });
    prior.set(pk, list);
  }
  return { seen, prior };
}
