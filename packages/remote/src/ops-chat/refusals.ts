/**
 * N.4 Phase 3 — goal-pattern refusal heuristic.
 *
 * Short-circuits before the planner ever runs when the operator's
 * goal matches a destructive-intent pattern. Cheap, explainable,
 * greppable — the alternative (asking an LLM to self-police)
 * depends on model whim and is harder to audit.
 *
 * Each pattern has:
 *   - `match(goal)`: case-insensitive substring matcher on the
 *     normalized goal (whitespace collapsed). Returns true when the
 *     pattern is present AND no benign qualifier follows it.
 *   - `reason`: the string emitted in the `refusal` event. Should
 *     name the pattern, not moralize — operators debugging a false
 *     positive need to see exactly which rule fired.
 *
 * When adding a pattern, add a unit test for both the firing case
 * AND at least one near-miss that should NOT fire (e.g. "wipe the
 * stale cache" should NOT trip a generic "wipe" rule).
 */

export interface RefusalMatch {
  reason: string;
  pattern: string;
}

interface RefusalRule {
  pattern: RegExp;
  /**
   * Optional qualifier regex — if the goal contains the pattern AND
   * matches a qualifier, the rule DOES NOT fire. Used to let
   * through narrower phrasings like "delete the failed workloads"
   * while still catching the blanket "delete everything".
   */
  qualifier?: RegExp;
  reason: string;
}

/**
 * Normalize a goal for pattern matching: lowercase + collapse
 * runs of whitespace to a single space + trim. Pattern regex
 * authors can then use simple word-boundary expressions without
 * worrying about indentation or newlines.
 */
export function normalizeGoal(goal: string): string {
  return goal.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Default refusal ruleset. Ordered most-specific first so the
 * returned `reason` reflects the narrowest rule that matched.
 */
export const DEFAULT_REFUSAL_RULES: readonly RefusalRule[] = [
  {
    pattern: /\bdelete\s+everything\b/,
    reason:
      'refused: "delete everything" — scope is too broad; narrow the request to specific resources',
  },
  {
    pattern: /\bwipe\s+(?:all|everything|the\s+cluster|the\s+fleet)\b/,
    reason:
      'refused: "wipe all/everything/cluster/fleet" — blanket wipe; narrow the scope',
  },
  {
    pattern: /\bdrop\s+all\b/,
    qualifier: /\bdrop\s+all\s+(?:stopped|failed|idle|orphaned|stale|old)\b/,
    reason:
      'refused: "drop all" with no qualifier — specify which resources to drop',
  },
  {
    pattern: /\breset\s+(?:the\s+)?(?:cluster|fleet|everything)\b/,
    reason:
      'refused: "reset cluster/fleet/everything" — operator must perform a fleet reset from the CLI with explicit confirmation',
  },
  {
    pattern: /\buninstall\s+(?:all|everything|every\s+node)\b/,
    reason:
      'refused: "uninstall all/everything/every node" — use the per-node uninstall flow',
  },
  {
    pattern: /\bdisable\s+(?:all|every)\s+(?:safety|safeguard|guard)\b/,
    reason: 'refused: operator requested disabling safety guards',
  },
];

/**
 * Check a goal against the ruleset. Returns the first matching rule's
 * reason (and the stringified pattern for logging). Returns null when
 * no rule fires — the caller proceeds with normal planner flow.
 */
export function checkRefusal(
  goal: string,
  rules: readonly RefusalRule[] = DEFAULT_REFUSAL_RULES,
): RefusalMatch | null {
  const normalized = normalizeGoal(goal);
  for (const rule of rules) {
    if (!rule.pattern.test(normalized)) continue;
    if (rule.qualifier && rule.qualifier.test(normalized)) continue;
    return { reason: rule.reason, pattern: rule.pattern.source };
  }
  return null;
}
