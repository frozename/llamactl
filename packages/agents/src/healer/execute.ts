import { runRunbook } from '../harness.js';
import { RUNBOOKS } from '../runbooks/index.js';
import type { RunbookToolClient } from '../types.js';
import type { PlanLike, PlanStepLike } from './severity.js';

/**
 * Plan execution for the healer loop. Dispatches each step to either
 * a runbook (when `step.tool` matches the `RUNBOOKS` registry) or a
 * raw MCP tool via the supplied tool client. Sequential only — stops
 * at the first `{ok: false}` so a half-applied plan doesn't pile more
 * damage on top of a failure. Every error is caught internally and
 * surfaced as an `{ok: false, error}` envelope so the loop always
 * gets a complete step record for the journal.
 */

export type StepOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export interface ExecuteStepOptions {
  toolClient: RunbookToolClient;
  /** When true, runbook steps run in dry-run mode. Default false —
   *  the healer's auto-execution path only reaches this point after
   *  the severity gate has already decided the plan is safe to apply. */
  dryRun?: boolean;
  /** Optional logger for runbook chatter. stderr-bound by default. */
  log?: (message: string) => void;
}

export interface ExecutePlanResult {
  steps: Array<{ index: number; tool: string; outcome: StepOutcome }>;
  /** Index of the step that stopped the run, if any. Undefined when
   *  every step returned `ok: true`. */
  stoppedAt?: number;
}

/**
 * Execute a single plan step. Catches every throw internally — the
 * return value is the canonical surface for success/failure.
 */
export async function executePlanStep(
  step: PlanStepLike,
  opts: ExecuteStepOptions,
): Promise<StepOutcome> {
  const dryRun = opts.dryRun ?? false;
  const args = step.args ?? {};
  try {
    if (step.tool in RUNBOOKS) {
      const log = opts.log ?? ((): void => {});
      const result = await runRunbook(step.tool, args as never, {
        toolClient: opts.toolClient,
        dryRun,
        log,
      });
      if (result.ok) return { ok: true, result };
      return { ok: false, error: result.error ?? 'runbook reported failure' };
    }
    // The MCP SDK's default request timeout is 60s. Composite-apply
    // runs readiness polling against K8s (`readinessTimeoutMs`
    // default 60s on the KubernetesBackend), so the two budgets
    // collide exactly and the tool call times out client-side even
    // when the apply itself is progressing. Healer remediations can't
    // race these: bump the per-tool budget to 5m so slow image pulls
    // and readiness waits don't mask successful recoveries.
    const raw = await opts.toolClient.callTool(
      { name: step.tool, arguments: args },
      undefined,
      { timeout: 300_000, resetTimeoutOnProgress: true },
    );
    const envelope = raw as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    if (envelope?.isError === true) {
      const first = envelope.content?.[0];
      const msg =
        first && first.type === 'text' && typeof first.text === 'string'
          ? first.text
          : `${step.tool}: tool returned isError`;
      return { ok: false, error: msg.slice(0, 500) };
    }
    return { ok: true, result: raw };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

/**
 * Execute a plan step-by-step. Stops at the first `{ok: false}`,
 * returning the outcomes collected up to and including that step.
 */
export async function executePlan(
  plan: PlanLike,
  opts: ExecuteStepOptions,
): Promise<ExecutePlanResult> {
  const out: ExecutePlanResult['steps'] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const outcome = await executePlanStep(step, opts);
    out.push({ index: i, tool: step.tool, outcome });
    if (!outcome.ok) {
      return { steps: out, stoppedAt: i };
    }
  }
  return { steps: out };
}
