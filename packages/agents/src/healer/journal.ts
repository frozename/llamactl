import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProbeReport } from './probe.js';
import type { PlanLike } from './severity.js';
import type { StepOutcome } from './execute.js';

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
  resourceKind: 'gateway' | 'provider' | 'composite';
  from: string;
  to: string;
}

export interface JournalErrorEntry {
  kind: 'error';
  ts: string;
  message: string;
}

/**
 * Transition record stored on remediation entries. Mirrors the output
 * of `stateTransitions` so downstream tooling (and `--execute
 * <proposal-id>`) can reconstruct the context that triggered the
 * plan.
 *
 * `resourceKind` widens with every new class of signal the loop
 * grows. Today:
 *   - `gateway`   → sirius / embersynth / cloud gateways from kubeconfig
 *   - `provider`  → sirius-providers.yaml OpenAI-compatible backends
 *   - `composite` → Slice-D — `llamactl.composite.list` entries whose
 *                   phase is Degraded/Failed or have a Failed component
 *
 * For composite entries the `from/to` strings carry the composite's
 * phase snapshot (e.g. from `'Ready'` to `'Degraded'`) so the journal
 * trail still reads consistently with gateway/provider transitions.
 */
export interface JournalTransitionSnapshot {
  name: string;
  resourceKind: 'gateway' | 'provider' | 'composite';
  from: string;
  to: string;
}

export interface JournalProposalEntry {
  kind: 'proposal';
  ts: string;
  transition: JournalTransitionSnapshot;
  plan: PlanLike;
  proposalId: string;
  /** Which probe path surfaced the transition — matches the tick
   *  entry's `source` field so operators can correlate. */
  source: 'nova' | 'direct';
}

export interface JournalExecutedEntry {
  kind: 'executed';
  ts: string;
  proposalId: string;
  steps: Array<{ index: number; tool: string; outcome: StepOutcome }>;
  stoppedAt?: number;
}

export type RefusedReason =
  | 'destructive-requires-manual-approval'
  | 'planner-requires-confirmation'
  | 'severity-exceeded';

export interface JournalRefusedEntry {
  kind: 'refused';
  ts: string;
  proposalId: string;
  reason: RefusedReason;
  /** Only set when the refusal was triggered by the severity gate. */
  refusedSteps?: Array<{ index: number; tool: string; tier: 1 | 2 | 3 }>;
}

export interface JournalPlanFailedEntry {
  kind: 'plan-failed';
  ts: string;
  transition: JournalTransitionSnapshot;
  reason: string;
  message: string;
}

export type JournalEntry =
  | JournalTickEntry
  | JournalTransitionEntry
  | JournalErrorEntry
  | JournalProposalEntry
  | JournalExecutedEntry
  | JournalRefusedEntry
  | JournalPlanFailedEntry;

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
