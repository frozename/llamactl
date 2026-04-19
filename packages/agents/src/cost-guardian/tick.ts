import { parseToolJson, type RunbookToolClient } from '../types.js';
import type { CostGuardianConfig } from './config.js';
import {
  appendCostJournal,
  type CostJournalActionEntry,
  type CostJournalTickEntry,
} from './journal.js';
import {
  decideGuardianAction,
  type CostSnapshotSubset,
  type GuardianDecision,
} from './state.js';
import {
  postGuardianWebhook,
  type WebhookFetcher,
} from './webhook.js';

/**
 * One-shot cost-guardian tick. Fetches the daily + (optional)
 * weekly snapshots via `nova.ops.cost.snapshot`, runs the pure
 * state machine, writes the decision to the journal, and — when
 * the decision is non-noop and `config.webhook_url` is set —
 * POSTs the decision JSON to that endpoint. The webhook outcome is
 * appended as an action journal entry.
 *
 * Deferred to follow-up slices: embersynth profile flip
 * (auto_force_private) and sirius dry-run deregister
 * (auto_deregister). The flags parse today but are informational
 * only — we never mutate external state on this path yet.
 */

export interface RunCostGuardianTickOptions {
  tools: RunbookToolClient;
  config: CostGuardianConfig;
  /** Override the journal file path. */
  journalPath?: string;
  /** Clock injection for tests. */
  now?: () => Date;
  /** Skip writing to the journal; useful in the CLI `--skip-journal`
   *  path when the operator just wants to see the decision. */
  skipJournal?: boolean;
  /** Inject a fake fetcher for webhook tests. */
  webhookFetcher?: WebhookFetcher;
  /** Total timeout per webhook attempt. Default 5 s. */
  webhookTimeoutMs?: number;
  /** Set to true to disable the webhook action regardless of
   *  config.webhook_url (useful for a `--no-actions` CLI flag in
   *  future slices). */
  disableWebhook?: boolean;
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
  if (
    !opts.disableWebhook &&
    decision.tier !== 'noop' &&
    opts.config.webhook_url
  ) {
    const webhookResult = await postGuardianWebhook({
      url: opts.config.webhook_url,
      decision,
      ...(opts.webhookFetcher ? { fetcher: opts.webhookFetcher } : {}),
      ...(opts.webhookTimeoutMs !== undefined ? { timeoutMs: opts.webhookTimeoutMs } : {}),
    });
    if (!opts.skipJournal) {
      const action: CostJournalActionEntry = webhookResult.ok
        ? {
            kind: 'action',
            ts: decision.ts,
            action: 'webhook',
            ok: true,
            detail: { status: webhookResult.status },
          }
        : {
            kind: 'action',
            ts: decision.ts,
            action: 'webhook',
            ok: false,
            detail: { status: webhookResult.status },
            error: webhookResult.error,
          };
      appendCostJournal(action, opts.journalPath);
    }
  }
  return decision;
}
