import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GuardianDecision } from './state.js';

/**
 * Append-only JSONL journal for the cost-guardian loop. Sits
 * alongside the healer journal under `~/.llamactl/healer/`. Every
 * tick — even `noop` ones — writes a line so operators can graph
 * spend + decision frequency over time.
 *
 * Env override: `$LLAMACTL_COST_JOURNAL`.
 */

export interface CostJournalTickEntry {
  kind: 'tick';
  decision: GuardianDecision;
}

export interface CostJournalActionEntry {
  kind: 'action';
  ts: string;
  /** Which tier's action was attempted — distinct from
   *  `decision.tier` because a single decision might dispatch
   *  multiple actions (webhook + embersynth flip) that each warrant
   *  their own audit line. */
  action:
    | 'webhook'
    | 'force-private'
    | 'force-private-wet'
    | 'deregister-dry-run'
    | 'deregister-wet'
    | 'deregister-refused';
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export interface CostJournalErrorEntry {
  kind: 'error';
  ts: string;
  message: string;
}

export type CostJournalEntry =
  | CostJournalTickEntry
  | CostJournalActionEntry
  | CostJournalErrorEntry;

export function defaultCostJournalPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LLAMACTL_COST_JOURNAL?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'healer', 'cost-journal.jsonl');
}

export function appendCostJournal(
  entry: CostJournalEntry,
  path: string = defaultCostJournalPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
