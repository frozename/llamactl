import { randomUUID } from 'node:crypto';
import {
  runPlanner,
  type PlannerExecutor,
  type PlannerToolDescriptor,
  type AllowlistConfig,
} from '@nova/mcp';
import { toolTier, type ToolTier, KNOWN_OPS_CHAT_TOOLS } from './dispatch.js';
import type {
  OpsChatStreamEvent,
  OpsChatStepOutcome,
} from './loop-schema.js';

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
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
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
    record.pendingOutcome?.reject(new Error('session reset'));
  }
  sessionRegistry.clear();
}

function resolveTier(toolName: string): ToolTier {
  if ((KNOWN_OPS_CHAT_TOOLS as readonly string[]).includes(toolName)) {
    return toolTier(toolName as (typeof KNOWN_OPS_CHAT_TOOLS)[number]);
  }
  return 'read';
}

function buildTranscript(
  history: LoopExecutorOptions['history'],
  outcomes: Array<{ step: string; ok: boolean; summary: string }>,
): string {
  const lines: string[] = [];
  for (const turn of history ?? []) {
    const text = turn.text.trim();
    if (text.length > 0) lines.push(`${turn.role}: ${text}`);
  }
  for (const outcome of outcomes) {
    const marker = outcome.ok ? 'ok' : 'err';
    lines.push(
      `tool-outcome (${marker}) ${outcome.step}: ${outcome.summary.trim()}`,
    );
  }
  return lines.join('\n');
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
  const maxIterations = opts.maxIterations ?? 10;
  const record: SessionRecord = {
    currentStepId: null,
    pendingOutcome: null,
    closed: false,
  };
  sessionRegistry.set(sessionId, record);

  const outcomes: Array<{ step: string; ok: boolean; summary: string }> = [];
  const seenSteps = new Set<string>();

  const abortHandler = () => {
    record.pendingOutcome?.reject(new Error('aborted'));
  };
  opts.signal?.addEventListener('abort', abortHandler);

  try {
    let iteration = 0;
    while (iteration < maxIterations) {
      if (opts.signal?.aborted) break;

      const transcript = buildTranscript(opts.history, outcomes);
      const userContext = opts.context?.trim() ?? '';
      const mergedContext = [transcript, userContext]
        .filter((s) => s.length > 0)
        .join('\n\n');

      const result = await runPlanner({
        goal: opts.goal,
        context: mergedContext,
        tools: opts.tools,
        executor: opts.executor,
        allowlist: opts.allowlist,
      });

      if (!result.ok) {
        yield {
          type: 'refusal',
          reason: `${result.reason}: ${result.message}`,
        };
        return;
      }

      if (result.plan.steps.length === 0) break;

      const step = result.plan.steps[0]!;
      const signature = `${step.tool}:${JSON.stringify(step.args)}`;
      if (seenSteps.has(signature)) {
        // Planner is looping on the same step — terminate to avoid
        // wasting iterations on a stuck model.
        break;
      }
      seenSteps.add(signature);

      const stepId = `${sessionId}:${iteration}`;
      const pending = createDeferred<OpsChatStepOutcome>();
      record.currentStepId = stepId;
      record.pendingOutcome = pending;

      yield {
        type: 'plan_proposed',
        sessionId,
        stepId,
        iteration,
        step,
        tier: resolveTier(step.tool),
        reasoning: iteration === 0 ? result.plan.reasoning : '',
      };

      let outcome: OpsChatStepOutcome;
      try {
        outcome = await pending.promise;
      } catch {
        // Abort / reset — exit cleanly.
        return;
      }

      outcomes.push({
        step: step.tool,
        ok: outcome.ok,
        summary: outcome.summary,
      });

      if (outcome.abort) break;
      iteration += 1;
    }

    yield { type: 'done', iterations: outcomes.length };
  } finally {
    opts.signal?.removeEventListener('abort', abortHandler);
    record.closed = true;
    record.pendingOutcome = null;
    sessionRegistry.delete(sessionId);
  }
}
