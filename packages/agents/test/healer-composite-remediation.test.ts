import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  startHealerLoop,
  type JournalEntry,
  type JournalExecutedEntry,
  type JournalProposalEntry,
  type JournalRefusedEntry,
  type RunbookToolClient,
  type ToolCallInput,
} from '../src/index.js';

/**
 * Slice D — healer composite remediation. The loop, on every tick,
 * calls `llamactl.composite.list` through the injected MCP client
 * and emits a tier-2 `llamactl.composite.apply` plan for any
 * composite in a Degraded/Failed state OR with a component in the
 * `Failed` state. Tier-2 means propose-only by default and auto-
 * executes with `mode:'auto'` + severity threshold >= 2.
 *
 * Tests here keep the probe layer happy with a minimal healthy
 * fleet + an empty healthcheck envelope so the composite branch is
 * the one under test — no cross-talk with Phase-2 remediation.
 */

let runtimeDir = '';

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-healer-composite-'));
});
afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

function seedYamls(): {
  kubeconfigPath: string;
  siriusProvidersPath: string;
} {
  // One healthy gateway so the probe path has something to ack. The
  // fakeFetch below returns 200, so no probe-side transitions fire
  // and nothing competes with the composite branch.
  const kubeconfigPath = join(runtimeDir, 'config');
  writeFileSync(
    kubeconfigPath,
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [
        { name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' },
      ],
      clusters: [
        {
          name: 'home',
          nodes: [
            { name: 'local', endpoint: 'inproc://local' },
            {
              name: 'gw-ok',
              endpoint: '',
              kind: 'gateway',
              cloud: { provider: 'sirius', baseUrl: 'http://127.0.0.1:65535/v1' },
            },
          ],
        },
      ],
      users: [{ name: 'me', token: 't' }],
    }),
  );
  const siriusProvidersPath = join(runtimeDir, 'sirius-providers.yaml');
  writeFileSync(siriusProvidersPath, stringifyYaml({ providers: [] }));
  return { kubeconfigPath, siriusProvidersPath };
}

function envelope(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
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

/** Canned healthcheck — no unhealthy entries so the probe remediation
 *  path stays quiet and only the composite branch fires. */
const HEALTHY_HEALTHCHECK = envelope({
  timeoutMs: 1500,
  gateways: [
    {
      name: 'gw-ok',
      baseUrl: 'http://127.0.0.1:65535/v1',
      ok: true,
      status: 200,
    },
  ],
  siriusProviders: [],
});

/** Minimal valid composite manifest fixtures for the list envelope. */
function manifestFixture(
  name: string,
  phase: string,
  components: Array<{ kind: string; name: string; state: string }>,
): Record<string, unknown> {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Composite',
    metadata: { name },
    spec: {
      services: [],
      workloads: [],
      ragNodes: [],
      gateways: [],
      dependencies: [],
      onFailure: 'rollback',
    },
    status: {
      phase,
      appliedAt: new Date().toISOString(),
      components: components.map((c) => ({
        ref: { kind: c.kind, name: c.name },
        state: c.state,
      })),
    },
  };
}

describe('healer composite remediation — propose mode', () => {
  test('only Degraded + Failed composites produce proposals; Ready is ignored', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const composites = [
      manifestFixture('sky-ready', 'Ready', [
        { kind: 'service', name: 'chroma', state: 'Ready' },
      ]),
      manifestFixture('sky-degraded', 'Degraded', [
        { kind: 'service', name: 'chroma', state: 'Ready' },
        { kind: 'workload', name: 'llama1', state: 'Failed' },
      ]),
      manifestFixture('sky-failed', 'Failed', [
        { kind: 'service', name: 'chroma', state: 'Failed' },
      ]),
    ];
    const { client, calls } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return HEALTHY_HEALTHCHECK;
      if (input.name === 'llamactl.composite.list') {
        return envelope({ count: composites.length, composites });
      }
      throw new Error(`unexpected tool call: ${input.name}`);
    });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient: client,
      // propose mode is the default; explicit for clarity.
      mode: 'propose',
      writeJournal: (e) => journaled.push(e),
    });
    await handle.done;

    const proposals = journaled.filter(
      (e): e is JournalProposalEntry =>
        e.kind === 'proposal' && e.transition.resourceKind === 'composite',
    );
    const names = proposals.map((p) => p.transition.name).sort();
    expect(names).toEqual(['sky-degraded', 'sky-failed']);

    // Each proposal targets the apply tool with a manifestYaml arg.
    for (const p of proposals) {
      expect(p.plan.steps).toHaveLength(1);
      expect(p.plan.steps[0]?.tool).toBe('llamactl.composite.apply');
      const args = p.plan.steps[0]?.args as { manifestYaml?: string } | undefined;
      expect(typeof args?.manifestYaml).toBe('string');
      expect(p.plan.requiresConfirmation).toBe(false);
      expect(p.proposalId).toHaveLength(12);
      expect(p.transition.resourceKind).toBe('composite');
    }

    // Propose mode — no executed entries.
    expect(journaled.find((e) => e.kind === 'executed')).toBeUndefined();

    // Apply was not called (propose-only); list was called exactly once.
    const callNames = calls.map((c) => c.name);
    expect(callNames.filter((n) => n === 'llamactl.composite.list')).toHaveLength(1);
    expect(callNames).not.toContain('llamactl.composite.apply');
  });

  test('Ready phase with one Failed component still bubbles up', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const composites = [
      // Phase is Ready but a single component reports Failed — the
      // loop must still emit a proposal so the operator journal
      // shows the discrepancy.
      manifestFixture('sky-component-failed', 'Ready', [
        { kind: 'service', name: 'chroma', state: 'Ready' },
        { kind: 'workload', name: 'rag', state: 'Failed' },
      ]),
    ];
    const { client } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return HEALTHY_HEALTHCHECK;
      if (input.name === 'llamactl.composite.list') {
        return envelope({ count: composites.length, composites });
      }
      throw new Error(`unexpected tool call: ${input.name}`);
    });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient: client,
      mode: 'propose',
      writeJournal: (e) => journaled.push(e),
    });
    await handle.done;

    const proposal = journaled.find(
      (e): e is JournalProposalEntry =>
        e.kind === 'proposal' && e.transition.resourceKind === 'composite',
    );
    expect(proposal).toBeDefined();
    expect(proposal?.transition.name).toBe('sky-component-failed');
    expect(proposal?.plan.reasoning).toContain('Failed');
  });
});

describe('healer composite remediation — auto mode', () => {
  test('tier-2 plan passes the gate → apply invoked + executed entry journaled', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const composites = [
      manifestFixture('sky-degraded', 'Degraded', [
        { kind: 'service', name: 'chroma', state: 'Failed' },
      ]),
    ];
    const { client, calls } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return HEALTHY_HEALTHCHECK;
      if (input.name === 'llamactl.composite.list') {
        return envelope({ count: composites.length, composites });
      }
      if (input.name === 'llamactl.composite.apply') {
        return envelope({ ok: true, status: { phase: 'Ready' } });
      }
      throw new Error(`unexpected tool call: ${input.name}`);
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

    const executed = journaled.find(
      (e): e is JournalExecutedEntry => e.kind === 'executed',
    );
    expect(executed).toBeDefined();
    expect(executed?.steps).toHaveLength(1);
    expect(executed?.steps[0]?.tool).toBe('llamactl.composite.apply');
    expect(executed?.steps[0]?.outcome.ok).toBe(true);

    // The apply tool actually got called with a manifestYaml arg.
    const applyCall = calls.find((c) => c.name === 'llamactl.composite.apply');
    expect(applyCall).toBeDefined();
    expect(typeof applyCall?.arguments.manifestYaml).toBe('string');
  });

  test('severity threshold 1 refuses the tier-2 plan → refused entry, apply never runs', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const composites = [
      manifestFixture('sky-failed', 'Failed', [
        { kind: 'service', name: 'chroma', state: 'Failed' },
      ]),
    ];
    const { client, calls } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return HEALTHY_HEALTHCHECK;
      if (input.name === 'llamactl.composite.list') {
        return envelope({ count: composites.length, composites });
      }
      throw new Error(
        `auto mode at threshold 1 should not have invoked ${input.name}`,
      );
    });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient: client,
      mode: 'auto',
      severityThreshold: 1,
      writeJournal: (e) => journaled.push(e),
    });
    await handle.done;

    const refused = journaled.find(
      (e): e is JournalRefusedEntry => e.kind === 'refused',
    );
    expect(refused).toBeDefined();
    expect(refused?.reason).toBe('severity-exceeded');
    expect(refused?.refusedSteps?.[0]?.tool).toBe('llamactl.composite.apply');
    expect(refused?.refusedSteps?.[0]?.tier).toBe(2);

    expect(journaled.find((e) => e.kind === 'executed')).toBeUndefined();
    expect(calls.map((c) => c.name)).not.toContain('llamactl.composite.apply');
  });

  test('empty composite list → no proposals, no errors', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const { client } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return HEALTHY_HEALTHCHECK;
      if (input.name === 'llamactl.composite.list') {
        return envelope({ count: 0, composites: [] });
      }
      throw new Error(`unexpected tool call: ${input.name}`);
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

    const compositeProposals = journaled.filter(
      (e) =>
        e.kind === 'proposal' && e.transition.resourceKind === 'composite',
    );
    expect(compositeProposals).toHaveLength(0);
    expect(journaled.find((e) => e.kind === 'plan-failed')).toBeUndefined();
  });

  test('composite without status (Unknown phase) is not remediated', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    // Manifest with no `status` block — treated as Unknown, should be
    // skipped to avoid churning every freshly-authored composite that
    // hasn't been applied yet.
    const composites = [
      {
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'sky-new' },
        spec: {
          services: [],
          workloads: [],
          ragNodes: [],
          gateways: [],
          dependencies: [],
          onFailure: 'rollback',
        },
      },
    ];
    const { client } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return HEALTHY_HEALTHCHECK;
      if (input.name === 'llamactl.composite.list') {
        return envelope({ count: 1, composites });
      }
      throw new Error(`unexpected tool call: ${input.name}`);
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

    const compositeProposals = journaled.filter(
      (e) =>
        e.kind === 'proposal' && e.transition.resourceKind === 'composite',
    );
    expect(compositeProposals).toHaveLength(0);
  });
});

describe('healer composite remediation — list failure', () => {
  test('throw from llamactl.composite.list is journaled as plan-failed + loop continues', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const { client } = makeMockClient(async (input) => {
      if (input.name === 'nova.ops.healthcheck') return HEALTHY_HEALTHCHECK;
      if (input.name === 'llamactl.composite.list') {
        throw new Error('composite store unreachable');
      }
      throw new Error(`unexpected tool call: ${input.name}`);
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

    const planFailed = journaled.find(
      (e) =>
        e.kind === 'plan-failed' &&
        e.transition.resourceKind === 'composite',
    );
    expect(planFailed).toBeDefined();
    if (planFailed && planFailed.kind === 'plan-failed') {
      expect(planFailed.reason).toBe('composite-list-failed');
      expect(planFailed.message).toContain('composite store unreachable');
    }
    // Probe path still produced its normal tick entry.
    expect(journaled.find((e) => e.kind === 'tick')).toBeDefined();
  });
});
