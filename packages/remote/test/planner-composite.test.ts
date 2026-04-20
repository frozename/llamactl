import { describe, expect, test } from 'bun:test';
import {
  runPlanner,
  DEFAULT_ALLOWLIST,
  type PlannerExecutor,
  type PlannerToolDescriptor,
} from '@nova/mcp';
import {
  BUILT_IN_PLANNER_TOOLS,
  mergePlannerTools,
} from '../src/router.js';

/**
 * Phase 6 — planner integration for `llamactl.composite.apply`.
 *
 * These tests exercise the *registration* layer (Phase 6 scope): the
 * router injects a composite.apply descriptor into the planner catalog
 * so the LLM can emit a single-step plan that replaces a multi-step
 * decomposition. They intentionally stay at the `runPlanner` surface
 * and do not hit the dispatch layer (Phase 5 owns that) — the only
 * claim here is "the planner knows about composite.apply and accepts
 * plans that reference it".
 *
 * Stubbed `PlannerExecutor`s drive the plan shape deterministically so
 * the assertions are about routing + allowlist plumbing, not about
 * LLM behaviour.
 */

// A small sample of caller-supplied tools (mirrors what the
// Electron ops-chat catalog sends up per request). We use these to
// verify merge semantics and to seed realistic plans.
const SAMPLE_CALLER_TOOLS: PlannerToolDescriptor[] = [
  {
    name: 'llamactl.catalog.list',
    description: 'List curated models on the control plane.',
    inputSchema: { type: 'object' },
    tier: 'read',
  },
  {
    name: 'llamactl.workload.list',
    description: 'List declarative ModelRun manifests.',
    inputSchema: { type: 'object' },
    tier: 'read',
  },
];

function compositeManifestYaml(): string {
  return [
    'apiVersion: llamactl/v1',
    'kind: Composite',
    'metadata:',
    '  name: kb-stack',
    'spec:',
    '  services:',
    '    - kind: chroma',
    '      name: chroma-main',
    '      node: local',
    '  workloads: []',
    '  ragNodes: []',
    '  gateways: []',
    '',
  ].join('\n');
}

function stubEmittingComposite(): PlannerExecutor {
  return {
    name: 'stub-composite',
    async generate() {
      return {
        ok: true,
        rawPlan: {
          steps: [
            {
              tool: 'llamactl.composite.apply',
              args: {
                manifestYaml: compositeManifestYaml(),
                dryRun: true,
              },
              dryRun: true,
              annotation:
                'deploy chroma + 7B model + sirius gateway as a single Composite',
            },
          ],
          reasoning:
            'operator described a 3-component stack, so emit one composite.apply step rather than three individual tool calls',
          requiresConfirmation: true,
        },
      };
    },
  };
}

function stubEmittingSingleReadStep(): PlannerExecutor {
  return {
    name: 'stub-single-read',
    async generate() {
      return {
        ok: true,
        rawPlan: {
          steps: [
            {
              tool: 'llamactl.workload.list',
              args: {},
              annotation: 'list existing workloads to confirm where the new one lands',
            },
          ],
          reasoning: 'single-component ask, stick with the narrower read tool',
          requiresConfirmation: false,
        },
      };
    },
  };
}

describe('BUILT_IN_PLANNER_TOOLS', () => {
  test('exposes llamactl.composite.apply as a dry-run-safe mutation', () => {
    const composite = BUILT_IN_PLANNER_TOOLS.find(
      (t) => t.name === 'llamactl.composite.apply',
    );
    expect(composite).toBeDefined();
    expect(composite!.tier).toBe('mutation-dry-run-safe');
    // Description must be directive enough for the LLM to prefer
    // compositing on 3+ component asks. It must NOT instruct the model
    // to always use composite — that biases the planner the wrong way.
    expect(composite!.description.toLowerCase()).toContain('prefer');
    expect(composite!.description.toLowerCase()).toContain('composite');
    expect(composite!.description.toLowerCase()).not.toContain('always');
  });

  test('composite.apply inputSchema requires manifestYaml and advertises dryRun', () => {
    const composite = BUILT_IN_PLANNER_TOOLS.find(
      (t) => t.name === 'llamactl.composite.apply',
    )!;
    const schema = composite.inputSchema as {
      required?: string[];
      properties?: Record<string, { type: string }>;
    };
    expect(schema.required).toContain('manifestYaml');
    expect(schema.properties?.manifestYaml?.type).toBe('string');
    expect(schema.properties?.dryRun?.type).toBe('boolean');
  });
});

describe('mergePlannerTools', () => {
  test('appends built-ins to caller-supplied tools', () => {
    const merged = mergePlannerTools(SAMPLE_CALLER_TOOLS, BUILT_IN_PLANNER_TOOLS);
    const names = merged.map((t) => t.name);
    expect(names).toContain('llamactl.catalog.list');
    expect(names).toContain('llamactl.workload.list');
    expect(names).toContain('llamactl.composite.apply');
    // Caller entries keep their ordering; built-ins append at the end.
    expect(names.slice(0, SAMPLE_CALLER_TOOLS.length)).toEqual(
      SAMPLE_CALLER_TOOLS.map((t) => t.name),
    );
  });

  test('caller override wins on name collision', () => {
    const override: PlannerToolDescriptor = {
      name: 'llamactl.composite.apply',
      description: 'CALLER OVERRIDE — alternate wording',
      inputSchema: { type: 'object' },
      tier: 'mutation-dry-run-safe',
    };
    const merged = mergePlannerTools([override], BUILT_IN_PLANNER_TOOLS);
    const composite = merged.filter((t) => t.name === 'llamactl.composite.apply');
    expect(composite).toHaveLength(1);
    expect(composite[0]!.description).toBe('CALLER OVERRIDE — alternate wording');
  });

  test('idempotent when merged repeatedly', () => {
    const once = mergePlannerTools(SAMPLE_CALLER_TOOLS, BUILT_IN_PLANNER_TOOLS);
    const twice = mergePlannerTools(once, BUILT_IN_PLANNER_TOOLS);
    expect(twice.map((t) => t.name)).toEqual(once.map((t) => t.name));
  });
});

describe('runPlanner + composite.apply', () => {
  test('accepts a stub plan that emits llamactl.composite.apply', async () => {
    const merged = mergePlannerTools(SAMPLE_CALLER_TOOLS, BUILT_IN_PLANNER_TOOLS);
    const result = await runPlanner({
      goal: 'deploy chroma + 7B model + sirius gateway on local',
      context: '',
      tools: merged,
      executor: stubEmittingComposite(),
      allowlist: DEFAULT_ALLOWLIST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps).toHaveLength(1);
    const step = result.plan.steps[0]!;
    expect(step.tool).toBe('llamactl.composite.apply');
    expect(step.annotation.length).toBeGreaterThan(0);
    // args propagate intact so Phase 5 dispatch can forward them.
    const args = step.args as { manifestYaml?: string; dryRun?: boolean };
    expect(args.manifestYaml).toContain('kind: Composite');
    expect(args.dryRun).toBe(true);
  });

  test('composite.apply is allowlisted by DEFAULT_ALLOWLIST (llamactl.* glob)', async () => {
    // Composite is a dry-run-safe mutation, so the `llamactl.*` allow
    // glob in DEFAULT_ALLOWLIST must accept it without requiring
    // `allowDestructive`. If this regresses, the planner would return
    // `disallowed-tool` even though the tool is safe — that's the
    // failure mode this test guards.
    const merged = mergePlannerTools(SAMPLE_CALLER_TOOLS, BUILT_IN_PLANNER_TOOLS);
    const result = await runPlanner({
      goal: 'deploy a multi-component stack',
      context: '',
      tools: merged,
      executor: stubEmittingComposite(),
      allowlist: DEFAULT_ALLOWLIST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolsAvailable).toContain('llamactl.composite.apply');
  });

  test('narrower plans still pass when composite is available (no forced-composite bias)', async () => {
    // Regression guard for the anti-pattern "planner always wraps in a
    // composite". The merged catalog offers composite.apply, but a
    // stub-emitted single-read plan must still survive validation.
    const merged = mergePlannerTools(SAMPLE_CALLER_TOOLS, BUILT_IN_PLANNER_TOOLS);
    const result = await runPlanner({
      goal: 'show me the current workloads',
      context: '',
      tools: merged,
      executor: stubEmittingSingleReadStep(),
      allowlist: DEFAULT_ALLOWLIST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0]!.tool).toBe('llamactl.workload.list');
  });

  test('multi-step plans including composite.apply survive allowlist validation', async () => {
    // An LLM might reasonably plan a read-then-apply sequence:
    // inspect cluster state, then apply the composite. The allowlist
    // gate must accept both tools because composite.apply is in the
    // merged catalog (via BUILT_IN_PLANNER_TOOLS) and list is caller-
    // supplied. If allowlist plumbing regresses we'd see a
    // `disallowed-tool` failure here.
    const multiStep: PlannerExecutor = {
      name: 'stub-multi',
      async generate() {
        return {
          ok: true,
          rawPlan: {
            steps: [
              {
                tool: 'llamactl.workload.list',
                args: {},
                annotation: 'inventory current workloads before applying the composite',
              },
              {
                tool: 'llamactl.composite.apply',
                args: { manifestYaml: compositeManifestYaml(), dryRun: true },
                dryRun: true,
                annotation: 'dry-run the composite so the operator can review the DAG',
              },
            ],
            reasoning: 'inspect-then-apply is the safe cadence for a new composite',
            requiresConfirmation: true,
          },
        };
      },
    };
    const merged = mergePlannerTools(SAMPLE_CALLER_TOOLS, BUILT_IN_PLANNER_TOOLS);
    const result = await runPlanner({
      goal: 'spin up chroma + a 7B model + a gateway on local',
      context: '',
      tools: merged,
      executor: multiStep,
      allowlist: DEFAULT_ALLOWLIST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((s) => s.tool)).toEqual([
      'llamactl.workload.list',
      'llamactl.composite.apply',
    ]);
  });
});
