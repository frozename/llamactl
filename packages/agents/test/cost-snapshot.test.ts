import { describe, expect, test } from 'bun:test';
import { runRunbook, type RunbookToolClient, type ToolCallInput } from '../src/index.js';

/**
 * cost-snapshot is read-only; it invokes nova.ops.cost.snapshot once
 * and ranks the response. Test uses a mock MCP tool client to assert
 * routing + summary shape without booting MCP.
 */

function makeClient(
  responses: Record<string, unknown>,
): { client: RunbookToolClient; calls: string[] } {
  const calls: string[] = [];
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      calls.push(input.name);
      const payload = responses[input.name];
      if (payload === undefined) throw new Error(`unexpected tool call: ${input.name}`);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  };
  return { client, calls };
}

describe('cost-snapshot runbook', () => {
  test('passes days + topN through, trims groups to topN, composes summary', async () => {
    const providerGroups = Array.from({ length: 10 }, (_, i) => ({
      key: `provider-${i}`,
      requestCount: 10 - i,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: (10 - i) * 1000,
      avgLatencyMs: 100 + i,
    }));
    const modelGroups = Array.from({ length: 10 }, (_, i) => ({
      key: `provider/model-${i}`,
      requestCount: 10 - i,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: (10 - i) * 500,
      avgLatencyMs: 120 + i,
    }));
    const { client, calls } = makeClient({
      'nova.ops.cost.snapshot': {
        windowSince: '2026-04-12T00:00:00Z',
        windowUntil: '2026-04-19T00:00:00Z',
        filesScanned: 3,
        malformedLines: 0,
        totalRequests: 55,
        totalTokens: 55000,
        byProvider: providerGroups,
        byModel: modelGroups,
      },
    });
    const result = await runRunbook<{ days: number; topN: number }>(
      'cost-snapshot',
      { days: 7, topN: 3 },
      { toolClient: client },
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['nova.ops.cost.snapshot']);
    const summary = result.summary as {
      totalRequests: number;
      topProviders: Array<{ key: string }>;
      topModels: Array<{ key: string }>;
    };
    expect(summary.totalRequests).toBe(55);
    expect(summary.topProviders.map((g) => g.key)).toEqual([
      'provider-0',
      'provider-1',
      'provider-2',
    ]);
    expect(summary.topModels).toHaveLength(3);
  });

  test('applies default params when caller omits them', async () => {
    const { client } = makeClient({
      'nova.ops.cost.snapshot': {
        windowSince: 'x',
        windowUntil: 'y',
        filesScanned: 0,
        malformedLines: 0,
        totalRequests: 0,
        totalTokens: 0,
        byProvider: [],
        byModel: [],
      },
    });
    const result = await runRunbook('cost-snapshot', {}, { toolClient: client });
    expect(result.ok).toBe(true);
    const summary = result.summary as { topProviders: unknown[] };
    expect(summary.topProviders).toEqual([]);
  });
});
