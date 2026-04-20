import { probeFleet, stateTransitions, type ProbeFleetOptions, type ProbeReport } from './probe.js';
import { probeFleetViaNova } from './facade-probe.js';
import { appendHealerJournal, defaultHealerJournalPath, type JournalEntry } from './journal.js';
import type { RunbookToolClient } from '../types.js';

/**
 * Healer loop — the "observe + journal" half of autonomous ops.
 * Remediation actions (auto-promote, flip embersynth to private-first,
 * deregister a noisy provider) land behind their own runbooks once
 * the tool surface carries the mutation primitives needed; today the
 * loop surfaces state with a journal that an operator (or a higher-
 * level agent) consumes.
 */

export interface HealerLoopOptions extends Omit<ProbeFleetOptions, 'fetch' | 'now'> {
  /** Milliseconds between ticks. Clamped to >= 1000 in the scheduler. */
  intervalMs?: number;
  /** Run one tick, emit one journal entry, return. Default false. */
  once?: boolean;
  /** Override the journal path (tests, non-default deployments). */
  journalPath?: string;
  /**
   * Called after every tick. Lets callers surface progress inline
   * (e.g. CLI prints a one-line summary). Not the primary observation
   * channel — the journal is.
   */
  onTick?: (report: ProbeReport, transitions: ReturnType<typeof stateTransitions>) => void;
  /** Inject fetch / clock for tests. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Injectable journal writer — tests assert against the entries it
   *  receives instead of touching disk. */
  writeJournal?: (entry: JournalEntry, path: string) => void;
  /**
   * Optional MCP tool client. When provided, the loop's primary health
   * signal becomes `nova.ops.healthcheck` routed through this client;
   * if that call rejects or returns `isError`, the loop logs one
   * stderr line and falls back to the raw `probeFleet` path. When
   * omitted, the loop uses raw `probeFleet` only (legacy path).
   */
  toolClient?: RunbookToolClient;
}

export interface HealerLoopHandle {
  /** Ask the loop to stop after the current tick completes. */
  stop(): void;
  /** Resolves when the loop has stopped (or immediately for --once). */
  done: Promise<void>;
}

export function startHealerLoop(opts: HealerLoopOptions): HealerLoopHandle {
  const journalPath = opts.journalPath ?? defaultHealerJournalPath();
  const writeJournal = opts.writeJournal ?? appendHealerJournal;
  const intervalMs = Math.max(1000, opts.intervalMs ?? 30_000);
  let stopped = false;
  let previous: ProbeReport | null = null;

  const runDirectProbe = (): Promise<ProbeReport> =>
    probeFleet({
      kubeconfigPath: opts.kubeconfigPath,
      siriusProvidersPath: opts.siriusProvidersPath,
      timeoutMs: opts.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });

  const done = (async (): Promise<void> => {
    do {
      let report: ProbeReport;
      let source: 'nova' | 'direct' = opts.toolClient ? 'nova' : 'direct';
      try {
        if (opts.toolClient) {
          try {
            report = await probeFleetViaNova(opts.toolClient);
          } catch (err) {
            const msg = (err as Error).message ?? String(err);
            process.stderr.write(
              `healer: facade health call failed: ${msg}; falling back to direct probe\n`,
            );
            source = 'direct';
            report = await runDirectProbe();
          }
        } else {
          report = await runDirectProbe();
        }
      } catch (err) {
        writeJournal(
          {
            kind: 'error',
            ts: new Date((opts.now ?? Date.now)()).toISOString(),
            message: (err as Error).message,
          },
          journalPath,
        );
        if (opts.once) return;
        await sleep(intervalMs);
        continue;
      }

      const transitions = stateTransitions(previous, report);
      for (const t of transitions) {
        writeJournal(
          {
            kind: 'transition',
            ts: report.ts,
            name: t.name,
            resourceKind: t.kind,
            from: t.from,
            to: t.to,
          },
          journalPath,
        );
      }
      writeJournal({ kind: 'tick', ts: report.ts, report, source }, journalPath);
      previous = report;
      opts.onTick?.(report, transitions);

      if (opts.once || stopped) return;
      await sleep(intervalMs);
    } while (!stopped);
  })();

  return {
    stop() {
      stopped = true;
    },
    done,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
