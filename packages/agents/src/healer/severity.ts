import { RUNBOOKS } from '../runbooks/index.js';

/**
 * Numeric safety tier for a tool or runbook name. Used by the healer
 * loop's `--auto` severity gate to decide whether a planner-produced
 * plan is eligible for auto-execution.
 *
 *   1 → read-only (catalog/status/inspect/etc.)
 *   2 → mutation with a dry-run path (promote, sync, reload, ...)
 *   3 → destructive (remove, drain, deregister, uninstall, ...)
 *
 * Parallels the string tiers `harness.ts#inferTier` assigns for the
 * planner allowlist (`read | mutation-dry-run-safe | mutation-
 * destructive`); numeric form is used here because the gate compares
 * `stepTier ≤ severityThreshold` and a numeric ordering is clearer
 * than a string enum ladder. If `harness.ts#inferTier` grows another
 * category, update `tierOf` so the two classifiers stay in sync.
 */
export type Tier = 1 | 2 | 3;

/** Map the harness's string tier onto the numeric one used here. */
function numericFromStringTier(tier: 'read' | 'mutation-dry-run-safe' | 'mutation-destructive'): Tier {
  if (tier === 'read') return 1;
  if (tier === 'mutation-dry-run-safe') return 2;
  return 3;
}

/** Runbook-name overrides. The planner may propose a runbook by name
 *  via the same `tool` field it uses for raw MCP tool calls; those
 *  names won't match the `.verb` suffix heuristics so we classify
 *  them explicitly. */
const RUNBOOK_TIERS: Record<string, Tier> = {
  'drain-node': 3,
  'promote-fastest-vision-model': 2,
  'onboard-new-gpu-node': 2,
  'audit-fleet': 1,
  'cost-snapshot': 1,
};

/** Tier-1 (read-only) verb suffixes. Order matters only in that any
 *  later match falls through; these are checked first since read
 *  tools are the common case. */
const TIER_1_SUFFIXES = [
  '.list',
  '.show',
  '.inspect',
  '.status',
  '.history',
  '.snapshot',
  '.facts',
  '.ls',
  '.healthcheck',
  '.overview',
  '.env',
  '.simulate',
  '.tail',
];

/** Tier-2 (mutation with dry-run path) verb suffixes. */
const TIER_2_SUFFIXES = [
  '.promote',
  '.sync',
  '.set-default-profile',
  '.set',
  '.reload',
  '.add',
  '.apply',
  '.start',
  '.stop',
];

/** Tier-3 (destructive) verb suffixes. */
const TIER_3_SUFFIXES = [
  '.remove',
  '.delete',
  '.drain',
  '.deregister',
  '.destroy',
  '.uninstall',
];

/**
 * Classify a tool (or runbook) name into a numeric tier.
 *
 * Rules, in order:
 *   1. Runbook-name override table (the planner may emit a runbook
 *      name as the `tool` field of a step).
 *   2. Destructive suffixes (tier 3) — checked before tier-2 so a
 *      tool like `foo.remove` never slips into tier 2.
 *   3. Mutation suffixes (tier 2).
 *   4. Read suffixes (tier 1).
 *   5. Unknown → 2 (conservative — assume mutation, which also lines
 *      up with the harness's `inferTier` fallback via `'read'` being
 *      treated as the safe default there but upgraded to "assume
 *      mutation" here since the healer gate must be stricter than the
 *      planner allowlist).
 */
export function tierOf(toolName: string): Tier {
  if (toolName in RUNBOOK_TIERS) return RUNBOOK_TIERS[toolName]!;
  if (toolName in RUNBOOKS) {
    // Runbook registered but not explicitly tiered — assume tier 2.
    return 2;
  }
  for (const suffix of TIER_3_SUFFIXES) {
    if (toolName.includes(suffix)) return 3;
  }
  for (const suffix of TIER_2_SUFFIXES) {
    if (toolName.includes(suffix)) return 2;
  }
  for (const suffix of TIER_1_SUFFIXES) {
    if (toolName.includes(suffix)) return 1;
  }
  return 2;
}

/** Minimal PlanStep shape the severity gate consumes. Matches the
 *  planner's `PlanStep` (see packages/app/src/modules/ops-chat/index.tsx:22-27). */
export interface PlanStepLike {
  tool: string;
  args?: Record<string, unknown>;
  dryRun?: boolean;
  annotation?: string;
}

/** Tier of a single plan step. */
export function stepTier(step: PlanStepLike): Tier {
  return tierOf(step.tool);
}

/** Minimal Plan shape the gate consumes. */
export interface PlanLike {
  steps: PlanStepLike[];
  reasoning: string;
  requiresConfirmation: boolean;
}

export interface GateResult {
  allowed: boolean;
  refusedSteps: Array<{ index: number; tool: string; tier: Tier }>;
}

/**
 * Gate a planner-produced plan against a numeric severity threshold.
 * A plan is only `allowed` when:
 *   - every step's tier ≤ threshold, AND
 *   - `plan.requiresConfirmation === false`.
 *
 * `refusedSteps` surfaces every step that violated the threshold so
 * the healer journal can record exactly which tool names triggered the
 * refusal (operator triage via `llamactl heal --execute <id>`). When
 * only `requiresConfirmation` trips the gate, `refusedSteps` is empty
 * and the caller should record `reason:'planner-requires-confirmation'`.
 */
export function gatePlan(plan: PlanLike, threshold: Tier): GateResult {
  const refusedSteps: GateResult['refusedSteps'] = [];
  plan.steps.forEach((step, index) => {
    const tier = stepTier(step);
    if (tier > threshold) {
      refusedSteps.push({ index, tool: step.tool, tier });
    }
  });
  const thresholdOk = refusedSteps.length === 0;
  const confirmationOk = plan.requiresConfirmation === false;
  return { allowed: thresholdOk && confirmationOk, refusedSteps };
}

/** Shared classifier so the planner allowlist and the healer gate can
 *  agree on "is this tool read-only?". Mirrors `harness.ts#inferTier`
 *  but returns the numeric form. */
export function numericTierFromInferred(
  inferred: 'read' | 'mutation-dry-run-safe' | 'mutation-destructive',
): Tier {
  return numericFromStringTier(inferred);
}
