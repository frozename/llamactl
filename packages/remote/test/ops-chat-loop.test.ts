import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PlannerExecutor, PlannerToolDescriptor } from '@nova/mcp';

import {
  runLoopExecutor,
  submitOutcome,
  sessionCount,
  resetSessions,
} from '../src/ops-chat/loop-executor.js';
import type { OpsChatStreamEvent } from '../src/ops-chat/loop-schema.js';

/**
 * N.4 Phase 1 — loop executor. Verifies the streaming plan-step
 * protocol + session lifecycle without a real LLM: each test
 * constructs a scripted executor that returns a canned sequence of
 * plans and asserts the event stream + outcome ack path.
 */

const readTools: PlannerToolDescriptor[] = [
  {
    name: 'llamactl.node.ls',
    description: 'list nodes',
    inputSchema: { type: 'object' },
    tier: 'read',
  },
  {
    name: 'llamactl.env',
    description: 'environment snapshot',
    inputSchema: { type: 'object' },
    tier: 'read',
  },
  {
    name: 'llamactl.cost.snapshot',
    description: 'spend rollup',
    inputSchema: { type: 'object' },
    tier: 'read',
  },
];

function scriptedExecutor(
  plans: Array<Array<{ tool: string; annotation: string; args?: Record<string, unknown> }>>,
  reasoning = 'scripted',
): PlannerExecutor {
  let calls = 0;
  return {
    name: 'scripted',
    async generate() {
      const idx = Math.min(calls, plans.length - 1);
      calls += 1;
      return {
        ok: true,
        rawPlan: {
          steps: plans[idx]!.map((step) => ({
            tool: step.tool,
            args: step.args ?? {},
            annotation: step.annotation,
          })),
          reasoning,
          requiresConfirmation: false,
        },
      };
    },
  };
}

function failingExecutor(message = 'simulated model failure'): PlannerExecutor {
  return {
    name: 'failing',
    async generate() {
      return { ok: false, reason: 'model-error', message };
    },
  };
}

async function collect(
  gen: AsyncGenerator<OpsChatStreamEvent>,
  onProposal: (ev: Extract<OpsChatStreamEvent, { type: 'plan_proposed' }>) => void | Promise<void>,
): Promise<OpsChatStreamEvent[]> {
  const events: OpsChatStreamEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === 'plan_proposed') {
      await onProposal(ev);
    }
  }
  return events;
}

beforeEach(() => {
  resetSessions();
});

afterEach(() => {
  resetSessions();
});

describe('runLoopExecutor — proposal/outcome loop', () => {
  test('emits N plan_proposed events for an N-step conversation', async () => {
    const executor = scriptedExecutor([
      [{ tool: 'llamactl.node.ls', annotation: 'enumerate nodes first' }],
      [{ tool: 'llamactl.env', annotation: 'check environment' }],
      [{ tool: 'llamactl.cost.snapshot', annotation: "summarize today's spend" }],
      [],
    ]);
    const gen = runLoopExecutor({
      goal: 'audit the fleet',
      tools: readTools,
      executor,
    });
    const events = await collect(gen, async (proposal) => {
      submitOutcome({
        sessionId: proposal.sessionId,
        stepId: proposal.stepId,
        ok: true,
        summary: `${proposal.step.tool} returned OK`,
        abort: false,
      });
    });

    const proposals = events.filter((e) => e.type === 'plan_proposed');
    expect(proposals).toHaveLength(3);
    expect(proposals.map((p) => p.step.tool)).toEqual([
      'llamactl.node.ls',
      'llamactl.env',
      'llamactl.cost.snapshot',
    ]);
    expect(proposals.map((p) => p.iteration)).toEqual([0, 1, 2]);

    const terminal = events.at(-1);
    expect(terminal?.type).toBe('done');
    if (terminal?.type === 'done') {
      expect(terminal.iterations).toBe(3);
    }
  });

  test('first proposal carries plan reasoning; later ones do not', async () => {
    const executor = scriptedExecutor(
      [
        [{ tool: 'llamactl.node.ls', annotation: 'first' }],
        [{ tool: 'llamactl.env', annotation: 'second' }],
        [],
      ],
      'explain why this whole plan is needed',
    );
    const gen = runLoopExecutor({
      goal: 'investigate',
      tools: readTools,
      executor,
    });
    const events = await collect(gen, (proposal) => {
      submitOutcome({
        sessionId: proposal.sessionId,
        stepId: proposal.stepId,
        ok: true,
        summary: 'done',
        abort: false,
      });
    });
    const proposals = events.filter((e) => e.type === 'plan_proposed');
    expect(proposals[0]!.reasoning).toBe('explain why this whole plan is needed');
    expect(proposals[1]!.reasoning).toBe('');
  });

  test('tier classification is resolved server-side', async () => {
    const tools: PlannerToolDescriptor[] = [
      {
        name: 'llamactl.workload.delete',
        description: 'delete',
        inputSchema: { type: 'object' },
        tier: 'mutation-destructive',
      },
      {
        name: 'llamactl.catalog.promote',
        description: 'promote',
        inputSchema: { type: 'object' },
        tier: 'mutation-dry-run-safe',
      },
    ];
    const executor = scriptedExecutor([
      [{ tool: 'llamactl.workload.delete', annotation: 'destructive step' }],
      [{ tool: 'llamactl.catalog.promote', annotation: 'dry-run-safe step' }],
      [],
    ]);
    const gen = runLoopExecutor({
      goal: 'test tiers',
      tools,
      executor,
      // Override DEFAULT_ALLOWLIST so destructive + deny-listed tools
      // reach the planner output — this test is about tier resolution,
      // not allowlist behavior.
      allowlist: { allow: ['llamactl.*'], deny: [], allowDestructive: true },
    });
    const events = await collect(gen, (proposal) => {
      submitOutcome({
        sessionId: proposal.sessionId,
        stepId: proposal.stepId,
        ok: true,
        summary: 'ok',
        abort: false,
      });
    });
    const proposals = events.filter((e) => e.type === 'plan_proposed');
    expect(proposals[0]!.tier).toBe('mutation-destructive');
    expect(proposals[1]!.tier).toBe('mutation-dry-run-safe');
  });

  test('outcome.abort terminates the loop after the current step', async () => {
    const executor = scriptedExecutor([
      [{ tool: 'llamactl.node.ls', annotation: 'first' }],
      [{ tool: 'llamactl.env', annotation: 'second — should NOT run' }],
    ]);
    const gen = runLoopExecutor({ goal: 'abort-test', tools: readTools, executor });
    const events = await collect(gen, (proposal) => {
      submitOutcome({
        sessionId: proposal.sessionId,
        stepId: proposal.stepId,
        ok: true,
        summary: 'ok',
        abort: true,
      });
    });
    const proposals = events.filter((e) => e.type === 'plan_proposed');
    expect(proposals).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('failed outcomes still advance the loop + feed back into context', async () => {
    const executor: PlannerExecutor = {
      name: 'context-aware',
      async generate(input) {
        const sawFailure = input.userMessage.includes('err ');
        const tool = sawFailure ? 'llamactl.env' : 'llamactl.node.ls';
        return {
          ok: true,
          rawPlan: {
            steps: sawFailure
              ? []
              : [
                  {
                    tool,
                    args: {},
                    annotation: 'scripted step',
                  },
                ],
            reasoning: sawFailure ? 'saw a failure, stopping' : 'first try',
            requiresConfirmation: false,
          },
        };
      },
    };
    const gen = runLoopExecutor({ goal: 'fail-then-stop', tools: readTools, executor });
    const events = await collect(gen, (proposal) => {
      submitOutcome({
        sessionId: proposal.sessionId,
        stepId: proposal.stepId,
        ok: false,
        summary: 'node.ls crashed',
        abort: false,
      });
    });
    const proposals = events.filter((e) => e.type === 'plan_proposed');
    expect(proposals).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });
});

describe('runLoopExecutor — refusal + safety', () => {
  test('planner failure emits a single refusal event + no proposals', async () => {
    const gen = runLoopExecutor({
      goal: 'something',
      tools: readTools,
      executor: failingExecutor('executor choked'),
    });
    const events: OpsChatStreamEvent[] = [];
    for await (const ev of gen) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('refusal');
    if (events[0]!.type === 'refusal') {
      expect(events[0]!.reason).toContain('executor choked');
    }
  });

  test('goal-pattern refusal short-circuits before the planner runs', async () => {
    let plannerCalls = 0;
    const counter: PlannerExecutor = {
      name: 'counter',
      async generate() {
        plannerCalls += 1;
        return {
          ok: true,
          rawPlan: {
            steps: [{ tool: 'llamactl.node.ls', args: {}, annotation: 'n/a' }],
            reasoning: 'should never reach here',
            requiresConfirmation: false,
          },
        };
      },
    };
    const gen = runLoopExecutor({
      goal: 'delete everything from the cluster',
      tools: readTools,
      executor: counter,
    });
    const events: OpsChatStreamEvent[] = [];
    for await (const ev of gen) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('refusal');
    expect(plannerCalls).toBe(0);
  });

  test('disallowed-tool planner result surfaces as refusal', async () => {
    const executor = scriptedExecutor([
      [{ tool: 'llamactl.unknown.thing', annotation: 'not in allowlist' }],
    ]);
    const gen = runLoopExecutor({
      goal: 'allowlist',
      tools: readTools,
      executor,
    });
    const events: OpsChatStreamEvent[] = [];
    for await (const ev of gen) events.push(ev);
    expect(events[0]!.type).toBe('refusal');
  });

  test('repeated-step detection breaks the loop', async () => {
    const executor = scriptedExecutor([
      [{ tool: 'llamactl.node.ls', annotation: 'first pass' }],
      [{ tool: 'llamactl.node.ls', annotation: 'planner is stuck in a loop' }],
    ]);
    const gen = runLoopExecutor({
      goal: 'loop-detect',
      tools: readTools,
      executor,
    });
    const events = await collect(gen, (proposal) => {
      submitOutcome({
        sessionId: proposal.sessionId,
        stepId: proposal.stepId,
        ok: true,
        summary: 'ok',
        abort: false,
      });
    });
    const proposals = events.filter((e) => e.type === 'plan_proposed');
    expect(proposals).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });
});

describe('runLoopExecutor — cancellation + session cleanup', () => {
  test('AbortSignal unblocks the pending outcome and ends the stream', async () => {
    const executor = scriptedExecutor([
      [{ tool: 'llamactl.node.ls', annotation: 'step 1' }],
    ]);
    const controller = new AbortController();
    const gen = runLoopExecutor({
      goal: 'abort-signal',
      tools: readTools,
      executor,
      signal: controller.signal,
    });
    const events: OpsChatStreamEvent[] = [];
    const consumer = (async () => {
      for await (const ev of gen) {
        events.push(ev);
        if (ev.type === 'plan_proposed') {
          setTimeout(() => controller.abort(), 5);
        }
      }
    })();
    await consumer;
    const proposals = events.filter((e) => e.type === 'plan_proposed');
    expect(proposals).toHaveLength(1);
    expect(sessionCount()).toBe(0);
  });

  test('session count drops to zero after normal termination', async () => {
    const executor = scriptedExecutor([
      [{ tool: 'llamactl.node.ls', annotation: 'first' }],
      [],
    ]);
    const gen = runLoopExecutor({
      goal: 'cleanup',
      tools: readTools,
      executor,
    });
    await collect(gen, (proposal) => {
      submitOutcome({
        sessionId: proposal.sessionId,
        stepId: proposal.stepId,
        ok: true,
        summary: 'ok',
        abort: false,
      });
    });
    expect(sessionCount()).toBe(0);
  });

  test('submitOutcome returns false for unknown sessionId', () => {
    const delivered = submitOutcome({
      sessionId: 'does-not-exist',
      stepId: 'whatever',
      ok: true,
      summary: '',
      abort: false,
    });
    expect(delivered).toBe(false);
  });

  test('submitOutcome returns false for mismatched stepId (stale delivery)', async () => {
    const executor = scriptedExecutor([
      [{ tool: 'llamactl.node.ls', annotation: 'step' }],
    ]);
    const gen = runLoopExecutor({
      goal: 'stale',
      tools: readTools,
      executor,
    });
    let capturedSessionId = '';
    let capturedStepId = '';
    for await (const ev of gen) {
      if (ev.type === 'plan_proposed') {
        capturedSessionId = ev.sessionId;
        capturedStepId = ev.stepId;
        const staleDelivery = submitOutcome({
          sessionId: capturedSessionId,
          stepId: `${capturedStepId}-wrong`,
          ok: true,
          summary: '',
          abort: false,
        });
        expect(staleDelivery).toBe(false);
        // Real delivery so the generator advances.
        submitOutcome({
          sessionId: capturedSessionId,
          stepId: capturedStepId,
          ok: true,
          summary: 'ok',
          abort: true,
        });
      }
    }
  });
});
