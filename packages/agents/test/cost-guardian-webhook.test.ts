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

  test('no webhook_url in config → webhook skipped even on force_private tier', async () => {
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
    // No webhook action entry ever gets journaled when webhook_url
    // is absent — but the tier-2 force-private intent is still
    // journaled since that's a separate action surface.
    expect(entries.some((e) => e.action === 'webhook')).toBe(false);
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

  test('sirius tool unavailable → intent journaled with tool-not-available error', async () => {
    // makeClient only registers nova.ops.cost.snapshot — the sirius
    // tool throws on lookup. Guardian should journal the intent
    // with ok:false + toolInvoked:false.
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
    // tick + force-private intent + deregister-dry-run
    expect(entries).toHaveLength(3);
    const action = entries.find((e) => e.action === 'deregister-dry-run')!;
    expect(action.ok).toBe(false);
    const detail = action.detail as {
      provider: string;
      autoDeregisterEnabled: boolean;
      toolInvoked: boolean;
      note: string;
    };
    expect(detail.provider).toBe('openai');
    expect(detail.toolInvoked).toBe(false);
    expect(detail.note).toContain('manual operator action required');
    expect(action.error).toContain('sirius.providers.deregister not available');
  });

  test('auto_deregister=true without sirius still flags toolInvoked:false', async () => {
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
      toolInvoked: boolean;
      note: string;
    };
    expect(detail.autoDeregisterEnabled).toBe(true);
    expect(detail.toolInvoked).toBe(false);
  });

  test('sirius tool mounted → real call, dryRun:true passed, outcome journaled', async () => {
    let captured: ToolCallInput | null = null;
    const tools: RunbookToolClient = {
      async callTool(input) {
        if (input.name === 'nova.ops.cost.snapshot') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  totalEstimatedCostUsd: 9.8,
                  windowSince: 'x',
                  windowUntil: 'y',
                  byProvider: [{ key: 'openai', estimatedCostUsd: 9.7 }],
                }),
              },
            ],
          };
        }
        if (input.name === 'sirius.providers.deregister') {
          captured = input;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  mode: 'dry-run',
                  wasPresent: true,
                  remainingCount: 2,
                }),
              },
            ],
          };
        }
        throw new Error(`unexpected: ${input.name}`);
      },
    };
    const journalPath = join(dir, 'cg.jsonl');
    await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      disableWebhook: true,
    });
    expect(captured).not.toBeNull();
    expect(captured!.arguments).toEqual({ name: 'openai', dryRun: true });
    const entries = readJournal(journalPath);
    const action = entries.find((e) => e.action === 'deregister-dry-run')!;
    expect(action.ok).toBe(true);
    const detail = action.detail as {
      provider: string;
      toolInvoked: boolean;
      mode: string;
      wasPresent: boolean;
      remainingCount: number;
    };
    expect(detail.toolInvoked).toBe(true);
    expect(detail.mode).toBe('dry-run');
    expect(detail.wasPresent).toBe(true);
    expect(detail.remainingCount).toBe(2);
    // Even with auto_deregister defaulted to false, the dry-run call
    // went through — wet semantics stay server-side.
  });

  test('sirius tool returns ok:false → journaled with reason + message', async () => {
    const tools: RunbookToolClient = {
      async callTool(input) {
        if (input.name === 'nova.ops.cost.snapshot') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  totalEstimatedCostUsd: 9.8,
                  windowSince: 'x',
                  windowUntil: 'y',
                  byProvider: [{ key: 'openai', estimatedCostUsd: 9.7 }],
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                reason: 'wet-mode-not-implemented',
                message: 'ships in K.7.2',
              }),
            },
          ],
        };
      },
    };
    const journalPath = join(dir, 'cg.jsonl');
    await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    const action = entries.find((e) => e.action === 'deregister-dry-run')!;
    expect(action.ok).toBe(false);
    expect(action.error).toContain('wet-mode-not-implemented');
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

  test('warn tier never emits a deregister-dry-run entry', async () => {
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

describe('runCostGuardianTick — tier-2 force-private intent', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guardian-d2-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function readJournal(path: string): Array<Record<string, unknown>> {
    const body = readFileSync(path, 'utf8').trim();
    return body.split('\n').map((line) => JSON.parse(line));
  }

  test('force_private tier → force-private action entry with manual-action note', async () => {
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 8.5, // 85% → force_private
        windowSince: 'x', windowUntil: 'y',
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    const decision = await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      disableWebhook: true,
    });
    expect(decision.tier).toBe('force_private');
    const entries = readJournal(journalPath);
    const action = entries.find((e) => e.action === 'force-private')!;
    // Tool not available in this harness (no llamactl.* routed) →
    // ok:false + toolInvoked:false + manual-action note.
    expect(action.ok).toBe(false);
    const detail = action.detail as {
      autoForcePrivateEnabled: boolean;
      targetProfile: string;
      toolInvoked: boolean;
      note: string;
    };
    expect(detail.autoForcePrivateEnabled).toBe(false);
    expect(detail.targetProfile).toBe('private-first');
    expect(detail.toolInvoked).toBe(false);
    expect(detail.note).toContain('manual operator action required');
  });

  test('auto_force_private=true still flags toolInvoked:false without llamactl mounted', async () => {
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 8.5,
        windowSince: 'x', windowUntil: 'y',
      },
    });
    const journalPath = join(dir, 'cg.jsonl');
    await runCostGuardianTick({
      tools,
      config: makeConfig({ auto_force_private: true }),
      journalPath,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    const action = entries.find((e) => e.action === 'force-private')!;
    const detail = action.detail as { autoForcePrivateEnabled: boolean; toolInvoked: boolean };
    expect(detail.autoForcePrivateEnabled).toBe(true);
    expect(detail.toolInvoked).toBe(false);
  });

  test('llamactl tool mounted → real call, dryRun:true passed, outcome journaled', async () => {
    let captured: ToolCallInput | null = null;
    const tools: RunbookToolClient = {
      async callTool(input) {
        if (input.name === 'nova.ops.cost.snapshot') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  totalEstimatedCostUsd: 8.5,
                  windowSince: 'x',
                  windowUntil: 'y',
                }),
              },
            ],
          };
        }
        if (input.name === 'llamactl.embersynth.set-default-profile') {
          captured = input;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  mode: 'dry-run',
                  previous: 'auto',
                  next: 'private-first',
                  unchanged: false,
                }),
              },
            ],
          };
        }
        throw new Error(`unexpected: ${input.name}`);
      },
    };
    const journalPath = join(dir, 'cg.jsonl');
    await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      disableWebhook: true,
    });
    expect(captured).not.toBeNull();
    expect(captured!.arguments).toEqual({
      profile: 'private-first',
      syntheticModel: 'fusion-auto',
      dryRun: true,
    });
    const entries = readJournal(journalPath);
    const action = entries.find((e) => e.action === 'force-private')!;
    expect(action.ok).toBe(true);
    const detail = action.detail as {
      toolInvoked: boolean;
      mode: string;
      previous: string;
      next: string;
      unchanged: boolean;
    };
    expect(detail.toolInvoked).toBe(true);
    expect(detail.mode).toBe('dry-run');
    expect(detail.previous).toBe('auto');
    expect(detail.next).toBe('private-first');
    expect(detail.unchanged).toBe(false);
  });

  test('llamactl tool returns unknown-profile → error surfaces with availableProfiles', async () => {
    const tools: RunbookToolClient = {
      async callTool(input) {
        if (input.name === 'nova.ops.cost.snapshot') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  totalEstimatedCostUsd: 8.5,
                  windowSince: 'x',
                  windowUntil: 'y',
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                reason: 'unknown-profile',
                message: "profile 'private-first' not found",
                availableProfiles: ['auto', 'fast'],
              }),
            },
          ],
        };
      },
    };
    const journalPath = join(dir, 'cg.jsonl');
    await runCostGuardianTick({
      tools,
      config: makeConfig(),
      journalPath,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    const action = entries.find((e) => e.action === 'force-private')!;
    expect(action.ok).toBe(false);
    expect(action.error).toContain('unknown-profile');
    const detail = action.detail as { availableProfiles: string[] };
    expect(detail.availableProfiles).toEqual(['auto', 'fast']);
  });

  test('deregister tier (implies force-private) journals BOTH entries', async () => {
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 9.8, // 98% → deregister
        windowSince: 'x', windowUntil: 'y',
        byProvider: [{ key: 'openai', estimatedCostUsd: 9.7 }],
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
    expect(entries.some((e) => e.action === 'force-private')).toBe(true);
    expect(entries.some((e) => e.action === 'deregister-dry-run')).toBe(true);
  });

  test('warn + noop never emit a force-private entry', async () => {
    const tools = makeClient({
      'nova.ops.cost.snapshot': {
        totalEstimatedCostUsd: 6, // 60% → warn
        windowSince: 'x', windowUntil: 'y',
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
    expect(entries.some((e) => e.action === 'force-private')).toBe(false);
  });
});
