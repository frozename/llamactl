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

describe('onboard-new-gpu-node runbook', () => {
  test('dry-run stops after the node.add preview', async () => {
    const { client, calls } = makeClient({
      'llamactl.node.add': (args) => ({
        dryRun: true,
        message: `would add node ${args.name}`,
        node: { name: args.name, endpoint: 'https://gpu1:7843' },
      }),
    });

    const result = await runRunbook(
      'onboard-new-gpu-node',
      { name: 'gpu1', bootstrap: 'b64-blob' },
      { dryRun: true, log: () => {}, toolClient: client },
    );

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['llamactl.node.add']);
    expect(calls[0]!.arguments.dryRun).toBe(true);
    const summary = result.summary as { dryRun: boolean; name: string };
    expect(summary.dryRun).toBe(true);
    expect(summary.name).toBe('gpu1');
  });

  test('wet-run adds + confirms + syncs embersynth', async () => {
    const { client, calls } = makeClient({
      'llamactl.node.add': (args) =>
        args.dryRun
          ? { dryRun: true, message: 'preview', node: { name: args.name } }
          : { ok: true, name: args.name, endpoint: 'https://gpu1:7843', fingerprint: 'sha256:abc' },
      'llamactl.node.ls': () => ({
        context: 'default',
        cluster: 'home',
        nodes: [
          { name: 'local', endpoint: 'inproc://local', kind: 'agent' },
          { name: 'gpu1', endpoint: 'https://gpu1:7843', kind: 'agent' },
        ],
      }),
      'llamactl.embersynth.sync': () => ({ ok: true, nodes: 1, profiles: 5 }),
    });

    const result = await runRunbook(
      'onboard-new-gpu-node',
      { name: 'gpu1', bootstrap: 'b64-blob' },
      { dryRun: false, log: () => {}, toolClient: client },
    );

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual([
      'llamactl.node.add', // dry-run preview
      'llamactl.node.add', // wet
      'llamactl.node.ls',
      'llamactl.embersynth.sync',
    ]);
    // The first node.add call is a dry-run, second is wet.
    expect(calls[0]!.arguments.dryRun).toBe(true);
    expect(calls[1]!.arguments.dryRun).toBe(false);
    // embersynth.sync forwarded dryRun: false too.
    expect(calls[3]!.arguments.dryRun).toBe(false);
    const summary = result.summary as { name: string; cluster: string; totalNodes: number };
    expect(summary.name).toBe('gpu1');
    expect(summary.cluster).toBe('home');
    expect(summary.totalNodes).toBe(2);
  });

  test('invalid bootstrap blob surfaces as ok:false without writing', async () => {
    const { client, calls } = makeClient({
      'llamactl.node.add': () => ({
        ok: false,
        error: 'invalid bootstrap blob: base64 decode failed',
      }),
    });
    const result = await runRunbook(
      'onboard-new-gpu-node',
      { name: 'gpu1', bootstrap: 'not-base64' },
      { dryRun: false, log: () => {}, toolClient: client },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/bootstrap blob rejected/);
    // Only the dry-run preview should have been attempted.
    expect(calls).toHaveLength(1);
  });

  test('failure mode: node missing after wet add', async () => {
    const { client } = makeClient({
      'llamactl.node.add': (args) =>
        args.dryRun
          ? { dryRun: true, message: 'preview', node: { name: args.name } }
          : { ok: true, name: args.name, endpoint: 'https://gpu1:7843' },
      'llamactl.node.ls': () => ({
        context: 'default',
        cluster: 'home',
        nodes: [{ name: 'local', endpoint: 'inproc://local', kind: 'agent' }],
      }),
    });
    const result = await runRunbook(
      'onboard-new-gpu-node',
      { name: 'gpu1', bootstrap: 'b64-blob' },
      { dryRun: false, log: () => {}, toolClient: client },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not visible in kubeconfig/);
  });

  test('rejects missing params', async () => {
    await expect(
      runRunbook(
        'onboard-new-gpu-node',
        {} as unknown as { name: string; bootstrap: string },
        { log: () => {} },
      ),
    ).rejects.toThrow(/invalid params/);
  });
});
