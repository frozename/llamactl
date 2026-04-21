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

export interface Journal {
  /** Append a single entry as a single JSON line. */
  append(entry: JournalEntry): Promise<void>;
  /**
   * True if `{source, doc_id, sha}` was already ingested in any past
   * run recorded in this journal file.
   */
  seen(source: string, doc_id: string, sha: string): Promise<boolean>;
  close(): Promise<void>;
}

function key(source: string, doc_id: string, sha: string): string {
  return `${source}\u0000${doc_id}\u0000${sha}`;
}

export async function openJournal(path: string): Promise<Journal> {
  await mkdir(dirname(path), { recursive: true });

  const seenSet = await loadSeenSet(path);

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
      }
    },
    async seen(source, doc_id, sha) {
      return seenSet.has(key(source, doc_id, sha));
    },
    async close() {
      // No resources held between calls — appendFile opens/closes
      // per call. Keeping the method in the contract so a future
      // batched-writer swap doesn't reshape the API.
    },
  };
}

async function loadSeenSet(path: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First run — ensure the file exists so subsequent open() calls
      // take the happy path and the file shows up in `ls` for the
      // operator.
      await writeFile(path, '', 'utf8');
      return new Set();
    }
    throw err;
  }
  const set = new Set<string>();
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
      typeof e.source === 'string' &&
      typeof e.doc_id === 'string' &&
      typeof e.sha === 'string'
    ) {
      set.add(key(e.source, e.doc_id, e.sha));
    }
  }
  return set;
}
