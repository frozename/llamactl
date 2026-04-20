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
 * Tier-2 / tier-3 wet-run escalation: when the corresponding auto
 * flag is set on config (`auto_force_private` / `auto_deregister`)
 * AND the preceding dry-run reported `ok !== false`, the tick
 * follows up with a wet-run (`dryRun: false`). Tier-3 additionally
 * checks `config.protectedProviders` — names on the denylist are
 * never auto-deregistered regardless of the flag, and the refusal is
 * journaled as `deregister-refused`.
 *
 * INVARIANT: tier-3 (deregister) always does a dry-run preview
 * before the wet-run. The preview is journaled regardless. This is
 * the mitigation-of-last-resort against a misconfigured guardian
 * pulling down a production provider unexpectedly — the preview is
 * visible in the cost journal before anything irreversible happens.
 *
 * INVARIANT: names in `config.protectedProviders` can never be
 * auto-deregistered, regardless of `auto_deregister` flag state.
 *
 * INVARIANT: at most one wet-run per tick. If the tier-2 wet-run
 * fails (throws or returns `ok: false`), the tier-3 wet-run is
 * skipped for that tick — preserving the "one action attempt per
 * tick on errors" guarantee.
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
  // Track whether the tier-2 wet-run failed, so the tier-3 branch
  // below can honor the "one action attempt per tick on errors"
  // invariant — a failed force-private wet-run blocks any subsequent
  // tier-3 wet-run in the same tick.
  let tier2WetRunFailed = false;
  // Tier-2 force-private: call llamactl.embersynth.set-default-profile
  // with dryRun:true when the harness has @llamactl/mcp mounted
  // (which the default harness does). The dry-run preview is always
  // journaled. When `config.auto_force_private` is true AND the
  // preview reported `ok !== false`, a wet-run (`dryRun: false`)
  // follows and is journaled separately as `force-private-wet`.
  if (
    !opts.skipJournal &&
    (decision.tier === 'force_private' || decision.tier === 'deregister')
  ) {
    let detail: Record<string, unknown> = {
      autoForcePrivateEnabled: opts.config.auto_force_private === true,
      targetProfile: 'private-first',
      syntheticModel: 'fusion-auto',
    };
    let ok = true;
    let error: string | undefined;
    try {
      const raw = await opts.tools.callTool({
        name: 'llamactl.embersynth.set-default-profile',
        arguments: {
          profile: 'private-first',
          syntheticModel: 'fusion-auto',
          dryRun: true,
        },
      });
      const parsed = parseToolJson<{
        ok?: boolean;
        mode?: string;
        previous?: string | null;
        next?: string;
        unchanged?: boolean;
        reason?: string;
        message?: string;
        availableProfiles?: string[];
      }>(raw);
      detail = {
        ...detail,
        toolInvoked: true,
        mode: parsed.mode ?? null,
        previous: parsed.previous ?? null,
        next: parsed.next ?? null,
        unchanged: parsed.unchanged ?? null,
      };
      if (parsed.ok === false) {
        ok = false;
        error = `${parsed.reason ?? 'unknown'}: ${parsed.message ?? 'no message'}`;
        if (parsed.availableProfiles) {
          detail.availableProfiles = parsed.availableProfiles;
        }
      }
    } catch (err) {
      ok = false;
      error = `llamactl.embersynth.set-default-profile not available — ${(err as Error).message}`;
      detail = {
        ...detail,
        toolInvoked: false,
        note: opts.config.auto_force_private
          ? 'auto_force_private set but harness has no llamactl MCP client — no upstream mutation performed'
          : 'manual operator action required — flip embersynth.yaml fusion-auto to private-first and re-sync',
      };
    }
    const entry: CostJournalActionEntry = {
      kind: 'action',
      ts: decision.ts,
      action: 'force-private',
      ok,
      detail,
      ...(error ? { error } : {}),
    };
    appendCostJournal(entry, opts.journalPath);
    // Tier-2 wet-run escalation: only when the dry-run succeeded and
    // the operator opted in via `auto_force_private`.
    if (ok && opts.config.auto_force_private === true) {
      let wetDetail: Record<string, unknown> = {
        autoForcePrivateEnabled: true,
        targetProfile: 'private-first',
        syntheticModel: 'fusion-auto',
      };
      let wetOk = true;
      let wetError: string | undefined;
      try {
        const raw = await opts.tools.callTool({
          name: 'llamactl.embersynth.set-default-profile',
          arguments: {
            profile: 'private-first',
            syntheticModel: 'fusion-auto',
            dryRun: false,
          },
        });
        const parsed = parseToolJson<{
          ok?: boolean;
          mode?: string;
          previous?: string | null;
          next?: string;
          unchanged?: boolean;
          reason?: string;
          message?: string;
          availableProfiles?: string[];
        }>(raw);
        wetDetail = {
          ...wetDetail,
          toolInvoked: true,
          mode: parsed.mode ?? null,
          previous: parsed.previous ?? null,
          next: parsed.next ?? null,
          unchanged: parsed.unchanged ?? null,
        };
        if (parsed.ok === false) {
          wetOk = false;
          wetError = `${parsed.reason ?? 'unknown'}: ${parsed.message ?? 'no message'}`;
          if (parsed.availableProfiles) {
            wetDetail.availableProfiles = parsed.availableProfiles;
          }
        }
      } catch (err) {
        wetOk = false;
        wetError = `llamactl.embersynth.set-default-profile wet-run failed — ${(err as Error).message}`;
        wetDetail = { ...wetDetail, toolInvoked: false };
      }
      if (!wetOk) tier2WetRunFailed = true;
      const wetEntry: CostJournalActionEntry = {
        kind: 'action',
        ts: decision.ts,
        action: 'force-private-wet',
        ok: wetOk,
        detail: wetDetail,
        ...(wetError ? { error: wetError } : {}),
      };
      appendCostJournal(wetEntry, opts.journalPath);
    }
  }
  // Tier-3 deregister-dry-run: call sirius.providers.deregister
  // with dryRun:true when the harness has the tool mounted. When
  // the tool isn't in the client's catalog (or the call fails) we
  // still journal the intent with the failure reason, so an
  // operator sees every tier-3 tick. The dry-run always runs; a
  // follow-up wet-run (`dryRun: false`) is gated on
  // `config.auto_deregister` AND the dry-run succeeding AND the
  // tier-2 wet-run not having failed this tick. Protected names in
  // `config.protectedProviders` are journaled as `deregister-refused`
  // and never auto-deregistered, regardless of the auto flag.
  if (
    !opts.skipJournal &&
    decision.tier === 'deregister' &&
    decision.deregisterTarget
  ) {
    const provider = decision.deregisterTarget;
    let detail: Record<string, unknown> = {
      provider,
      autoDeregisterEnabled: opts.config.auto_deregister === true,
    };
    let ok = true;
    let error: string | undefined;
    try {
      const raw = await opts.tools.callTool({
        name: 'sirius.providers.deregister',
        arguments: { name: provider, dryRun: true },
      });
      const parsed = parseToolJson<{
        ok?: boolean;
        mode?: string;
        wasPresent?: boolean;
        remainingCount?: number;
        reason?: string;
        message?: string;
      }>(raw);
      detail = {
        ...detail,
        toolInvoked: true,
        mode: parsed.mode ?? null,
        wasPresent: parsed.wasPresent ?? null,
        remainingCount: parsed.remainingCount ?? null,
      };
      if (parsed.ok === false) {
        ok = false;
        error = `${parsed.reason ?? 'unknown'}: ${parsed.message ?? 'no message'}`;
      }
    } catch (err) {
      ok = false;
      error = `sirius.providers.deregister not available — ${(err as Error).message}`;
      detail = {
        ...detail,
        toolInvoked: false,
        note: opts.config.auto_deregister
          ? 'auto_deregister set but the harness has no sirius MCP client — no upstream mutation performed'
          : 'manual operator action required — review journal + run the deregister verb yourself',
      };
    }
    const entry: CostJournalActionEntry = {
      kind: 'action',
      ts: decision.ts,
      action: 'deregister-dry-run',
      ok,
      detail,
      ...(error ? { error } : {}),
    };
    appendCostJournal(entry, opts.journalPath);
    // Tier-3 wet-run escalation — gated by auto flag, dry-run
    // success, and the tier-2 wet-run outcome. The protectedProviders
    // denylist runs before the wet-run and overrides the auto flag.
    if (ok && opts.config.auto_deregister === true && !tier2WetRunFailed) {
      const protectedProviders = opts.config.protectedProviders ?? [];
      if (protectedProviders.includes(provider)) {
        const refused: CostJournalActionEntry = {
          kind: 'action',
          ts: decision.ts,
          action: 'deregister-refused',
          ok: true,
          detail: {
            reason: 'provider-protected',
            provider,
            protectedProviders,
          },
        };
        appendCostJournal(refused, opts.journalPath);
      } else {
        let wetDetail: Record<string, unknown> = {
          provider,
          autoDeregisterEnabled: true,
        };
        let wetOk = true;
        let wetError: string | undefined;
        try {
          const raw = await opts.tools.callTool({
            name: 'sirius.providers.deregister',
            arguments: { name: provider, dryRun: false },
          });
          const parsed = parseToolJson<{
            ok?: boolean;
            mode?: string;
            wasPresent?: boolean;
            remainingCount?: number;
            reason?: string;
            message?: string;
          }>(raw);
          wetDetail = {
            ...wetDetail,
            toolInvoked: true,
            mode: parsed.mode ?? null,
            wasPresent: parsed.wasPresent ?? null,
            remainingCount: parsed.remainingCount ?? null,
          };
          if (parsed.ok === false) {
            wetOk = false;
            wetError = `${parsed.reason ?? 'unknown'}: ${parsed.message ?? 'no message'}`;
          }
        } catch (err) {
          wetOk = false;
          wetError = `sirius.providers.deregister wet-run failed — ${(err as Error).message}`;
          wetDetail = { ...wetDetail, toolInvoked: false };
        }
        const wetEntry: CostJournalActionEntry = {
          kind: 'action',
          ts: decision.ts,
          action: 'deregister-wet',
          ok: wetOk,
          detail: wetDetail,
          ...(wetError ? { error: wetError } : {}),
        };
        appendCostJournal(wetEntry, opts.journalPath);
      }
    }
  }
  return decision;
}
