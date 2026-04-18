import { describe, expect, test } from 'bun:test';
import { runRunbook, type RunbookToolClient, type ToolCallInput } from '../src/index.js';

/**
 * Runbook-flow tests. The real @llamactl/mcp surface is exercised by
 * its own smoke test suite; here we inject a mock tool client so the
 * asserts stay focused on what the RUNBOOK does — tool ordering, param
 * derivation, dry-run plumbing, failure paths — without dragging in
 * the catalog/bench/preset plumbing the tools themselves touch.
 */

interface Call { name: string; arguments: Record<string, unknown>; }

function makeClient(
  responses: Record<string, (args: Record<string, unknown>) => unknown>,
): { client: RunbookToolClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      calls.push({ name: input.name, arguments: input.arguments });
      const handler = responses[input.name];
      if (!handler) throw new Error(`unexpected tool call: ${input.name}`);
      const payload = handler(input.arguments);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  };
  return { client, calls };
}

const VISION_REL = 'acme/visionmax-Q4_K_M.gguf';

function benchResponse(rows: Array<{ rel: string; class: string; installed: boolean; gen_tps?: string }>) {
  return rows.map((r) => ({
    label: r.rel,
    rel: r.rel,
    class: r.class,
    installed: r.installed,
    scope: 'candidate',
    mode: 'vision',
    ctx: '4096',
    build: 'b1',
    machine: 'test',
    tuned: r.gen_tps ? { profile: 'default', gen_tps: r.gen_tps, prompt_tps: '120', updated_at: '', legacy: false } : null,
    vision: null,
  }));
}

describe('promote-fastest-vision-model runbook', () => {
  test('dry-run picks the fastest installed multimodal rel and fans out across profiles', async () => {
    const { client, calls } = makeClient({
      'llamactl.bench.compare': () =>
        benchResponse([
          { rel: VISION_REL, class: 'multimodal', installed: true, gen_tps: '42.0' },
          { rel: 'slow/vision-Q4.gguf', class: 'multimodal', installed: true, gen_tps: '11.0' },
          { rel: 'not-installed/vision-Q4.gguf', class: 'multimodal', installed: false, gen_tps: '99.0' },
        ]),
      'llamactl.catalog.promote': (args) => ({ dryRun: true, previewFor: args }),
      'llamactl.embersynth.sync': () => ({ dryRun: true, path: '/tmp/fake', nodes: 0 }),
    });

    const result = await runRunbook('promote-fastest-vision-model', {}, {
      dryRun: true,
      log: () => {},
      toolClient: client,
    });

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual([
      'llamactl.bench.compare',
      'llamactl.catalog.promote',
      'llamactl.catalog.promote',
      'llamactl.catalog.promote',
      'llamactl.embersynth.sync',
    ]);
    // All three promote calls target the top rel + vision preset + dryRun=true.
    const promoteCalls = calls.filter((c) => c.name === 'llamactl.catalog.promote');
    const profilesUsed = promoteCalls.map((c) => c.arguments.profile).sort();
    expect(profilesUsed).toEqual(['balanced', 'mac-mini-16g', 'macbook-pro-48g']);
    for (const c of promoteCalls) {
      expect(c.arguments.rel).toBe(VISION_REL);
      expect(c.arguments.preset).toBe('vision');
      expect(c.arguments.dryRun).toBe(true);
    }
    // embersynth.sync also forwarded dryRun.
    const syncCall = calls.find((c) => c.name === 'llamactl.embersynth.sync')!;
    expect(syncCall.arguments.dryRun).toBe(true);
  });

  test('single-profile variant constrains promote fan-out', async () => {
    const { client, calls } = makeClient({
      'llamactl.bench.compare': () =>
        benchResponse([{ rel: VISION_REL, class: 'multimodal', installed: true, gen_tps: '30.0' }]),
      'llamactl.catalog.promote': () => ({ dryRun: true }),
      'llamactl.embersynth.sync': () => ({ dryRun: true }),
    });
    const result = await runRunbook('promote-fastest-vision-model', { profile: 'macbook-pro-48g' }, {
      dryRun: true,
      log: () => {},
      toolClient: client,
    });
    expect(result.ok).toBe(true);
    const promoteCalls = calls.filter((c) => c.name === 'llamactl.catalog.promote');
    expect(promoteCalls).toHaveLength(1);
    expect(promoteCalls[0]!.arguments.profile).toBe('macbook-pro-48g');
  });

  test('wet-run forwards dryRun:false to mutation tools', async () => {
    const { client, calls } = makeClient({
      'llamactl.bench.compare': () =>
        benchResponse([{ rel: VISION_REL, class: 'multimodal', installed: true, gen_tps: '22.0' }]),
      'llamactl.catalog.promote': () => ({ ok: true }),
      'llamactl.embersynth.sync': () => ({ ok: true }),
    });
    const result = await runRunbook('promote-fastest-vision-model', {}, {
      dryRun: false,
      log: () => {},
      toolClient: client,
    });
    expect(result.ok).toBe(true);
    const mutations = calls.filter((c) => c.name !== 'llamactl.bench.compare');
    for (const c of mutations) {
      expect(c.arguments.dryRun).toBe(false);
    }
  });

  test('returns ok:false with a readable error when no benched installed multimodal rel is found', async () => {
    const { client } = makeClient({
      'llamactl.bench.compare': () =>
        benchResponse([
          // Installed but no bench record — filtered.
          { rel: VISION_REL, class: 'multimodal', installed: true },
          // Benched but not installed — also filtered.
          { rel: 'not-installed/vision.gguf', class: 'multimodal', installed: false, gen_tps: '99.0' },
        ]),
    });
    const result = await runRunbook('promote-fastest-vision-model', {}, {
      dryRun: true,
      log: () => {},
      toolClient: client,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no installed multimodal/);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.tool).toBe('llamactl.bench.compare');
  });

  test('invalid params surface at the harness boundary', async () => {
    await expect(
      runRunbook('promote-fastest-vision-model', { profile: 'nonexistent' } as unknown as { profile?: never }, {
        log: () => {},
      }),
    ).rejects.toThrow(/invalid params/);
  });

  test('unknown runbook throws', async () => {
    await expect(
      runRunbook('does-not-exist', {}, { log: () => {} }),
    ).rejects.toThrow(/unknown runbook/);
  });
});
