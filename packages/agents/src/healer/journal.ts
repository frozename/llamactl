import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProbeReport } from './probe.js';

/**
 * Append-only JSONL journal for the healer loop. One record per tick
 * (or per observed state transition when the loop runs in silent-
 * steady-state mode). Sits alongside the MCP audit sink so an
 * operator has one place to look for "what did the autonomous
 * machinery do on my fleet."
 */

export interface JournalTickEntry {
  kind: 'tick';
  ts: string;
  report: ProbeReport;
  /**
   * Which probe path produced the report: `'nova'` means the in-proc
   * `nova.ops.healthcheck` facade; `'direct'` means raw `probeFleet`
   * (either the legacy path or a fallback after the facade failed).
   */
  source: 'nova' | 'direct';
}

export interface JournalTransitionEntry {
  kind: 'transition';
  ts: string;
  name: string;
  resourceKind: 'gateway' | 'provider';
  from: string;
  to: string;
}

export interface JournalErrorEntry {
  kind: 'error';
  ts: string;
  message: string;
}

export type JournalEntry =
  | JournalTickEntry
  | JournalTransitionEntry
  | JournalErrorEntry;

export function defaultHealerJournalPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_HEALER_JOURNAL?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'healer', 'journal.jsonl');
}

export function appendHealerJournal(
  entry: JournalEntry,
  path: string = defaultHealerJournalPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
