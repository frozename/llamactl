import { z } from 'zod';
import { PlanStepSchema } from '@nova/mcp';

/**
 * Event stream shape for `operatorChatStream`. The server emits one
 * `plan_proposed` per iteration and then blocks until the caller posts
 * an outcome via `operatorSubmitStepOutcome`. A terminal event is
 * always `refusal` or `done`, never two of the same in sequence.
 *
 * Client lifecycle:
 *   1. open subscription with {goal, history, tools, ...}
 *   2. server emits `plan_proposed` with sessionId + stepId + step
 *   3. client runs the tool (via operatorRunTool), posts outcome back
 *      via operatorSubmitStepOutcome({sessionId, stepId, outcome})
 *   4. server re-enters the planner with the outcome appended to
 *      context, emits next `plan_proposed` OR `done` when the planner
 *      returns no more work
 *   5. client receives `done` → subscription closes
 *
 * Refusals short-circuit the loop: if the goal matches a refusal
 * pattern the server emits a single `refusal` event and returns.
 */

export const OpsChatRefusalSchema = z.object({
  type: z.literal('refusal'),
  reason: z.string().min(1),
});
export type OpsChatRefusal = z.infer<typeof OpsChatRefusalSchema>;

export const OpsChatPlanProposedSchema = z.object({
  type: z.literal('plan_proposed'),
  sessionId: z.string().min(1),
  stepId: z.string().min(1),
  /** Sequence index within the session — useful for UI ordering. */
  iteration: z.number().int().nonnegative(),
  step: PlanStepSchema,
  /** Tier of this step's tool, pre-computed server-side so the
   *  renderer doesn't have to duplicate the classifier. */
  tier: z.enum(['read', 'mutation-dry-run-safe', 'mutation-destructive']),
  /** Short free-form model reasoning for the whole plan — attached to
   *  the first step of each iteration so the UI can surface it. Empty
   *  string on subsequent iterations from the same plan. */
  reasoning: z.string(),
});
export type OpsChatPlanProposed = z.infer<typeof OpsChatPlanProposedSchema>;

export const OpsChatDoneSchema = z.object({
  type: z.literal('done'),
  /** Total iterations run before termination. */
  iterations: z.number().int().nonnegative(),
});
export type OpsChatDone = z.infer<typeof OpsChatDoneSchema>;

export const OpsChatStreamEventSchema = z.discriminatedUnion('type', [
  OpsChatPlanProposedSchema,
  OpsChatRefusalSchema,
  OpsChatDoneSchema,
]);
export type OpsChatStreamEvent = z.infer<typeof OpsChatStreamEventSchema>;

/**
 * Outcome shape the caller posts back via operatorSubmitStepOutcome.
 * `ok: false` paths still advance the loop — the planner can decide
 * to retry, repair, or give up based on the error text.
 */
export const OpsChatStepOutcomeSchema = z.object({
  sessionId: z.string().min(1),
  stepId: z.string().min(1),
  ok: z.boolean(),
  /** JSON-stringified tool result OR error text. Planner reads this
   *  as the next iteration's context. */
  summary: z.string(),
  /** If true, the client is abandoning the loop — server closes the
   *  subscription with a `done` event. */
  abort: z.boolean().default(false),
});
export type OpsChatStepOutcome = z.infer<typeof OpsChatStepOutcomeSchema>;
