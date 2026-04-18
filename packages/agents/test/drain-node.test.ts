import { describe, expect, test } from 'bun:test';
import { runRunbook, type RunbookToolClient, type ToolCallInput } from '../src/index.js';

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
      return { content: [{ type: 'text', text: JSON.stringify(handler(input.arguments)) }] };
    },
  };
  return { client, calls };
}

function listPayload(rows: Array<{ name: string; node: string }>): unknown {
  return {
    count: rows.length,
    workloads: rows.map((r) => ({
      name: r.name,
      node: r.node,
      rel: 'x/y.gguf',
      gateway: false,
      status: null,
    })),
  };
}

describe('drain-node runbook', () => {
  test('deletes matching workloads then removes the node (dry-run)', async () => {
    const { client, calls } = makeClient({
      'llamactl.workload.list': () =>
        listPayload([
          { name: 'gpu1-llama', node: 'gpu1' },
          { name: 'gpu2-qwen', node: 'gpu2' },
          { name: 'gpu1-vision', node: 'gpu1' },
        ]),
      'llamactl.workload.delete': (args) => ({ dryRun: args.dryRun, name: args.name }),
      'llamactl.node.remove': (args) => ({ dryRun: args.dryRun, name: args.name }),
    });

    const result = await runRunbook('drain-node', { node: 'gpu1' }, {
      dryRun: true,
      log: () => {},
      toolClient: client,
    });

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual([
      'llamactl.workload.list',
      'llamactl.workload.delete',
      'llamactl.workload.delete',
      'llamactl.node.remove',
    ]);
    const deletes = calls.filter((c) => c.name === 'llamactl.workload.delete');
    expect(deletes.map((c) => c.arguments.name).sort()).toEqual(['gpu1-llama', 'gpu1-vision']);
    for (const d of deletes) expect(d.arguments.dryRun).toBe(true);
    const nodeRemove = calls.find((c) => c.name === 'llamactl.node.remove')!;
    expect(nodeRemove.arguments.node ?? nodeRemove.arguments.name).toBe('gpu1');
    expect(nodeRemove.arguments.dryRun).toBe(true);

    const summary = result.summary as { node: string; drainedWorkloads: string[]; nodeRemoved: boolean };
    expect(summary.node).toBe('gpu1');
    expect(summary.drainedWorkloads.sort()).toEqual(['gpu1-llama', 'gpu1-vision']);
    expect(summary.nodeRemoved).toBe(true);
  });

  test('keepNode:true skips node.remove', async () => {
    const { client, calls } = makeClient({
      'llamactl.workload.list': () => listPayload([{ name: 'w1', node: 'keepme' }]),
      'llamactl.workload.delete': () => ({ dryRun: false }),
    });

    const result = await runRunbook('drain-node', { node: 'keepme', keepNode: true }, {
      dryRun: false,
      log: () => {},
      toolClient: client,
    });
    expect(result.ok).toBe(true);
    expect(calls.every((c) => c.name !== 'llamactl.node.remove')).toBe(true);
    const summary = result.summary as { nodeRemoved: boolean };
    expect(summary.nodeRemoved).toBe(false);
  });

  test('no matching workloads still attempts node.remove', async () => {
    const { client, calls } = makeClient({
      'llamactl.workload.list': () => listPayload([{ name: 'w1', node: 'other' }]),
      'llamactl.node.remove': (args) => ({ name: args.name }),
    });
    const result = await runRunbook('drain-node', { node: 'gone' }, {
      dryRun: false,
      log: () => {},
      toolClient: client,
    });
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual([
      'llamactl.workload.list',
      'llamactl.node.remove',
    ]);
    const summary = result.summary as { drainedWorkloads: string[] };
    expect(summary.drainedWorkloads).toEqual([]);
  });

  test('rejects missing node param', async () => {
    await expect(
      runRunbook('drain-node', {} as unknown as { node: string }, {
        log: () => {},
      }),
    ).rejects.toThrow(/invalid params/);
  });
});
