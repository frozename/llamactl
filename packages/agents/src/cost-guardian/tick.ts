import { parseToolJson, type RunbookToolClient } from '../types.js';
import type { CostGuardianConfig } from './config.js';
import { appendCostJournal, type CostJournalTickEntry } from './journal.js';
import {
  decideGuardianAction,
  type CostSnapshotSubset,
  type GuardianDecision,
} from './state.js';

/**
 * One-shot cost-guardian tick. Fetches the daily + (optional)
 * weekly snapshots via `nova.ops.cost.snapshot`, runs the pure
 * state machine, writes the decision to the journal, returns the
 * decision so a caller (CLI, loop, test) can act on it.
 *
 * Stays action-free: if the decision is `warn`/`force_private`/
 * `deregister`, this tick does NOT POST a webhook, flip embersynth,
 * or touch sirius. Those land in follow-up slices keyed off the
 * emitted decision — a clean seam for the actions layer.
 */

export interface RunCostGuardianTickOptions {
  tools: RunbookToolClient;
  config: CostGuardianConfig;
  /** Override the journal file path. */
  journalPath?: string;
  /** Clock injection for tests. */
  now?: () => Date;
  /** Skip writing to the journal; useful in the CLI `--dry-run`
   *  path when the operator just wants to see the decision. */
  skipJournal?: boolean;
}

export interface GuardianSnapshotPayload {
  totalEstimatedCostUsd?: number;
  windowSince: string;
  windowUntil: string;
  byProvider?: Array<{ key: string; estimatedCostUsd?: number }>;
}

function toSubset(payload: GuardianSnapshotPayload): CostSnapshotSubset {
  const subset: CostSnapshotSubset = {
    windowSince: payload.windowSince,
    windowUntil: payload.windowUntil,
  };
  if (payload.totalEstimatedCostUsd !== undefined) {
    subset.totalEstimatedCostUsd = payload.totalEstimatedCostUsd;
  }
  const top = payload.byProvider?.[0];
  if (top) {
    const topSubset: { key: string; estimatedCostUsd?: number } = {
      key: top.key,
    };
    if (top.estimatedCostUsd !== undefined) {
      topSubset.estimatedCostUsd = top.estimatedCostUsd;
    }
    subset.topProvider = topSubset;
  }
  return subset;
}

export async function runCostGuardianTick(
  opts: RunCostGuardianTickOptions,
): Promise<GuardianDecision> {
  const daily = parseToolJson<GuardianSnapshotPayload>(
    await opts.tools.callTool({
      name: 'nova.ops.cost.snapshot',
      arguments: { days: 1 },
    }),
  );
  const hasWeekly = opts.config.budget.weekly_usd !== undefined;
  const weekly = hasWeekly
    ? parseToolJson<GuardianSnapshotPayload>(
        await opts.tools.callTool({
          name: 'nova.ops.cost.snapshot',
          arguments: { days: 7 },
        }),
      )
    : undefined;
  const decision = decideGuardianAction({
    config: opts.config,
    daily: { snapshot: toSubset(daily) },
    ...(weekly ? { weekly: { snapshot: toSubset(weekly) } } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  if (!opts.skipJournal) {
    const entry: CostJournalTickEntry = { kind: 'tick', decision };
    appendCostJournal(entry, opts.journalPath);
  }
  return decision;
}
