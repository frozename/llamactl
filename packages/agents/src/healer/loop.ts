import type { RunbookToolClient } from "../types.js";

import {
  type CompositeSummary,
  fetchComposites,
  formatCompositeReason,
  shouldRemediateComposite,
} from "./composites.js";
import { executePlan } from "./execute.js";
import { probeFleetViaNova } from "./facade-probe.js";
import {
  appendHealerJournal,
  defaultHealerJournalPath,
  type JournalEntry,
  type JournalProposalEntry,
  type JournalTransitionSnapshot,
} from "./journal.js";
import {
  probeFleet,
  type ProbeFleetOptions,
  type ProbeReport,
  type ProbeState,
  stateTransitions,
} from "./probe.js";
import { askPlanner, buildGoal, proposalId, type Transition } from "./remediation.js";
import { gatePlan, type PlanLike, type Tier } from "./severity.js";

/**
 * Healer loop — the "observe + journal" half of autonomous ops.
 * Remediation actions (auto-promote, flip embersynth to private-first,
 * deregister a noisy provider) land behind their own runbooks once
 * the tool surface carries the mutation primitives needed; today the
 * loop surfaces state with a journal that an operator (or a higher-
 * level agent) consumes.
 */

export interface HealerLoopOptions extends Omit<ProbeFleetOptions, "fetch" | "now"> {
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
  /** Inject sleep for tests. The clamped intervalMs is passed through.
   *  When omitted, production defaults to real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
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
  mode?: "propose" | "auto";
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
  const mode: "propose" | "auto" = opts.mode ?? "propose";
  const severityThreshold: Tier = opts.severityThreshold ?? 2;
  const sleepFn: (ms: number) => Promise<void> =
    opts.sleep ??
    ((ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let stopped = false;
  let previous: ProbeReport | null = null;
  const previousCompositeRemediation = new Map<string, boolean>();

  const runDirectProbe = (): Promise<ProbeReport> =>
    probeFleet({
      kubeconfigPath: opts.kubeconfigPath,
      siriusProvidersPath: opts.siriusProvidersPath,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });

  // Acquire one probe report, preferring the nova facade and falling
  // back to the direct probe when the facade call fails. Direct-probe
  // failures propagate to the caller.
  const acquireReport = async (): Promise<{ report: ProbeReport; source: "nova" | "direct" }> => {
    const toolClient = opts.toolClient;
    if (!toolClient) return { report: await runDirectProbe(), source: "direct" };
    try {
      return { report: await probeFleetViaNova(toolClient), source: "nova" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `healer: facade health call failed: ${msg}; falling back to direct probe\n`,
      );
      return { report: await runDirectProbe(), source: "direct" };
    }
  };

  const writeEntry = (entry: JournalEntry): void => {
    writeJournal(entry, journalPath);
  };

  const writeTickError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    try {
      writeEntry({
        kind: "error",
        ts: new Date((opts.now ?? Date.now)()).toISOString(),
        message,
      });
    } catch {
      try {
        process.stderr.write(`healer: failed to write tick error journal entry: ${message}\n`);
      } catch {
        // Best-effort only.
      }
    }
  };

  const journalProbeError = (err: unknown): void => {
    writeEntry({
      kind: "error",
      ts: new Date((opts.now ?? Date.now)()).toISOString(),
      message: (err as Error).message,
    });
  };

  const runTick = async (): Promise<"stop" | "continue"> => {
    let acquired: { report: ProbeReport; source: "nova" | "direct" };
    try {
      acquired = await acquireReport();
    } catch (err) {
      journalProbeError(err);
      return opts.once ? "stop" : "continue";
    }
    const { report, source } = acquired;

    const transitions = stateTransitions(previous, report);
    journalTransitions(transitions, report.ts, writeEntry);
    writeEntry({ kind: "tick", ts: report.ts, report, source });
    previous = report;
    opts.onTick?.(report, transitions);

    // Remediation path — propose on every healthy→unhealthy/degraded
    // flip. Only fires when a toolClient is wired (the planner lives
    // under nova-mcp); operators running without the facade skip this
    // block entirely. The scheduler is sequential, so a long-running
    // executePlan completes before the loop sleeps and starts the next tick.
    if (opts.toolClient) {
      await runRemediations({
        toolClient: opts.toolClient,
        transitions,
        source,
        mode,
        severityThreshold,
        writeJournal: writeEntry,
        ...(opts.onProposal !== undefined ? { onProposal: opts.onProposal } : {}),
        prevCompositeRemediation: previousCompositeRemediation,
      });
    }

    return opts.once || stopped ? "stop" : "continue";
  };

  const done = (async (): Promise<void> => {
    for (;;) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Mutated through the returned handle between awaited ticks.
      if (stopped) return;
      let outcome: "stop" | "continue";
      try {
        outcome = await runTick();
      } catch (err) {
        writeTickError(err);
        outcome = opts.once ? "stop" : "continue";
      }
      if (outcome === "stop") return;
      await sleepFn(intervalMs);
    }
  })();

  return {
    stop(): void {
      stopped = true;
    },
    done,
  };
}

function journalTransitions(
  transitions: ReturnType<typeof stateTransitions>,
  ts: string,
  writeEntry: (entry: JournalEntry) => void,
): void {
  for (const t of transitions) {
    writeEntry({
      kind: "transition",
      ts,
      name: t.name,
      resourceKind: t.kind,
      from: t.from,
      to: t.to,
    });
  }
}

async function runRemediations(opts: RemediateOptions): Promise<void> {
  await remediate(opts);
  // Slice D — composite remediation. Runs on the same tick as
  // probe remediation and shares the propose/auto gating. Any
  // composite in Degraded/Failed (or with a Failed component)
  // gets a hardcoded tier-2 `llamactl.composite.apply` plan
  // emitted against the journal, with the same executePlan +
  // severity-gate path as the planner-produced variants.
  await remediateComposites({
    toolClient: opts.toolClient,
    source: opts.source,
    mode: opts.mode,
    severityThreshold: opts.severityThreshold,
    writeJournal: opts.writeJournal,
    ...(opts.onProposal !== undefined ? { onProposal: opts.onProposal } : {}),
    prevRemediation: opts.prevCompositeRemediation,
  });
}

/** Predicate: which probe-state flips should trigger a remediation
 *  plan? Only fires on `healthy → unhealthy` or first-seen
 *  `unknown → unhealthy`; persistent unhealthy ticks are not
 *  re-proposed because `stateTransitions` only emits on actual flips. */
function shouldRemediate(from: ProbeState | "unknown", to: ProbeState): boolean {
  if (from === to) return false;
  if (to !== "unhealthy") return false;
  // Only propose on the flip out of healthy (or first-seen unknown).
  return from === "healthy" || from === "unknown";
}

interface RemediateOptions {
  toolClient: RunbookToolClient;
  transitions: ReturnType<typeof stateTransitions>;
  source: "nova" | "direct";
  mode: "propose" | "auto";
  severityThreshold: Tier;
  writeJournal: (entry: JournalEntry) => void;
  onProposal?: (entry: JournalProposalEntry) => void;
  prevCompositeRemediation: Map<string, boolean>;
}

async function remediate(opts: RemediateOptions): Promise<void> {
  for (const t of opts.transitions) {
    if (!shouldRemediate(t.from, t.to)) continue;
    await remediateTransition(opts, t);
  }
}

async function remediateTransition(opts: RemediateOptions, t: Transition): Promise<void> {
  const snapshot: JournalTransitionSnapshot = {
    name: t.name,
    resourceKind: t.kind,
    from: t.from,
    to: t.to,
  };
  const goal = buildGoal(t);
  const ask = await askPlanner(opts.toolClient, goal);
  const ts = new Date().toISOString();
  if (!ask.ok) {
    opts.writeJournal({
      kind: "plan-failed",
      ts,
      transition: snapshot,
      reason: ask.reason,
      message: ask.message,
    });
    return;
  }

  const id = proposalId(ask.plan);
  const proposal: JournalProposalEntry = {
    kind: "proposal",
    ts,
    transition: snapshot,
    plan: ask.plan,
    proposalId: id,
    source: opts.source,
  };
  opts.writeJournal(proposal);
  opts.onProposal?.(proposal);

  if (opts.mode === "propose") return;

  await autoExecutePlan(opts, ask.plan, id);
}

/** Auto mode — confirmation flag + severity gate, then execution. */
async function autoExecutePlan(opts: RemediateOptions, plan: PlanLike, id: string): Promise<void> {
  // Planner-owned confirmation flag is absolute.
  if (plan.requiresConfirmation) {
    opts.writeJournal({
      kind: "refused",
      ts: new Date().toISOString(),
      proposalId: id,
      reason: "planner-requires-confirmation",
    });
    return;
  }

  // Severity gate. If the plan has any tier-3 step, refuse with
  // the destructive-specific reason regardless of threshold.
  const gate = gatePlan(plan, opts.severityThreshold);
  if (!gate.allowed) {
    const hasDestructive = gate.refusedSteps.some((s) => s.tier === 3);
    opts.writeJournal({
      kind: "refused",
      ts: new Date().toISOString(),
      proposalId: id,
      reason: hasDestructive ? "destructive-requires-manual-approval" : "severity-exceeded",
      refusedSteps: gate.refusedSteps,
    });
    return;
  }

  const exec = await executePlan(plan, {
    toolClient: opts.toolClient,
    dryRun: false,
  });
  const executed = {
    kind: "executed" as const,
    ts: new Date().toISOString(),
    proposalId: id,
    steps: exec.steps,
    ...(exec.stoppedAt !== undefined ? { stoppedAt: exec.stoppedAt } : {}),
  };
  opts.writeJournal(executed);
}

interface RemediateCompositesOptions {
  toolClient: RunbookToolClient;
  source: "nova" | "direct";
  mode: "propose" | "auto";
  severityThreshold: Tier;
  writeJournal: (entry: JournalEntry) => void;
  onProposal?: (entry: JournalProposalEntry) => void;
  prevRemediation: Map<string, boolean>;
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
        tool: "llamactl.composite.apply",
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

async function remediateComposites(opts: RemediateCompositesOptions): Promise<void> {
  let composites: CompositeSummary[];
  try {
    composites = await fetchComposites(opts.toolClient);
  } catch (err) {
    // Journal as a plan-failed entry keyed against a synthetic
    // "composite-list" transition so the operator sees the loop
    // tried + failed; then continue. Mirrors how the probe path
    // journals its own fetch failures as `error` entries.
    opts.writeJournal({
      kind: "plan-failed",
      ts: new Date().toISOString(),
      transition: {
        name: "*",
        resourceKind: "composite",
        from: "unknown",
        to: "unknown",
      },
      reason: "composite-list-failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const seenThisTick = new Set<string>();
  for (const summary of composites) {
    seenThisTick.add(summary.name);
    const needsRemediation = shouldRemediateComposite(summary);
    const wasRemediatable = opts.prevRemediation.get(summary.name) ?? false;
    opts.prevRemediation.set(summary.name, needsRemediation);
    // Transition-gate: only act on the first tick the composite enters
    // a remediatable state, not on every subsequent tick it remains there.
    if (!needsRemediation || wasRemediatable) continue;
    await remediateOneComposite(summary, opts);
  }

  // Expire map entries for composites absent from this tick so that
  // a composite that disappears and re-appears degraded fires again.
  expireAbsentComposites(seenThisTick, opts.prevRemediation);
}

function expireAbsentComposites(
  seenThisTick: Set<string>,
  prevRemediation: Map<string, boolean>,
): void {
  for (const name of [...prevRemediation.keys()]) {
    if (!seenThisTick.has(name)) prevRemediation.delete(name);
  }
}

async function remediateOneComposite(
  summary: CompositeSummary,
  opts: RemediateCompositesOptions,
): Promise<void> {
  const snapshot: JournalTransitionSnapshot = {
    name: summary.name,
    resourceKind: "composite",
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
    kind: "proposal",
    ts: new Date().toISOString(),
    transition: snapshot,
    plan,
    proposalId: id,
    source: opts.source,
  };
  opts.writeJournal(proposal);
  opts.onProposal?.(proposal);

  if (opts.mode === "propose") return;

  // Severity gate — tier-2 by construction, so the default
  // threshold (2) allows it and `--severity-threshold=1` refuses
  // it. The `requiresConfirmation:false` flag on the plan means
  // the planner-confirmation short-circuit in `gatePlan` doesn't
  // trip here.
  const gate = gatePlan(plan, opts.severityThreshold);
  if (!gate.allowed) {
    opts.writeJournal({
      kind: "refused",
      ts: new Date().toISOString(),
      proposalId: id,
      reason: "severity-exceeded",
      refusedSteps: gate.refusedSteps,
    });
    return;
  }

  const exec = await executePlan(plan, {
    toolClient: opts.toolClient,
    dryRun: false,
  });
  opts.writeJournal({
    kind: "executed" as const,
    ts: new Date().toISOString(),
    proposalId: id,
    steps: exec.steps,
    ...(exec.stoppedAt !== undefined ? { stoppedAt: exec.stoppedAt } : {}),
  });
}
