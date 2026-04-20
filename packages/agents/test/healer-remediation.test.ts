import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  appendHealerJournal,
  buildGoal,
  executePlan,
  gatePlan,
  proposalId,
  startHealerLoop,
  stepTier,
  tierOf,
  type JournalEntry,
  type JournalProposalEntry,
  type PlanLike,
  type RunbookToolClient,
  type ToolCallInput,
} from '../src/index.js';

/**
 * Tests for the N.2 Phase-2 remediation path. The healer loop, on
 * every healthy→unhealthy transition, must ask `nova.operator.plan`
 * for a plan and then either propose (default) or auto-execute
 * (with `--auto` and the severity gate). Every outcome leaves one
 * journal entry; refused/failed entries preserve the triage trail.
 *
 * Pattern matches `healer.test.ts` — tempdir YAMLs + injected
 * `writeJournal`/`toolClient` so nothing touches disk or the network.
 */

let runtimeDir = '';

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-healer-rem-'));
});
afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

function seedYamls(overrides?: {
  gateways?: Array<{ name: string; provider: string; baseUrl: string }>;
  providers?: Array<{ name: string; kind: string; baseUrl: string }>;
}): { kubeconfigPath: string; siriusProvidersPath: string } {
  const gateways = overrides?.gateways ?? [
    { name: 'sirius-primary', provider: 'sirius', baseUrl: 'http://g1/v1' },
  ];
  const providers = overrides?.providers ?? [];
  const kubeconfigPath = join(runtimeDir, 'config');
  writeFileSync(
    kubeconfigPath,
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
      clusters: [
        {
          name: 'home',
          nodes: [
            { name: 'local', endpoint: 'inproc://local' },
            ...gateways.map((g) => ({
              name: g.name,
              endpoint: '',
              kind: 'gateway',
              cloud: { provider: g.provider, baseUrl: g.baseUrl },
            })),
          ],
        },
      ],
      users: [{ name: 'me', token: 't' }],
    }),
  );
  const siriusProvidersPath = join(runtimeDir, 'sirius-providers.yaml');
  writeFileSync(siriusProvidersPath, stringifyYaml({ providers }));
  return { kubeconfigPath, siriusProvidersPath };
}

function envelope(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

interface MockClientInvocation {
  name: string;
  arguments: Record<string, unknown>;
}

function makeMockClient(
  handler: (input: ToolCallInput) => Promise<unknown>,
): { client: RunbookToolClient; calls: MockClientInvocation[] } {
  const calls: MockClientInvocation[] = [];
  return {
    calls,
    client: {
      async callTool(input: ToolCallInput) {
        calls.push({ name: input.name, arguments: input.arguments });
        return handler(input);
      },
    },
  };
}

/** Canned `nova.ops.healthcheck` envelope with a single unhealthy gateway. */
const UNHEALTHY_HEALTHCHECK = envelope({
  timeoutMs: 1500,
  gateways: [
    { name: 'sirius-primary', baseUrl: 'http://g1/v1', ok: false, status: 0, error: 'ECONNREFUSED' },
  ],
  siriusProviders: [],
});

/** Plan matching the healer's envelope shape (see nova/packages/mcp/src/server.ts:344-349). */
function plannerResponse(plan: PlanLike): { content: Array<{ type: 'text'; text: string }> } {
  return envelope({
    ok: true,
    executor: 'stub',
    toolsAvailable: [],
    plan,
  });
}

describe('severity classifier', () => {
  test('tier 1 for read-only suffixes', () => {
    expect(tierOf('llamactl.catalog.list')).toBe(1);
    expect(tierOf('llamactl.node.ls')).toBe(1);
    expect(tierOf('nova.ops.healthcheck')).toBe(1);
    expect(tierOf('llamactl.node.inspect')).toBe(1);
  });

  test('tier 2 for mutation suffixes', () => {
    expect(tierOf('llamactl.catalog.promote')).toBe(2);
    expect(tierOf('llamactl.node.sync')).toBe(2);
    expect(tierOf('llamactl.profile.set-default-profile')).toBe(2);
    expect(tierOf('llamactl.server.reload')).toBe(2);
  });

  test('tier 3 for destructive suffixes', () => {
    expect(tierOf('llamactl.node.remove')).toBe(3);
    expect(tierOf('llamactl.workload.delete')).toBe(3);
    expect(tierOf('llamactl.provider.deregister')).toBe(3);
    expect(tierOf('llamactl.package.uninstall')).toBe(3);
  });

  test('runbook overrides by name', () => {
    expect(tierOf('drain-node')).toBe(3);
    expect(tierOf('promote-fastest-vision-model')).toBe(2);
    expect(tierOf('audit-fleet')).toBe(1);
    expect(tierOf('cost-snapshot')).toBe(1);
  });

  test('unknown tool falls back to tier 2 (mutation-conservative)', () => {
    expect(tierOf('llamactl.mystery.action')).toBe(2);
  });

  test('destructive suffix beats tier-2 heuristics', () => {
    // stepTier is identical to tierOf(step.tool).
    expect(stepTier({ tool: 'llamactl.node.remove' })).toBe(3);
  });
});

describe('gatePlan', () => {
  test('allowed when every step tier <= threshold and confirmation false', () => {
    const plan: PlanLike = {
      steps: [
        { tool: 'llamactl.catalog.list', annotation: 'list' },
        { tool: 'llamactl.catalog.promote', annotation: 'promote' },
      ],
      reasoning: 'ok',
      requiresConfirmation: false,
    };
    const gate = gatePlan(plan, 2);
    expect(gate.allowed).toBe(true);
    expect(gate.refusedSteps).toEqual([]);
  });

  test('blocks tier-3 step even at threshold 3 when requiresConfirmation true', () => {
    const plan: PlanLike = {
      steps: [{ tool: 'llamactl.node.remove', annotation: 'rm' }],
      reasoning: 'r',
      requiresConfirmation: true,
    };
    const gate = gatePlan(plan, 3);
    expect(gate.allowed).toBe(false);
    expect(gate.refusedSteps).toEqual([]);
  });

  test('surfaces refusedSteps for threshold violations', () => {
    const plan: PlanLike = {
      steps: [
        { tool: 'llamactl.catalog.list', annotation: 'read' },
        { tool: 'llamactl.node.remove', annotation: 'bad' },
      ],
      reasoning: 'r',
      requiresConfirmation: false,
    };
    const gate = gatePlan(plan, 2);
    expect(gate.allowed).toBe(false);
    expect(gate.refusedSteps).toEqual([{ index: 1, tool: 'llamactl.node.remove', tier: 3 }]);
  });
});

describe('buildGoal / proposalId', () => {
  test('buildGoal produces a one-line goal for an unhealthy gateway', () => {
    const goal = buildGoal({
      name: 'sirius-primary',
      kind: 'gateway',
      from: 'healthy',
      to: 'unhealthy',
    });
    expect(goal).toContain('sirius-primary');
    expect(goal).toContain('unhealthy');
    expect(goal.includes('\n')).toBe(false);
  });

  test('proposalId is stable across identical plans', () => {
    const plan: PlanLike = {
      steps: [{ tool: 'llamactl.catalog.list', annotation: 'x' }],
      reasoning: 'r',
      requiresConfirmation: false,
    };
    const a = proposalId(plan);
    const b = proposalId({ ...plan });
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  test('proposalId differs for different plans', () => {
    const a = proposalId({
      steps: [{ tool: 'a', annotation: 'a' }],
      reasoning: 'r',
      requiresConfirmation: false,
    });
    const b = proposalId({
      steps: [{ tool: 'b', annotation: 'a' }],
      reasoning: 'r',
      requiresConfirmation: false,
    });
    expect(a).not.toBe(b);
  });
});

describe('startHealerLoop remediation — propose mode (default)', () => {
  test('flip to unhealthy journals tick + transition + proposal; no execution', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const canned: PlanLike = {
      steps: [
        { tool: 'llamactl.catalog.promote', args: { model: 'x' }, annotation: 'promote x' },
      ],
      reasoning: 'Fix the gateway by promoting the backup model.',
      requiresConfirmation: false,
    };
    const { client, calls } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return UNHEALTHY_HEALTHCHECK;
      if (input.name === 'nova.operator.plan') return plannerResponse(canned);
      throw new Error(`unexpected tool call: ${input.name}`);
    });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient: client,
      writeJournal: (e) => journaled.push(e),
    });
    await handle.done;

    const kinds = journaled.map((e) => e.kind);
    expect(kinds).toContain('tick');
    expect(kinds).toContain('transition');
    expect(kinds).toContain('proposal');
    expect(kinds).not.toContain('executed');
    expect(kinds).not.toContain('refused');

    const proposal = journaled.find((e) => e.kind === 'proposal') as JournalProposalEntry;
    expect(proposal.plan.steps).toHaveLength(1);
    expect(proposal.proposalId).toHaveLength(12);
    expect(proposal.source).toBe('nova');
    expect(proposal.transition.name).toBe('sirius-primary');

    // Planner was asked; no plan step was invoked on the client.
    expect(calls.map((c) => c.name)).toContain('nova.operator.plan');
    expect(calls.map((c) => c.name)).not.toContain('llamactl.catalog.promote');
  });
});

describe('startHealerLoop remediation — auto mode', () => {
  test('tier-2 plan passes gate → plan executes + executed entry journaled', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const canned: PlanLike = {
      steps: [
        { tool: 'llamactl.catalog.promote', args: { model: 'x' }, annotation: 'promote' },
        { tool: 'llamactl.server.reload', args: {}, annotation: 'reload' },
      ],
      reasoning: 'remediate',
      requiresConfirmation: false,
    };
    const { client, calls } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return UNHEALTHY_HEALTHCHECK;
      if (input.name === 'nova.operator.plan') return plannerResponse(canned);
      // Any other tool call is a plan step being executed — return ok envelope.
      return envelope({ ok: true, step: input.name });
    });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient: client,
      mode: 'auto',
      severityThreshold: 2,
      writeJournal: (e) => journaled.push(e),
    });
    await handle.done;

    const executed = journaled.find((e) => e.kind === 'executed');
    expect(executed).toBeTruthy();
    if (executed && executed.kind === 'executed') {
      expect(executed.steps).toHaveLength(2);
      expect(executed.steps.every((s) => s.outcome.ok === true)).toBe(true);
      expect(executed.stoppedAt).toBeUndefined();
    }

    // Both raw tool calls surfaced in the toolClient's call log.
    const callNames = calls.map((c) => c.name);
    expect(callNames).toContain('llamactl.catalog.promote');
    expect(callNames).toContain('llamactl.server.reload');
  });

  test('tier-3 step — refused with destructive-requires-manual-approval', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const canned: PlanLike = {
      steps: [{ tool: 'llamactl.node.remove', args: { node: 'a' }, annotation: 'drop' }],
      reasoning: 'nuke it',
      requiresConfirmation: false,
    };
    const { client, calls } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return UNHEALTHY_HEALTHCHECK;
      if (input.name === 'nova.operator.plan') return plannerResponse(canned);
      throw new Error(`auto-mode should not have invoked ${input.name}`);
    });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient: client,
      mode: 'auto',
      severityThreshold: 2,
      writeJournal: (e) => journaled.push(e),
    });
    await handle.done;

    const refused = journaled.find((e) => e.kind === 'refused');
    expect(refused).toBeTruthy();
    if (refused && refused.kind === 'refused') {
      expect(refused.reason).toBe('destructive-requires-manual-approval');
      expect(refused.refusedSteps?.[0]?.tool).toBe('llamactl.node.remove');
      expect(refused.refusedSteps?.[0]?.tier).toBe(3);
    }
    expect(journaled.find((e) => e.kind === 'executed')).toBeUndefined();
    // node.remove was never called.
    expect(calls.map((c) => c.name)).not.toContain('llamactl.node.remove');
  });

  test('requiresConfirmation: true blocks auto-exec even when every step is tier 1', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const canned: PlanLike = {
      steps: [{ tool: 'llamactl.catalog.list', args: {}, annotation: 'list' }],
      reasoning: 'check catalog',
      requiresConfirmation: true,
    };
    const { client } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return UNHEALTHY_HEALTHCHECK;
      if (input.name === 'nova.operator.plan') return plannerResponse(canned);
      throw new Error(`plan step should not have executed: ${input.name}`);
    });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient: client,
      mode: 'auto',
      severityThreshold: 3,
      writeJournal: (e) => journaled.push(e),
    });
    await handle.done;

    const refused = journaled.find((e) => e.kind === 'refused');
    expect(refused && refused.kind === 'refused' ? refused.reason : null).toBe(
      'planner-requires-confirmation',
    );
    expect(journaled.find((e) => e.kind === 'executed')).toBeUndefined();
  });

  test('planner returns ok:false → plan-failed journal entry, no execution', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const { client } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return UNHEALTHY_HEALTHCHECK;
      if (input.name === 'nova.operator.plan') {
        return envelope({
          ok: false,
          reason: 'no-executor',
          message: 'LLM executor not bound',
          executor: null,
        });
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient: client,
      mode: 'auto',
      severityThreshold: 2,
      writeJournal: (e) => journaled.push(e),
    });
    await handle.done;

    const failed = journaled.find((e) => e.kind === 'plan-failed');
    expect(failed).toBeTruthy();
    if (failed && failed.kind === 'plan-failed') {
      expect(failed.reason).toBe('no-executor');
      expect(failed.message).toContain('LLM executor');
    }
    expect(journaled.find((e) => e.kind === 'proposal')).toBeUndefined();
    expect(journaled.find((e) => e.kind === 'executed')).toBeUndefined();
  });
});

describe('executePlan (--execute <proposal-id> primitive)', () => {
  test('runs a plan end-to-end through the injected client', async () => {
    const plan: PlanLike = {
      steps: [
        { tool: 'llamactl.catalog.promote', args: { model: 'm1' }, annotation: 'promote' },
        { tool: 'llamactl.server.reload', args: {}, annotation: 'reload' },
      ],
      reasoning: 'apply previously-proposed remediation',
      requiresConfirmation: false,
    };
    const { client, calls } = makeMockClient(async () => envelope({ ok: true }));
    const result = await executePlan(plan, { toolClient: client, dryRun: false });
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.outcome.ok === true)).toBe(true);
    expect(result.stoppedAt).toBeUndefined();
    expect(calls.map((c) => c.name)).toEqual([
      'llamactl.catalog.promote',
      'llamactl.server.reload',
    ]);
  });

  test('stops at the first ok:false and reports stoppedAt', async () => {
    const plan: PlanLike = {
      steps: [
        { tool: 'llamactl.catalog.list', annotation: 'first' },
        { tool: 'llamactl.catalog.promote', annotation: 'boom' },
        { tool: 'llamactl.server.reload', annotation: 'unreached' },
      ],
      reasoning: 'r',
      requiresConfirmation: false,
    };
    const { client, calls } = makeMockClient(async (input) => {
      if (input.name === 'llamactl.catalog.promote') {
        return { isError: true, content: [{ type: 'text', text: 'boom' }] };
      }
      return envelope({ ok: true });
    });
    const result = await executePlan(plan, { toolClient: client });
    expect(result.steps).toHaveLength(2);
    expect(result.stoppedAt).toBe(1);
    expect(result.steps[1]?.outcome.ok).toBe(false);
    if (result.steps[1] && !result.steps[1].outcome.ok) {
      expect(result.steps[1].outcome.error).toContain('boom');
    }
    // Third step never attempted.
    expect(calls.map((c) => c.name)).not.toContain('llamactl.server.reload');
  });

  test('--execute <proposal-id> reads proposal from tempfile journal and executes', async () => {
    const journalPath = join(runtimeDir, 'journal.jsonl');
    const plan: PlanLike = {
      steps: [{ tool: 'llamactl.catalog.promote', args: { model: 'm1' }, annotation: 'promote' }],
      reasoning: 'r',
      requiresConfirmation: false,
    };
    const id = proposalId(plan);
    // Seed a proposal entry into the journal file, mirroring what the
    // loop would have written during a previous propose-mode run.
    appendHealerJournal(
      {
        kind: 'proposal',
        ts: new Date().toISOString(),
        transition: {
          name: 'sirius-primary',
          resourceKind: 'gateway',
          from: 'healthy',
          to: 'unhealthy',
        },
        plan,
        proposalId: id,
        source: 'nova',
      },
      journalPath,
    );

    // Mirror the CLI's --execute branch: scan JSONL, load proposal,
    // executePlan, append an executed entry.
    const raw = readFileSync(journalPath, 'utf8');
    const entries = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as JournalEntry);
    const proposal = entries.find(
      (e) => e.kind === 'proposal' && e.proposalId === id,
    ) as JournalProposalEntry;
    expect(proposal).toBeTruthy();

    const { client, calls } = makeMockClient(async () => envelope({ ok: true }));
    const result = await executePlan(proposal.plan, { toolClient: client });
    appendHealerJournal(
      {
        kind: 'executed',
        ts: new Date().toISOString(),
        proposalId: id,
        steps: result.steps,
      },
      journalPath,
    );

    // Journal now holds proposal + executed entries for the same id.
    const after = readFileSync(journalPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as JournalEntry);
    const executed = after.find(
      (e) => e.kind === 'executed' && e.proposalId === id,
    );
    expect(executed).toBeTruthy();
    expect(calls.map((c) => c.name)).toEqual(['llamactl.catalog.promote']);
  });
});
