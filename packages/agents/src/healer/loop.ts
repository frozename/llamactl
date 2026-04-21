import { probeFleet, stateTransitions, type ProbeFleetOptions, type ProbeReport, type ProbeState } from './probe.js';
import { probeFleetViaNova } from './facade-probe.js';
import {
  appendHealerJournal,
  defaultHealerJournalPath,
  type JournalEntry,
  type JournalProposalEntry,
  type JournalTransitionSnapshot,
} from './journal.js';
import { askPlanner, buildGoal, proposalId, type Transition } from './remediation.js';
import { executePlan } from './execute.js';
import { gatePlan, type Tier, type PlanLike } from './severity.js';
import {
  fetchComposites,
  formatCompositeReason,
  shouldRemediateComposite,
  type CompositeSummary,
} from './composites.js';
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
  /**
   * Remediation mode. In `'propose'` (default) the loop journals the
   * plan and leaves execution to an out-of-band
   * `llamactl heal --execute <proposal-id>`. In `'auto'` the loop
   * executes the plan immediately if the severity gate allows it.
   */
  mode?: 'propose' | 'auto';
  /** Max tier allowed for auto-execution. Default 2 (mutation-dry-run-safe). */
  severityThreshold?: Tier;
  /** Fired after a proposal entry is journaled — lets tests/CLI
   *  surface proposals inline without scraping the JSONL file. */
  onProposal?: (entry: JournalProposalEntry) => void;
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
  const mode: 'propose' | 'auto' = opts.mode ?? 'propose';
  const severityThreshold: Tier = opts.severityThreshold ?? 2;
  let stopped = false;
  let previous: ProbeReport | null = null;
  let tickInFlight = false;

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

      // Remediation path — propose on every healthy→unhealthy/degraded
      // flip. Only fires when a toolClient is wired (the planner lives
      // under nova-mcp); operators running without the facade skip this
      // block entirely. Wrapped in a "tick in progress" guard so a
      // long-running executePlan never interleaves with the next tick
      // that setInterval/sleep would otherwise schedule under it.
      if (opts.toolClient && !tickInFlight) {
        tickInFlight = true;
        try {
          await remediate({
            toolClient: opts.toolClient,
            transitions,
            source,
            mode,
            severityThreshold,
            writeJournal: (entry) => writeJournal(entry, journalPath),
            onProposal: opts.onProposal,
          });
          // Slice D — composite remediation. Runs on the same tick as
          // probe remediation and shares the propose/auto gating. Any
          // composite in Degraded/Failed (or with a Failed component)
          // gets a hardcoded tier-2 `llamactl.composite.apply` plan
          // emitted against the journal, with the same executePlan +
          // severity-gate path as the planner-produced variants.
          await remediateComposites({
            toolClient: opts.toolClient,
            source,
            mode,
            severityThreshold,
            writeJournal: (entry) => writeJournal(entry, journalPath),
            onProposal: opts.onProposal,
          });
        } finally {
          tickInFlight = false;
        }
      }

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

/** Predicate: which probe-state flips should trigger a remediation
 *  plan? Today the `ProbeState` type is just `'healthy' | 'unhealthy'`,
 *  but we accept `'degraded'` as a forward-compatible signal — the
 *  moment the probe layer grows a degraded tier, this predicate picks
 *  it up without further plumbing. Only fires on `healthy → X` or
 *  `unknown → X`; persistent unhealthy ticks are not re-proposed
 *  because `stateTransitions` only emits on actual flips. */
function shouldRemediate(
  from: ProbeState | 'unknown' | 'degraded',
  to: ProbeState | 'degraded',
): boolean {
  if (from === to) return false;
  if (to !== 'unhealthy' && to !== ('degraded' as ProbeState | 'degraded')) return false;
  // Only propose on the flip out of healthy (or first-seen unknown).
  return from === 'healthy' || from === 'unknown';
}

interface RemediateOptions {
  toolClient: RunbookToolClient;
  transitions: ReturnType<typeof stateTransitions>;
  source: 'nova' | 'direct';
  mode: 'propose' | 'auto';
  severityThreshold: Tier;
  writeJournal: (entry: JournalEntry) => void;
  onProposal?: (entry: JournalProposalEntry) => void;
}

async function remediate(opts: RemediateOptions): Promise<void> {
  for (const t of opts.transitions) {
    if (!shouldRemediate(t.from, t.to)) continue;
    const snapshot: JournalTransitionSnapshot = {
      name: t.name,
      resourceKind: t.kind,
      from: t.from,
      to: t.to,
    };
    const goal = buildGoal(t as Transition);
    const ask = await askPlanner(opts.toolClient, goal);
    const ts = new Date().toISOString();
    if (!ask.ok) {
      opts.writeJournal({
        kind: 'plan-failed',
        ts,
        transition: snapshot,
        reason: ask.reason,
        message: ask.message,
      });
      continue;
    }

    const id = proposalId(ask.plan);
    const proposal: JournalProposalEntry = {
      kind: 'proposal',
      ts,
      transition: snapshot,
      plan: ask.plan,
      proposalId: id,
      source: opts.source,
    };
    opts.writeJournal(proposal);
    opts.onProposal?.(proposal);

    if (opts.mode === 'propose') continue;

    // Auto mode — planner-owned confirmation flag is absolute.
    if (ask.plan.requiresConfirmation === true) {
      opts.writeJournal({
        kind: 'refused',
        ts: new Date().toISOString(),
        proposalId: id,
        reason: 'planner-requires-confirmation',
      });
      continue;
    }

    // Severity gate. If the plan has any tier-3 step, refuse with
    // the destructive-specific reason regardless of threshold.
    const gate = gatePlan(ask.plan, opts.severityThreshold);
    const hasDestructive = gate.refusedSteps.some((s) => s.tier === 3);
    if (!gate.allowed) {
      opts.writeJournal({
        kind: 'refused',
        ts: new Date().toISOString(),
        proposalId: id,
        reason: hasDestructive
          ? 'destructive-requires-manual-approval'
          : 'severity-exceeded',
        refusedSteps: gate.refusedSteps,
      });
      continue;
    }

    const exec = await executePlan(ask.plan, {
      toolClient: opts.toolClient,
      dryRun: false,
    });
    const executed = {
      kind: 'executed' as const,
      ts: new Date().toISOString(),
      proposalId: id,
      steps: exec.steps,
      ...(exec.stoppedAt !== undefined ? { stoppedAt: exec.stoppedAt } : {}),
    };
    opts.writeJournal(executed);
  }
}

interface RemediateCompositesOptions {
  toolClient: RunbookToolClient;
  source: 'nova' | 'direct';
  mode: 'propose' | 'auto';
  severityThreshold: Tier;
  writeJournal: (entry: JournalEntry) => void;
  onProposal?: (entry: JournalProposalEntry) => void;
}

/**
 * Build the hardcoded re-apply plan for a degraded composite. Tier-2
 * by design (the severity classifier pins `.apply` at 2); we don't
 * consult the planner here — the remediation is deterministic and the
 * goal ("re-apply this named composite") doesn't benefit from LLM
 * reasoning. `requiresConfirmation:false` because the operator opted
 * into auto-execution by passing `--auto` (a.k.a. `--auto-tier-2`);
 * without that flag the loop falls through to propose-only journaling.
 */
function buildCompositeApplyPlan(summary: CompositeSummary): PlanLike {
  return {
    steps: [
      {
        tool: 'llamactl.composite.apply',
        args: {
          manifestYaml: summary.manifestYaml,
          dryRun: false,
        },
        annotation: `re-apply composite ${summary.name}`,
      },
    ],
    reasoning: formatCompositeReason(summary),
    requiresConfirmation: false,
  };
}

async function remediateComposites(
  opts: RemediateCompositesOptions,
): Promise<void> {
  let composites: CompositeSummary[];
  try {
    composites = await fetchComposites(opts.toolClient);
  } catch (err) {
    // Journal as a plan-failed entry keyed against a synthetic
    // "composite-list" transition so the operator sees the loop
    // tried + failed; then continue. Mirrors how the probe path
    // journals its own fetch failures as `error` entries.
    opts.writeJournal({
      kind: 'plan-failed',
      ts: new Date().toISOString(),
      transition: {
        name: '*',
        resourceKind: 'composite',
        from: 'unknown',
        to: 'unknown',
      },
      reason: 'composite-list-failed',
      message: (err as Error).message ?? String(err),
    });
    return;
  }

  for (const summary of composites) {
    if (!shouldRemediateComposite(summary)) continue;
    const snapshot: JournalTransitionSnapshot = {
      name: summary.name,
      resourceKind: 'composite',
      // `from` isn't tracked across ticks for composites yet — the
      // loop doesn't maintain a prev-phase cache the way it does for
      // gateway/provider probes. Using the current phase on both
      // sides keeps the snapshot honest (no synthetic transition) and
      // still threads into the existing JournalTransitionSnapshot
      // shape so proposal entries stay uniform.
      from: summary.phase,
      to: summary.phase,
    };
    const plan = buildCompositeApplyPlan(summary);
    const id = proposalId(plan);
    const proposal: JournalProposalEntry = {
      kind: 'proposal',
      ts: new Date().toISOString(),
      transition: snapshot,
      plan,
      proposalId: id,
      source: opts.source,
    };
    opts.writeJournal(proposal);
    opts.onProposal?.(proposal);

    if (opts.mode === 'propose') continue;

    // Severity gate — tier-2 by construction, so the default
    // threshold (2) allows it and `--severity-threshold=1` refuses
    // it. The `requiresConfirmation:false` flag on the plan means
    // the planner-confirmation short-circuit in `gatePlan` doesn't
    // trip here.
    const gate = gatePlan(plan, opts.severityThreshold);
    if (!gate.allowed) {
      opts.writeJournal({
        kind: 'refused',
        ts: new Date().toISOString(),
        proposalId: id,
        reason: 'severity-exceeded',
        refusedSteps: gate.refusedSteps,
      });
      continue;
    }

    const exec = await executePlan(plan, {
      toolClient: opts.toolClient,
      dryRun: false,
    });
    const executed = {
      kind: 'executed' as const,
      ts: new Date().toISOString(),
      proposalId: id,
      steps: exec.steps,
      ...(exec.stoppedAt !== undefined ? { stoppedAt: exec.stoppedAt } : {}),
    };
    opts.writeJournal(executed);
  }
}
