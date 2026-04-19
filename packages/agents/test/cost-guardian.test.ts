import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CostGuardianConfigSchema,
  decideGuardianAction,
  emptyCostGuardianConfig,
  loadCostGuardianConfig,
  runCostGuardianTick,
  type CostGuardianConfig,
  type RunbookToolClient,
  type ToolCallInput,
} from '../src/index.js';

/* -------------------------------------------------------------------------- *
 *  Config
 * -------------------------------------------------------------------------- */

describe('CostGuardianConfigSchema', () => {
  test('applies defaults when YAML is empty', () => {
    const parsed = CostGuardianConfigSchema.parse({});
    expect(parsed.thresholds).toEqual({ warn: 0.5, force_private: 0.8, deregister: 0.95 });
    expect(parsed.auto_force_private).toBe(false);
    expect(parsed.auto_deregister).toBe(false);
  });

  test('rejects decreasing thresholds', () => {
    expect(() =>
      CostGuardianConfigSchema.parse({
        thresholds: { warn: 0.9, force_private: 0.5, deregister: 0.95 },
      }),
    ).toThrow(/non-decreasing/);
  });

  test('accepts an optional daily + weekly budget', () => {
    const parsed = CostGuardianConfigSchema.parse({
      budget: { daily_usd: 10, weekly_usd: 60 },
    });
    expect(parsed.budget.daily_usd).toBe(10);
    expect(parsed.budget.weekly_usd).toBe(60);
  });

  test('accepts a webhook URL', () => {
    const parsed = CostGuardianConfigSchema.parse({
      webhook_url: 'https://hooks.example.com/guardian',
    });
    expect(parsed.webhook_url).toContain('https://');
  });

  test('rejects malformed webhook URL', () => {
    expect(() =>
      CostGuardianConfigSchema.parse({ webhook_url: 'not-a-url' }),
    ).toThrow();
  });
});

describe('loadCostGuardianConfig', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guardian-cfg-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('missing file → empty defaults (no crash)', () => {
    const cfg = loadCostGuardianConfig(join(dir, 'no-such.yaml'));
    expect(cfg).toEqual(emptyCostGuardianConfig());
  });

  test('loads and validates YAML', () => {
    const path = join(dir, 'cg.yaml');
    writeFileSync(
      path,
      `budget:
  daily_usd: 5
  weekly_usd: 30
thresholds:
  warn: 0.4
  force_private: 0.7
  deregister: 0.9
webhook_url: https://example.com/hook
auto_force_private: true
`,
    );
    const cfg = loadCostGuardianConfig(path);
    expect(cfg.budget.daily_usd).toBe(5);
    expect(cfg.thresholds.warn).toBe(0.4);
    expect(cfg.webhook_url).toBe('https://example.com/hook');
    expect(cfg.auto_force_private).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 *  State machine
 * -------------------------------------------------------------------------- */

function makeConfig(overrides: Partial<CostGuardianConfig> = {}): CostGuardianConfig {
  return CostGuardianConfigSchema.parse({
    budget: { daily_usd: 10, weekly_usd: 60 },
    ...overrides,
  });
}

describe('decideGuardianAction', () => {
  const now = () => new Date('2026-04-19T12:00:00Z');

  test('noop when no budget is configured', () => {
    const decision = decideGuardianAction({
      config: emptyCostGuardianConfig(),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: 100,
          windowSince: 'x',
          windowUntil: 'y',
        },
      },
      now,
    });
    expect(decision.tier).toBe('noop');
    expect(decision.reason).toContain('no budget');
  });

  test('noop when below warn threshold', () => {
    const decision = decideGuardianAction({
      config: makeConfig(),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: 2, // 20% of 10
          windowSince: 'x',
          windowUntil: 'y',
        },
      },
      now,
    });
    expect(decision.tier).toBe('noop');
    expect(decision.dailyFraction).toBeCloseTo(0.2, 2);
  });

  test('warn at 50-79% of daily budget', () => {
    const decision = decideGuardianAction({
      config: makeConfig(),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: 6, // 60% of 10
          windowSince: 'x',
          windowUntil: 'y',
        },
      },
      now,
    });
    expect(decision.tier).toBe('warn');
    expect(decision.thresholdCrossed).toBe(0.5);
  });

  test('force_private at 80-94%', () => {
    const decision = decideGuardianAction({
      config: makeConfig(),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: 8.5, // 85%
          windowSince: 'x',
          windowUntil: 'y',
        },
      },
      now,
    });
    expect(decision.tier).toBe('force_private');
  });

  test('deregister at 95%+ with top-provider target', () => {
    const decision = decideGuardianAction({
      config: makeConfig(),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: 9.6, // 96%
          windowSince: 'x',
          windowUntil: 'y',
          topProvider: { key: 'openai', estimatedCostUsd: 9.5 },
        },
      },
      now,
    });
    expect(decision.tier).toBe('deregister');
    expect(decision.deregisterTarget).toBe('openai');
  });

  test('stricter of daily vs weekly fractions wins', () => {
    // Daily 10% (noop), weekly 90% (force_private) → force_private.
    const decision = decideGuardianAction({
      config: makeConfig(),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: 1, // 10% of 10
          windowSince: 'x',
          windowUntil: 'y',
        },
      },
      weekly: {
        snapshot: {
          totalEstimatedCostUsd: 54, // 90% of 60
          windowSince: 'x',
          windowUntil: 'y',
        },
      },
      now,
    });
    expect(decision.tier).toBe('force_private');
  });

  test('no cost in snapshot → noop + explanatory reason', () => {
    const decision = decideGuardianAction({
      config: makeConfig(),
      daily: {
        snapshot: {
          // totalEstimatedCostUsd missing — no pricing.
          windowSince: 'x',
          windowUntil: 'y',
        },
      },
      now,
    });
    expect(decision.tier).toBe('noop');
  });
});

/* -------------------------------------------------------------------------- *
 *  runCostGuardianTick
 * -------------------------------------------------------------------------- */

function makeClient(
  responses: Record<string, unknown>,
): { client: RunbookToolClient; calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      calls.push({ name: input.name, args: input.arguments });
      // Poor-man's matcher on days arg.
      const argKey = `${input.name}:${JSON.stringify(input.arguments)}`;
      const payload = responses[argKey] ?? responses[input.name];
      if (payload === undefined) throw new Error(`unexpected: ${argKey}`);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  };
  return { client, calls };
}

describe('runCostGuardianTick', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guardian-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('daily-only config calls only the 1-day snapshot', async () => {
    const { client, calls } = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 6,
        windowSince: '2026-04-18T00:00:00Z',
        windowUntil: '2026-04-19T00:00:00Z',
      },
    });
    const config = makeConfig({ budget: { daily_usd: 10 } });
    const journalPath = join(dir, 'cost-journal.jsonl');
    const decision = await runCostGuardianTick({
      tools: client,
      config,
      journalPath,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ days: 1 });
    expect(decision.tier).toBe('warn');
    // Journal line appended.
    const body = readFileSync(journalPath, 'utf8').trim();
    const entry = JSON.parse(body);
    expect(entry.kind).toBe('tick');
    expect(entry.decision.tier).toBe('warn');
  });

  test('weekly-budgeted config calls BOTH snapshots', async () => {
    const { client, calls } = makeClient({
      'nova.ops.cost.snapshot:{"days":1}': {
        totalEstimatedCostUsd: 1,
        windowSince: 'x', windowUntil: 'y',
      },
      'nova.ops.cost.snapshot:{"days":7}': {
        totalEstimatedCostUsd: 54,
        windowSince: 'x', windowUntil: 'y',
      },
    });
    const config = makeConfig({ budget: { daily_usd: 10, weekly_usd: 60 } });
    const decision = await runCostGuardianTick({
      tools: client,
      config,
      journalPath: join(dir, 'cg.jsonl'),
    });
    // Filter to the snapshot calls — the tier-2 action also fires
    // llamactl.embersynth.set-default-profile which throws against
    // this stub client; that's fine, it just means the guardian
    // journals the tool-unavailable fallback.
    const snapshotCalls = calls.filter((c) => c.name === 'nova.ops.cost.snapshot');
    expect(snapshotCalls.map((c) => c.args)).toEqual([{ days: 1 }, { days: 7 }]);
    // Weekly at 90% wins over daily 10% → force_private.
    expect(decision.tier).toBe('force_private');
  });

  test('skipJournal true → decision returned but no disk write', async () => {
    const { client } = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 0.1,
        windowSince: 'x', windowUntil: 'y',
      },
    });
    const path = join(dir, 'should-not-exist.jsonl');
    const decision = await runCostGuardianTick({
      tools: client,
      config: makeConfig({ budget: { daily_usd: 10 } }),
      journalPath: path,
      skipJournal: true,
    });
    expect(decision.tier).toBe('noop');
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });
});
