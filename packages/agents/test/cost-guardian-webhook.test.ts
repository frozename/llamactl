import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CostGuardianConfigSchema,
  postGuardianWebhook,
  runCostGuardianTick,
  type CostGuardianConfig,
  type RunbookToolClient,
  type ToolCallInput,
  type WebhookFetcher,
} from '../src/index.js';

/**
 * Webhook action tests for the cost-guardian tick. Uses an
 * injectable fake fetcher so the tests cover payload shape,
 * routing decisions, and journal integration without hitting the
 * network.
 */

describe('postGuardianWebhook', () => {
  test('POSTs the decision as JSON with content-type + user-agent headers', async () => {
    let captured:
      | { url: string; method: string; headers: Record<string, string>; body: string }
      | null = null;
    const fetcher: WebhookFetcher = async (url, init) => {
      captured = { url, method: init.method, headers: init.headers, body: init.body };
      return { ok: true, status: 200 };
    };
    const outcome = await postGuardianWebhook({
      url: 'https://example.com/hook',
      decision: {
        ts: '2026-04-19T00:00:00Z',
        tier: 'warn',
        reason: 'daily 60%',
        thresholdCrossed: 0.5,
        deregisterTarget: null,
      },
      fetcher,
    });
    expect(outcome.ok).toBe(true);
    expect(captured!.url).toBe('https://example.com/hook');
    expect(captured!.method).toBe('POST');
    expect(captured!.headers['content-type']).toBe('application/json');
    expect(captured!.headers['user-agent']).toContain('llamactl-cost-guardian');
    const payload = JSON.parse(captured!.body);
    expect(payload.tier).toBe('warn');
  });

  test('non-2xx response → { ok: false, status, error } with truncated body', async () => {
    const fetcher: WebhookFetcher = async () => ({
      ok: false,
      status: 503,
      text: async () => 'upstream overloaded '.repeat(40),
    });
    const outcome = await postGuardianWebhook({
      url: 'https://x',
      decision: {
        ts: 'x',
        tier: 'warn',
        reason: 'r',
        thresholdCrossed: 0.5,
        deregisterTarget: null,
      },
      fetcher,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(503);
    expect(outcome.error.length).toBeLessThanOrEqual(300);
    expect(outcome.error).toContain('upstream overloaded');
  });

  test('fetcher throws → { ok: false, error }', async () => {
    const fetcher: WebhookFetcher = async () => {
      throw new Error('ECONNREFUSED');
    };
    const outcome = await postGuardianWebhook({
      url: 'https://x',
      decision: {
        ts: 'x',
        tier: 'warn',
        reason: 'r',
        thresholdCrossed: 0.5,
        deregisterTarget: null,
      },
      fetcher,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('ECONNREFUSED');
  });
});

/* -------------------------------------------------------------------------- */

function makeClient(responses: Record<string, unknown>): RunbookToolClient {
  return {
    async callTool(input: ToolCallInput) {
      const payload = responses[input.name];
      if (payload === undefined) throw new Error(`unexpected: ${input.name}`);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  };
}

function makeConfig(overrides: Partial<CostGuardianConfig> = {}): CostGuardianConfig {
  return CostGuardianConfigSchema.parse({
    budget: { daily_usd: 10 },
    webhook_url: 'https://example.com/cost-alerts',
    ...overrides,
  });
}

describe('runCostGuardianTick — webhook dispatch', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guardian-hook-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function readJournal(path: string): Array<Record<string, unknown>> {
    const body = readFileSync(path, 'utf8').trim();
    return body.split('\n').map((line) => JSON.parse(line));
  }

  test('noop tier → no webhook call', async () => {
    let calls = 0;
    const fetcher: WebhookFetcher = async () => { calls++; return { ok: true, status: 200 }; };
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 0.5, // 5% of 10
        windowSince: 'x', windowUntil: 'y',
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    const decision = await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      webhookFetcher: fetcher,
    });
    expect(decision.tier).toBe('noop');
    expect(calls).toBe(0);
    const entries = readJournal(journalPath);
    // Only the tick entry — no action entry.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('tick');
  });

  test('warn tier → webhook fires, action entry journaled with ok:true', async () => {
    let captured: string | null = null;
    const fetcher: WebhookFetcher = async (_url, init) => {
      captured = init.body;
      return { ok: true, status: 204 };
    };
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 6, // 60% of 10
        windowSince: 'x', windowUntil: 'y',
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    const decision = await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      webhookFetcher: fetcher,
    });
    expect(decision.tier).toBe('warn');
    expect(captured).not.toBeNull();
    const entries = readJournal(journalPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe('tick');
    expect(entries[1]!.kind).toBe('action');
    expect(entries[1]!.action).toBe('webhook');
    expect(entries[1]!.ok).toBe(true);
  });

  test('webhook failure → action entry journaled with ok:false + error', async () => {
    const fetcher: WebhookFetcher = async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 9.8, // 98%
        windowSince: 'x', windowUntil: 'y',
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    const decision = await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      webhookFetcher: fetcher,
    });
    expect(decision.tier).toBe('deregister');
    const entries = readJournal(journalPath);
    expect(entries[1]!.ok).toBe(false);
    expect(entries[1]!.error).toContain('boom');
  });

  test('no webhook_url in config → webhook skipped even on warn tier', async () => {
    let calls = 0;
    const fetcher: WebhookFetcher = async () => { calls++; return { ok: true, status: 200 }; };
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 8, windowSince: 'x', windowUntil: 'y',
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    const config = CostGuardianConfigSchema.parse({ budget: { daily_usd: 10 } });
    await runCostGuardianTick({ tools, config, journalPath, webhookFetcher: fetcher });
    expect(calls).toBe(0);
    const entries = readJournal(journalPath);
    expect(entries.every((e) => e.kind === 'tick')).toBe(true);
  });

  test('disableWebhook=true short-circuits the action regardless of config', async () => {
    let calls = 0;
    const fetcher: WebhookFetcher = async () => { calls++; return { ok: true, status: 200 }; };
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 9, windowSince: 'x', windowUntil: 'y',
      },
    });
    const decision = await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath: join(dir, 'cg.jsonl'),
      webhookFetcher: fetcher,
      disableWebhook: true,
    });
    expect(decision.tier).not.toBe('noop');
    expect(calls).toBe(0);
  });
});

describe('runCostGuardianTick — tier-3 deregister dry-run intent', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guardian-d3-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function readJournal(path: string): Array<Record<string, unknown>> {
    const body = readFileSync(path, 'utf8').trim();
    return body.split('\n').map((line) => JSON.parse(line));
  }

  test('deregister tier with a top-provider target → deregister-dry-run action journaled', async () => {
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 9.8,
        windowSince: 'x',
        windowUntil: 'y',
        byProvider: [
          { key: 'openai', estimatedCostUsd: 9.7 },
          { key: 'anthropic', estimatedCostUsd: 0.1 },
        ],
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    expect(entries).toHaveLength(2); // tick + deregister-dry-run
    const action = entries.find((e) => e.action === 'deregister-dry-run')!;
    expect(action.ok).toBe(true);
    const detail = action.detail as {
      provider: string;
      autoDeregisterEnabled: boolean;
      note: string;
    };
    expect(detail.provider).toBe('openai');
    expect(detail.autoDeregisterEnabled).toBe(false);
    expect(detail.note).toContain('manual operator action required');
  });

  test('auto_deregister=true flags the intent but still does not call sirius', async () => {
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 9.8,
        windowSince: 'x',
        windowUntil: 'y',
        byProvider: [{ key: 'openai', estimatedCostUsd: 9.7 }],
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    await runCostGuardianTick({
      tools,
      config: makeConfig({ auto_deregister: true }),
      journalPath,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    const action = entries.find((e) => e.action === 'deregister-dry-run')!;
    const detail = action.detail as {
      autoDeregisterEnabled: boolean;
      note: string;
    };
    expect(detail.autoDeregisterEnabled).toBe(true);
    expect(detail.note).toContain('follow-up slice');
  });

  test('deregister tier with no byProvider → no dry-run action (nothing to deregister)', async () => {
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 9.8,
        windowSince: 'x',
        windowUntil: 'y',
        // no byProvider → decision.deregisterTarget stays null
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    const decision = await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      disableWebhook: true,
    });
    expect(decision.tier).toBe('deregister');
    expect(decision.deregisterTarget).toBeNull();
    const entries = readJournal(journalPath);
    expect(entries.some((e) => e.action === 'deregister-dry-run')).toBe(false);
  });

  test('warn + force_private tiers never emit a deregister-dry-run entry', async () => {
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 6, // 60% of 10 → warn
        windowSince: 'x',
        windowUntil: 'y',
        byProvider: [{ key: 'openai', estimatedCostUsd: 6 }],
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    expect(entries.some((e) => e.action === 'deregister-dry-run')).toBe(false);
  });
});
