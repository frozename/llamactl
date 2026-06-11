import { createHash } from "node:crypto";

import type { RunbookToolClient } from "../types.js";
import type { stateTransitions } from "./probe.js";
import type { PlanLike } from "./severity.js";

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
  const label = transition.kind === "gateway" ? "gateway" : "provider";
  const state = transition.to;
  if (state === "healthy") {
    return `${label} '${transition.name}' recovered to healthy — confirm stable and close any outstanding remediation.`;
  }
  return `${label} '${transition.name}' is ${state} — restore availability or drain gracefully.`;
}

/** Minimal MCP tool-call envelope shape. */
interface McpCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

function firstTextBlock(result: McpCallResult): string | undefined {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (first?.type !== "text" || typeof first.text !== "string") return undefined;
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
 * Untrusted view of the planner envelope. The payload is
 * model-generated JSON crossing a trust boundary, so beyond "it parsed
 * to an object" nothing about its shape is assumed — every field must
 * be narrowed at runtime before it reaches the typed
 * `AskPlannerResult`. `PlannerResult` above documents the shape the
 * planner *promises*; this type encodes what we actually *trust*.
 */
interface UntrustedPlannerEnvelope {
  ok?: unknown;
  plan?: unknown;
  reason?: unknown;
  message?: unknown;
  executor?: unknown;
  toolsAvailable?: unknown;
}

/** Runtime check that an untrusted `plan` value is usable as
 *  `PlanLike` — downstream consumers (`gatePlan`, `proposalId`,
 *  `executePlan`) all require `steps` to be an array. */
function isPlanLike(value: unknown): value is PlanLike {
  if (value === null || typeof value !== "object") return false;
  return Array.isArray((value as { steps?: unknown }).steps);
}

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
      name: "nova.operator.plan",
      arguments: { goal },
    })) as McpCallResult;
  } catch (err) {
    return {
      ok: false,
      reason: "call-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const unwrapped = unwrapPlannerEnvelope(raw);
  if (!unwrapped.ok) return unwrapped;
  return plannerResultFromEnvelope(unwrapped.envelope);
}

/** Unwrap the MCP text-content envelope into the untrusted planner
 *  payload. Any malformed envelope becomes a typed failure result. */
function unwrapPlannerEnvelope(
  raw: McpCallResult,
):
  | { ok: true; envelope: UntrustedPlannerEnvelope }
  | { ok: false; reason: string; message: string } {
  if (raw.isError === true) {
    const text = firstTextBlock(raw) ?? "nova.operator.plan returned isError";
    return { ok: false, reason: "call-failed", message: text.slice(0, 500) };
  }

  const text = firstTextBlock(raw);
  if (text === undefined) {
    return {
      ok: false,
      reason: "envelope-error",
      message: "nova.operator.plan: missing text content block",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: "envelope-error",
      message: `nova.operator.plan: JSON parse failed — ${(err as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      reason: "envelope-error",
      message: "nova.operator.plan: envelope is not an object",
    };
  }
  return { ok: true, envelope: parsed };
}

/** Narrow the untrusted planner payload into the typed result the
 *  loop consumes; every field is runtime-checked before use. */
function plannerResultFromEnvelope(inner: UntrustedPlannerEnvelope): AskPlannerResult {
  if (inner.ok !== true) {
    return {
      ok: false,
      reason: typeof inner.reason === "string" ? inner.reason : "planner-failed",
      message:
        typeof inner.message === "string"
          ? inner.message
          : "planner returned ok:false with no message",
    };
  }
  if (!isPlanLike(inner.plan)) {
    return {
      ok: false,
      reason: "envelope-error",
      message: "nova.operator.plan: missing plan.steps in ok response",
    };
  }
  const result: AskPlannerResult = { ok: true, plan: inner.plan };
  if (typeof inner.executor === "string" && inner.executor.length > 0) {
    result.executor = inner.executor;
  }
  const toolsAvailable: unknown = inner.toolsAvailable;
  if (Array.isArray(toolsAvailable)) {
    result.toolsAvailable = toolsAvailable.filter(
      (tool): tool is string => typeof tool === "string",
    );
  }
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
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}
