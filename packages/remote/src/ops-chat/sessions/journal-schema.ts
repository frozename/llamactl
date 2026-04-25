import { z } from 'zod';
import { PlanStepSchema } from '@nova/mcp';

export const ToolTierEnum = z.enum([
  'read',
  'mutation-dry-run-safe',
  'mutation-destructive',
]);
export type ToolTier = z.infer<typeof ToolTierEnum>;

const Common = z.object({ ts: z.string().min(1) });

export const SessionStartedSchema = Common.extend({
  type: z.literal('session_started'),
  sessionId: z.string().min(1),
  goal: z.string().min(1),
  nodeId: z.string().optional(),
  model: z.string().optional(),
  historyLen: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
});

export const PlanProposedSchema = Common.extend({
  type: z.literal('plan_proposed'),
  stepId: z.string().min(1),
  iteration: z.number().int().nonnegative(),
  tier: ToolTierEnum,
  reasoning: z.string(),
  step: PlanStepSchema,
});

export const OutcomeBodySchema = z.object({
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  result: z.unknown().optional(),
  resultRedacted: z.enum(['omitted', 'truncated']).optional(),
  error: z
    .object({ code: z.string(), message: z.string() })
    .optional(),
});

export const PreviewOutcomeSchema = Common.extend({
  type: z.literal('preview_outcome'),
  stepId: z.string().min(1),
}).merge(OutcomeBodySchema);

export const WetOutcomeSchema = Common.extend({
  type: z.literal('wet_outcome'),
  stepId: z.string().min(1),
}).merge(OutcomeBodySchema);

export const RefusalSchema = Common.extend({
  type: z.literal('refusal'),
  reason: z.string().min(1),
});

export const DoneSchema = Common.extend({
  type: z.literal('done'),
  iterations: z.number().int().nonnegative(),
});

export const AbortedSchema = Common.extend({
  type: z.literal('aborted'),
  reason: z.enum(['client_abort', 'signal', 'timeout']),
});

export const JournalEventSchema = z.discriminatedUnion('type', [
  SessionStartedSchema,
  PlanProposedSchema,
  PreviewOutcomeSchema,
  WetOutcomeSchema,
  RefusalSchema,
  DoneSchema,
  AbortedSchema,
]);
export type JournalEvent = z.infer<typeof JournalEventSchema>;

export type TerminalEvent =
  | z.infer<typeof DoneSchema>
  | z.infer<typeof RefusalSchema>
  | z.infer<typeof AbortedSchema>;

export function isTerminal(e: JournalEvent): e is TerminalEvent {
  return e.type === 'done' || e.type === 'refusal' || e.type === 'aborted';
}
