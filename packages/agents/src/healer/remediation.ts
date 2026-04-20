import { createHash } from 'node:crypto';
import type { RunbookToolClient } from '../types.js';
import type { PlanLike } from './severity.js';
import type { stateTransitions } from './probe.js';

/**
 * Remediation coordinator. The loop, on every new unhealthy/degraded
 * transition, asks the nova planner for a remediation plan and hands
 * the plan back here for proposal/execution bookkeeping.
 *
 * Thin by design — all the real work lives in the planner (`nova.
 * operator.plan`), the execution harness (`executePlan`), and the
 * journal. This module only:
 *   - translates a transition into a one-line natural-language goal,
 *   - calls the planner and unwraps its envelope into a typed result,
 *   - derives a stable proposal id so operators can later run
 *     `llamactl heal --execute <id>` to apply a proposed plan.
 */

/** Shape of a state transition as emitted by `stateTransitions`. */
export type Transition = ReturnType<typeof stateTransitions>[number];

/**
 * Render a transition as a one-line natural-language goal the planner
 * can read. Example:
 *   "gateway 'sirius-primary' (http://g1/v1) is unhealthy — restore
 *    availability or drain gracefully."
 *
 * The goal is short on purpose — the planner consumes it as the user
 * turn of the plan prompt; more context belongs in the separate
 * `context` argument (unused today; the healer feeds the goal alone).
 */
export function buildGoal(transition: Transition): string {
  const label = transition.kind === 'gateway' ? 'gateway' : 'provider';
  const state = transition.to;
  if (state === 'healthy') {
    return `${label} '${transition.name}' recovered to healthy — confirm stable and close any outstanding remediation.`;
  }
  return (
    `${label} '${transition.name}' is ${state} — restore availability or drain gracefully.`
  );
}

/** Minimal MCP tool-call envelope shape. */
interface McpCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function firstTextBlock(result: McpCallResult): string | undefined {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return undefined;
  return first.text;
}

/** Unwrapped planner result — mirrors `nova.operator.plan`'s response
 *  after the MCP text-content envelope is parsed. See
 *  /Volumes/WorkSSD/repos/personal/nova/packages/mcp/src/server.ts:297-351. */
export type PlannerResult =
  | {
      ok: true;
      plan: PlanLike;
      executor?: string;
      toolsAvailable?: string[];
    }
  | {
      ok: false;
      reason: string;
      message: string;
      executor?: string | null;
    };

export type AskPlannerResult =
  | { ok: true; plan: PlanLike; executor?: string; toolsAvailable?: string[] }
  | { ok: false; reason: string; message: string };

/**
 * Ask `nova.operator.plan` for a remediation plan. Unwraps the MCP
 * text-content envelope; any malformed envelope (missing content,
 * unparseable JSON, `isError:true`, etc.) becomes a typed
 * `{ok: false, reason: 'envelope-error', message}` so the loop's
 * journaling path stays uniform.
 */
export async function askPlanner(
  toolClient: RunbookToolClient,
  goal: string,
): Promise<AskPlannerResult> {
  let raw: McpCallResult;
  try {
    raw = (await toolClient.callTool({
      name: 'nova.operator.plan',
      arguments: { goal },
    })) as McpCallResult;
  } catch (err) {
    return {
      ok: false,
      reason: 'call-failed',
      message: (err as Error).message ?? String(err),
    };
  }

  if (raw?.isError === true) {
    const text = firstTextBlock(raw) ?? 'nova.operator.plan returned isError';
    return { ok: false, reason: 'call-failed', message: text.slice(0, 500) };
  }

  const text = firstTextBlock(raw);
  if (text === undefined) {
    return {
      ok: false,
      reason: 'envelope-error',
      message: 'nova.operator.plan: missing text content block',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: 'envelope-error',
      message: `nova.operator.plan: JSON parse failed — ${(err as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reason: 'envelope-error',
      message: 'nova.operator.plan: envelope is not an object',
    };
  }
  const inner = parsed as PlannerResult;
  if (inner.ok === false) {
    return {
      ok: false,
      reason: inner.reason ?? 'planner-failed',
      message: inner.message ?? 'planner returned ok:false with no message',
    };
  }
  if (!inner.plan || !Array.isArray(inner.plan.steps)) {
    return {
      ok: false,
      reason: 'envelope-error',
      message: 'nova.operator.plan: missing plan.steps in ok response',
    };
  }
  const result: AskPlannerResult = { ok: true, plan: inner.plan };
  if (inner.executor) result.executor = inner.executor;
  if (inner.toolsAvailable) result.toolsAvailable = inner.toolsAvailable;
  return result;
}

/**
 * Derive a stable proposal id from a plan. sha256 of the canonical
 * JSON of `{steps, reasoning}`, first 12 chars. Same plan contents
 * always yield the same id, so an operator running
 * `llamactl heal --execute <id>` against a journal entry's id maps
 * back to the exact plan that was proposed.
 */
export function proposalId(plan: PlanLike): string {
  const canonical = JSON.stringify({
    steps: plan.steps,
    reasoning: plan.reasoning,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
