/**
 * Orphan-run detection. The in-memory `pipelineEvents` bus loses its
 * state when the agent dies mid-run, so the Pipelines tab would
 * otherwise show the pipeline as "idle" (last-run badge from an
 * earlier state.json) with no hint that something was interrupted.
 *
 * This module scans each pipeline's journal tail for the classic
 * crash signature — a `run-started` entry without a paired
 * `run-complete` or subsequent `run-started` — and when the unpaired
 * start is older than `DEFAULT_STALE_THRESHOLD_MS`, flags the
 * pipeline as having an orphaned run.
 *
 * Callers:
 *   - `ragPipelineRunning` tRPC procedure merges orphan entries with
 *     live ones so the UI sees a unified list.
 *   - UI can render orphan entries distinctly (warning badge +
 *     "clear" action rather than a pulsing in-progress badge).
 *
 * Journal-scan is cheap: we only read the last 200 lines per
 * pipeline and only when `ragPipelineRunning` is called (Pipelines
 * tab polls at 2s). For a 100-pipeline fleet that's ~200 KiB of
 * read per tick — well within budget.
 */

import { existsSync, readFileSync } from 'node:fs';
import { journalPathFor, listPipelines, type PipelineRecord } from './store.js';

export interface OrphanedRun {
  name: string;
  /** ISO timestamp of the unpaired `run-started` entry. */
  startedAt: string;
  /** Source labels the run announced. Empty when the entry's
   *  `sources` field is missing (shouldn't happen for runtime-
   *  written entries, but we tolerate legacy journal lines). */
  sources: string[];
}

/**
 * Runs older than this cutoff with no matching `run-complete` are
 * considered orphaned. Shorter than a cold embedder warmup but
 * longer than any realistic single-file ingest, so transient live
 * runs don't flash as "stale" between 2s polls.
 */
export const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * How many trailing lines to read from each journal when scanning.
 * 200 is enough to catch the last `run-started` for any typical
 * ingestion cadence while bounding the I/O cost. Tune if journals
 * with thousands of events per run become common.
 */
export const JOURNAL_TAIL_LINES = 200;

export interface DetectOrphansOptions {
  /** How old a run-started must be (ms since journal ts) to count
   *  as orphaned. Defaults to `DEFAULT_STALE_THRESHOLD_MS`. */
  staleThresholdMs?: number;
  /** Test-seam: injected clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Test-seam: override the pipeline enumerator. */
  listPipelines?: () => PipelineRecord[];
  /** Test-seam: override per-name journal reader. */
  readJournalTail?: (name: string) => string | null;
  env?: NodeJS.ProcessEnv;
}

export function detectOrphanedRuns(opts: DetectOrphansOptions = {}): OrphanedRun[] {
  const threshold = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const now = opts.now ?? Date.now;
  const list = opts.listPipelines ?? (() => listPipelines(opts.env));
  const readTail =
    opts.readJournalTail ??
    ((name: string): string | null => {
      const path = journalPathFor(name, opts.env);
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf8');
    });

  const out: OrphanedRun[] = [];
  for (const rec of list()) {
    const raw = readTail(rec.name);
    if (!raw) continue;
    const orphan = findTrailingOrphan(raw, threshold, now());
    if (orphan) {
      out.push({
        name: rec.name,
        startedAt: orphan.startedAt,
        sources: orphan.sources,
      });
    }
  }
  return out;
}

interface TrailingOrphan {
  startedAt: string;
  sources: string[];
}

/**
 * Pure parser — given a journal blob, returns the most recent
 * `run-started` entry that has no matching `run-complete` AND is
 * older than `thresholdMs` relative to `nowMs`. Null otherwise.
 *
 * "Matching" = any `run-complete` entry appearing AFTER this
 * `run-started` in the log. A later `run-started` means the previous
 * run was abandoned but a new one was attempted — we only flag the
 * newest unpaired start so the operator sees the live-looking
 * entry, not the chain of prior corruptions.
 *
 * Exported for direct unit-test coverage.
 */
export function findTrailingOrphan(
  journalRaw: string,
  thresholdMs: number,
  nowMs: number,
): TrailingOrphan | null {
  const lines = journalRaw.split('\n');
  // Scan tail-first so we find the newest run-started quickly.
  let lastRunStarted: {
    ts: string;
    sources: string[];
  } | null = null;
  let sawCompleteAfter = false;
  // Walk forward, tracking the most recent run-started + whether a
  // later run-complete paired with it. Bounded tail slice first.
  const tail = lines.slice(Math.max(0, lines.length - JOURNAL_TAIL_LINES));
  for (const line of tail) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      kind?: string;
      ts?: string;
      sources?: unknown;
    };
    if (e.kind === 'run-started' && typeof e.ts === 'string') {
      lastRunStarted = {
        ts: e.ts,
        sources: Array.isArray(e.sources) ? (e.sources as string[]) : [],
      };
      sawCompleteAfter = false;
    } else if (e.kind === 'run-complete') {
      sawCompleteAfter = true;
    }
  }
  if (!lastRunStarted) return null;
  if (sawCompleteAfter) return null;
  const startedMs = Date.parse(lastRunStarted.ts);
  if (!Number.isFinite(startedMs)) return null;
  if (nowMs - startedMs < thresholdMs) return null;
  return { startedAt: lastRunStarted.ts, sources: lastRunStarted.sources };
}
