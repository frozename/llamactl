import {
  type AllowlistConfig,
  type Plan,
  type PlannerExecutor,
  type PlannerToolDescriptor,
  type PlanStep,
  runPlanner,
} from "@nova/mcp";
import { randomUUID } from "node:crypto";

import type { OpsChatStepOutcome, OpsChatStreamEvent } from "./loop-schema.js";
import type { JournalEvent } from "./sessions/journal-schema.js";

import { KNOWN_OPS_CHAT_TOOLS, toolTier, type ToolTier } from "./dispatch.js";
import { checkRefusal } from "./refusals.js";
import { sessionEventBus } from "./sessions/event-bus.js";
import { appendJournalEvent } from "./sessions/journal.js";

/**
 * N.4 Phase 1 — server-side loop executor for Ops Chat.
 *
 * Wraps `runPlanner` in a re-entrant loop: each iteration re-calls
 * the planner with the accumulated outcome history folded into
 * context, takes the first step, emits it as a `plan_proposed` event,
 * and blocks until the caller posts an outcome via the companion
 * `operatorSubmitStepOutcome` mutation.
 *
 * State lives in a module-scope Map keyed by sessionId. The generator
 * registers a record on open and deletes it in `finally`, so abrupt
 * subscription close (AbortSignal, caller disconnect) doesn't leak.
 *
 * The loop caps at `maxIterations` (default 10). Planner failures
 * emit a single `refusal` event and terminate. Phase 3 adds a
 * goal-pattern refusal heuristic that short-circuits before the
 * planner runs.
 */

export interface LoopExecutorOptions {
  goal: string;
  context?: string;
  history?: { role: "user" | "assistant"; text: string }[];
  nodeId?: string;
  model?: string;
  tools: PlannerToolDescriptor[];
  executor: PlannerExecutor;
  allowlist?: AllowlistConfig;
  maxIterations?: number;
  signal?: AbortSignal;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface SessionRecord {
  currentStepId: string | null;
  pendingOutcome: Deferred<OpsChatStepOutcome> | null;
  closed: boolean;
  abortHandler?: (() => void) | null;
}

const sessionRegistry = new Map<string, SessionRecord>();

/**
 * Post an outcome for a pending step. Returns true when the outcome
 * successfully resolves the session's waiting Deferred; false when
 * the session is unknown, closed, or waiting on a different step
 * (stale / duplicate delivery).
 */
export function submitOutcome(outcome: OpsChatStepOutcome): boolean {
  const record = sessionRegistry.get(outcome.sessionId);
  if (!record || record.closed) return false;
  if (!record.pendingOutcome) return false;
  if (record.currentStepId !== outcome.stepId) return false;
  const pending = record.pendingOutcome;
  record.pendingOutcome = null;
  record.currentStepId = null;
  pending.resolve(outcome);
  return true;
}

/**
 * For tests / diagnostics: how many sessions are currently open.
 */
export function sessionCount(): number {
  return sessionRegistry.size;
}

/**
 * Reset the registry — tests call this between cases so a leaked
 * session from one case doesn't pollute the next.
 */
export function resetSessions(): void {
  for (const record of sessionRegistry.values()) {
    record.closed = true;
    record.pendingOutcome?.reject(new Error("session reset"));
  }
  sessionRegistry.clear();
}

function resolveTier(toolName: string): ToolTier {
  if ((KNOWN_OPS_CHAT_TOOLS as readonly string[]).includes(toolName)) {
    return toolTier(toolName as (typeof KNOWN_OPS_CHAT_TOOLS)[number]);
  }
  return "read";
}

function buildTranscript(
  history: LoopExecutorOptions["history"],
  outcomes: { step: string; ok: boolean; summary: string }[],
): string {
  const lines: string[] = [];
  for (const turn of history ?? []) {
    const text = turn.text.trim();
    if (text.length > 0) lines.push(`${turn.role}: ${text}`);
  }
  for (const outcome of outcomes) {
    const marker = outcome.ok ? "ok" : "err";
    lines.push(`tool-outcome (${marker}) ${outcome.step}: ${outcome.summary.trim()}`);
  }
  return lines.join("\n");
}

/** Create the session record + journal/event-bus plumbing and wire
 *  the abort handler. The caller owns teardown in its `finally`. */
async function initSessionState(
  opts: LoopExecutorOptions,
  sessionId: string,
): Promise<SessionRecord> {
  sessionEventBus.create(sessionId);
  const startEvent: JournalEvent = {
    type: "session_started",
    ts: new Date().toISOString(),
    sessionId,
    goal: opts.goal,
    nodeId: opts.nodeId,
    model: opts.model,
    historyLen: opts.history?.length ?? 0,
    toolCount: opts.tools.length,
  };
  await appendJournalEvent(sessionId, startEvent);
  sessionEventBus.publish(sessionId, startEvent);

  const record: SessionRecord = {
    currentStepId: null,
    pendingOutcome: null,
    closed: false,
    abortHandler: null,
  };
  sessionRegistry.set(sessionId, record);

  const abortHandler = (): void => {
    record.pendingOutcome?.reject(new Error("aborted"));
  };
  opts.signal?.addEventListener("abort", abortHandler);
  record.abortHandler = abortHandler;

  return record;
}

async function emitDoneEvent(
  sessionId: string,
  outcomes: { step: string; ok: boolean; summary: string }[],
): Promise<void> {
  const doneEvt: JournalEvent = {
    type: "done",
    ts: new Date().toISOString(),
    iterations: outcomes.length,
  };
  await appendJournalEvent(sessionId, doneEvt);
  sessionEventBus.publish(sessionId, doneEvt);
}

/** Fold prior turns + tool outcomes + the operator's own context
 *  into the planner's context string. */
function buildMergedContext(
  opts: LoopExecutorOptions,
  outcomes: { step: string; ok: boolean; summary: string }[],
): string {
  const transcript = buildTranscript(opts.history, outcomes);
  const userContext = opts.context?.trim() ?? "";
  return [transcript, userContext].filter((s) => s.length > 0).join("\n\n");
}

async function emitRefusalEvent(sessionId: string, reason: string): Promise<void> {
  const ev: JournalEvent = {
    type: "refusal",
    ts: new Date().toISOString(),
    reason,
  };
  await appendJournalEvent(sessionId, ev);
  sessionEventBus.publish(sessionId, ev);
}

/**
 * Pick the next step or `null` to terminate the loop: the planner
 * returned an empty plan, or it's looping on a step it already
 * proposed (stuck model — don't waste iterations).
 */
function nextPlannedStep(plan: Plan, seenSteps: Set<string>): PlanStep | null {
  const [step] = plan.steps;
  if (!step) return null;
  const signature = `${step.tool}:${JSON.stringify(step.args)}`;
  if (seenSteps.has(signature)) return null;
  seenSteps.add(signature);
  return step;
}

/** Journal + publish the `plan_proposed` event, returning the
 *  stream-shaped twin for the generator to yield. */
async function publishPlanProposed(
  sessionId: string,
  stepId: string,
  iteration: number,
  step: PlanStep,
  planReasoning: string,
): Promise<OpsChatStreamEvent> {
  const tier = resolveTier(step.tool);
  const reasoning = iteration === 0 ? planReasoning : "";
  const planEvt: JournalEvent = {
    type: "plan_proposed",
    ts: new Date().toISOString(),
    stepId,
    iteration,
    tier,
    reasoning,
    step,
  };
  await appendJournalEvent(sessionId, planEvt);
  sessionEventBus.publish(sessionId, planEvt);
  return { type: "plan_proposed", sessionId, stepId, iteration, step, tier, reasoning };
}

/** Block until the caller posts the step outcome. `null` means the
 *  wait was rejected (abort / reset) — exit cleanly. */
async function waitForOutcome(
  pending: Deferred<OpsChatStepOutcome>,
): Promise<OpsChatStepOutcome | null> {
  try {
    return await pending.promise;
  } catch {
    return null;
  }
}

function teardownSession(sessionId: string, record: SessionRecord, signal?: AbortSignal): void {
  if (record.abortHandler) {
    signal?.removeEventListener("abort", record.abortHandler);
  }
  record.closed = true;
  record.pendingOutcome = null;
  sessionRegistry.delete(sessionId);
  sessionEventBus.close(sessionId);
}

/**
 * Main entry point. Yields OpsChatStreamEvent values until the loop
 * terminates via `done` or `refusal`. Deletes its session record in
 * `finally` so AbortSignal or caller disconnect cleans up.
 */
export async function* runLoopExecutor(
  opts: LoopExecutorOptions,
): AsyncGenerator<OpsChatStreamEvent> {
  const sessionId = randomUUID();
  const record = await initSessionState(opts, sessionId);

  const maxIterations = opts.maxIterations ?? 10;
  const outcomes: { step: string; ok: boolean; summary: string }[] = [];
  const seenSteps = new Set<string>();

  try {
    // Goal-pattern refusal fires before the planner ever runs. A
    // match here short-circuits the entire loop — the planner is
    // never consulted, no tools are offered, no audit entries land.
    const refusal = checkRefusal(opts.goal);
    if (refusal) {
      yield { type: "refusal", reason: refusal.reason };
      return;
    }

    let iteration = 0;
    while (iteration < maxIterations && !opts.signal?.aborted) {
      const result = await runPlanner({
        goal: opts.goal,
        context: buildMergedContext(opts, outcomes),
        tools: opts.tools,
        executor: opts.executor,
        allowlist: opts.allowlist,
      });

      if (!result.ok) {
        const reason = `${result.reason}: ${result.message}`;
        await emitRefusalEvent(sessionId, reason);
        yield { type: "refusal", reason };
        return;
      }

      const step = nextPlannedStep(result.plan, seenSteps);
      if (!step) break;

      const stepId = `${sessionId}:${String(iteration)}`;
      const pending = createDeferred<OpsChatStepOutcome>();
      record.currentStepId = stepId;
      record.pendingOutcome = pending;

      yield await publishPlanProposed(sessionId, stepId, iteration, step, result.plan.reasoning);

      const outcome = await waitForOutcome(pending);
      if (outcome === null) return;

      outcomes.push({
        step: step.tool,
        ok: outcome.ok,
        summary: outcome.summary,
      });

      if (outcome.abort) break;
      iteration += 1;
    }

    await emitDoneEvent(sessionId, outcomes);
    yield { type: "done", iterations: outcomes.length };
  } finally {
    teardownSession(sessionId, record, opts.signal);
  }
}
