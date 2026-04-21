/**
 * RAG pipeline scheduler. Wakes up every `tickIntervalMs` milliseconds,
 * enumerates pipelines whose manifest declares a `schedule:` field, and
 * fires `runPipeline` for any whose next-scheduled timestamp has
 * arrived. Patterned after the healer loop (`packages/agents/src/
 * healer/loop.ts`) — same `{ stop, done }` handle, same `--once`
 * test escape hatch, same injection points for `now()` + I/O seams.
 *
 * Concurrency: one wet run per pipeline at a time. If a pipeline is
 * still ingesting when its next tick arrives, we skip the fire and
 * journal a `schedule-skipped` entry. The scheduler itself is a
 * single-threaded loop — multiple pipelines that come due on the same
 * tick fire in sequence, not in parallel, so a runaway crawl can't
 * starve the scheduler.
 */

import type { RunSummary } from './runtime.js';
import type { RagPipelineManifest } from './schema.js';
import type { PipelineRecord } from './store.js';
import { listPipelines, writeLastRun, journalPathFor } from './store.js';
import { openJournal, type JournalEntry } from './journal.js';
import { runPipeline } from './runtime.js';

/**
 * Compute the timestamp of the next scheduled run for a manifest
 * given its prior run. Returns `null` when the schedule is absent or
 * unparseable — callers treat null as "do not auto-run."
 *
 * Anchoring rules:
 *   - `@hourly` / `@daily` / `@weekly` are wall-clock anchored (top of
 *     the hour, midnight UTC, Sunday midnight UTC). Missing a window
 *     fires once at the next tick; we never backfill.
 *   - `@every N<unit>` is run-relative. First run (no prior) fires
 *     immediately; subsequent runs fire `N<unit>` after the last run.
 */
export function nextRunAt(
  schedule: string | undefined,
  lastRunAtMs: number | null,
  now: number,
): number | null {
  if (!schedule) return null;
  const trimmed = schedule.trim();
  if (trimmed === '@hourly') {
    return nextBoundary(now, 60 * 60 * 1000);
  }
  if (trimmed === '@daily') {
    return nextBoundary(now, 24 * 60 * 60 * 1000);
  }
  if (trimmed === '@weekly') {
    // Sunday-at-midnight UTC cycle. Anchor to epoch Sunday
    // (1970-01-04T00:00:00Z) so the math is stable.
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const SUNDAY_EPOCH = Date.UTC(1970, 0, 4);
    const sinceAnchor = now - SUNDAY_EPOCH;
    const next = SUNDAY_EPOCH + Math.ceil(sinceAnchor / WEEK) * WEEK;
    return next > now ? next : next + WEEK;
  }
  const m = trimmed.match(/^@every\s+(\d+)([mhd])$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const step =
      unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    if (step <= 0) return null;
    // First run (no prior) fires right away; otherwise `lastRunAt + step`.
    if (lastRunAtMs === null) return now;
    return lastRunAtMs + step;
  }
  return null;
}

function nextBoundary(now: number, periodMs: number): number {
  const next = Math.ceil(now / periodMs) * periodMs;
  return next > now ? next : next + periodMs;
}

export interface PipelineSchedulerOptions {
  /** Milliseconds between scheduler ticks. Clamped to >= 5000. */
  tickIntervalMs?: number;
  /** Run one tick and return. Default false. */
  once?: boolean;
  /** Emit a line to stderr on each tick? Default false. */
  verbose?: boolean;
  /** Injected clock — tests drive time forward deterministically. */
  now?: () => number;
  /**
   * Injection seams — tests replace these to avoid touching disk or
   * starting real ingestions. Defaults wire the real store + runtime.
   */
  listPipelines?: () => PipelineRecord[];
  runPipeline?: (manifest: RagPipelineManifest, journalPath: string) => Promise<RunSummary>;
  writeLastRun?: (name: string, summary: RunSummary) => void;
  journalPathFor?: (name: string) => string;
  /**
   * Called after every tick with the list of pipelines the scheduler
   * considered. Useful for CLI status lines + tests that want to
   * observe tick cadence without tailing the journal.
   */
  onTick?: (report: TickReport) => void;
  env?: NodeJS.ProcessEnv;
}

export interface PipelineSchedulerHandle {
  /** Ask the loop to stop after the current tick completes. */
  stop(): void;
  /** Resolves when the loop has stopped (or immediately for --once). */
  done: Promise<void>;
}

export interface TickReport {
  ts: string;
  /** Pipelines the scheduler saw this tick (excluding those with no schedule). */
  considered: number;
  /** Pipelines actually fired this tick. */
  fired: string[];
  /** Pipelines due-but-skipped because a previous run is still in flight. */
  skippedInFlight: string[];
  /** Parse errors for pipelines whose schedule string failed nextRunAt. */
  unparseable: string[];
}

/**
 * Journal entries the scheduler appends to each pipeline's own
 * `journal.jsonl`. Sharing the file with the runtime's entries keeps
 * a single linear audit trail per pipeline — `llamactl rag pipeline
 * logs <name>` surfaces both scheduler ticks and runtime events in
 * order.
 */
export type SchedulerJournalEntry =
  | {
      kind: 'schedule-fired';
      ts: string;
      schedule: string;
      next_at: string;
    }
  | {
      kind: 'schedule-skipped';
      ts: string;
      reason: 'in-flight' | 'schedule-unparseable';
      schedule: string;
    };

// SchedulerJournalEntry is additive to the runtime's JournalEntry —
// kept as a separate type alias since the runtime doesn't care about
// these entries, only the CLI's log tail does.

export function startPipelineScheduler(
  opts: PipelineSchedulerOptions = {},
): PipelineSchedulerHandle {
  const tickMs = Math.max(5_000, opts.tickIntervalMs ?? 60_000);
  const now = opts.now ?? Date.now;
  const list = opts.listPipelines ?? (() => listPipelines(opts.env));
  const write = opts.writeLastRun ?? ((name, summary) => writeLastRun(name, summary, opts.env));
  const journalPath =
    opts.journalPathFor ?? ((name: string) => journalPathFor(name, opts.env));
  const run =
    opts.runPipeline ??
    (async (manifest, path) => runPipeline({ manifest, journalPath: path }));

  let stopped = false;
  const inFlight = new Set<string>();

  const done = (async (): Promise<void> => {
    do {
      const nowMs = now();
      const ts = new Date(nowMs).toISOString();
      const fired: string[] = [];
      const skippedInFlight: string[] = [];
      const unparseable: string[] = [];
      let considered = 0;

      let records: PipelineRecord[] = [];
      try {
        records = list();
      } catch (err) {
        if (opts.verbose) {
          process.stderr.write(
            `rag-pipeline-scheduler: listPipelines failed: ${toMessage(err)}\n`,
          );
        }
      }

      for (const rec of records) {
        const schedule = rec.manifest.spec.schedule;
        if (!schedule) continue;
        considered++;
        const lastAt = rec.lastRun ? Date.parse(rec.lastRun.at) : null;
        const next = nextRunAt(schedule, Number.isFinite(lastAt) ? lastAt : null, nowMs);
        if (next === null) {
          unparseable.push(rec.name);
          await appendSchedulerEntry(journalPath(rec.name), {
            kind: 'schedule-skipped',
            ts,
            reason: 'schedule-unparseable',
            schedule,
          });
          continue;
        }
        if (next > nowMs) continue;
        if (inFlight.has(rec.name)) {
          skippedInFlight.push(rec.name);
          await appendSchedulerEntry(journalPath(rec.name), {
            kind: 'schedule-skipped',
            ts,
            reason: 'in-flight',
            schedule,
          });
          continue;
        }

        inFlight.add(rec.name);
        fired.push(rec.name);
        const nextAfter = nextRunAt(schedule, nowMs, nowMs);
        await appendSchedulerEntry(journalPath(rec.name), {
          kind: 'schedule-fired',
          ts,
          schedule,
          next_at: nextAfter !== null ? new Date(nextAfter).toISOString() : 'unknown',
        });
        // Fire and await — sequential within a tick keeps the scheduler
        // loop single-threaded and predictable. Long-running ingestions
        // don't block future ticks because we release `inFlight` in
        // `finally` and the outer `do-while` loop only sleeps *between*
        // ticks, not during the run.
        try {
          const summary = await run(rec.manifest, journalPath(rec.name));
          write(rec.name, summary);
        } catch (err) {
          if (opts.verbose) {
            process.stderr.write(
              `rag-pipeline-scheduler: run ${rec.name} failed: ${toMessage(err)}\n`,
            );
          }
          // Runtime already journals its own failures; the scheduler's
          // only obligation here is to release the inFlight slot.
        } finally {
          inFlight.delete(rec.name);
        }
      }

      const report: TickReport = {
        ts,
        considered,
        fired,
        skippedInFlight,
        unparseable,
      };
      if (opts.verbose) {
        process.stderr.write(
          `rag-pipeline-scheduler: tick ${ts} considered=${considered} fired=${fired.length} skipped=${skippedInFlight.length}\n`,
        );
      }
      opts.onTick?.(report);

      if (opts.once || stopped) return;
      await sleep(tickMs);
    } while (!stopped);
  })();

  return {
    stop() {
      stopped = true;
    },
    done,
  };
}

async function appendSchedulerEntry(
  path: string,
  entry: SchedulerJournalEntry,
): Promise<void> {
  try {
    const j = await openJournal(path);
    // Scheduler entries piggyback on the runtime's journal; the
    // runtime's JournalEntry union doesn't list them, so we cast.
    // The on-disk JSON shape is unchanged — readers that don't know
    // the new `kind` values will tolerate them (the `logs` tailer
    // just prints the JSON as-is).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await j.append(entry as unknown as JournalEntry);
    await j.close();
  } catch {
    // Journal failures are non-fatal — we continue the tick so one
    // broken pipeline doesn't freeze the scheduler.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
