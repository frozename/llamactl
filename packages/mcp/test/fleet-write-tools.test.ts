import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFleetTools } from '../src/tools/fleet.js';

type SpawnFn = typeof import('node:child_process').spawn;

function mockSpawn(
  opts: { code: number; stdout?: string; stderr?: string },
  calls: Array<{ cmd: string; args: string[] }> = [],
): SpawnFn {
  return ((cmd: string, args: string[], _options?: SpawnOptions) => {
    calls.push({ cmd, args });
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
      proc.emit('close', opts.code);
    });
    return proc as unknown as ChildProcess;
  }) as unknown as SpawnFn;
}

async function connected(deps?: { spawn?: SpawnFn }) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerFleetTools(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client };
}

function textOf(result: unknown): string {
  const c = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return c[0]?.text ?? '';
}

function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

// ── llamactl_admit_measure ────────────────────────────────────────────────────

describe('llamactl_admit_measure', () => {
  test('success (code 0) returns ok:true with stdout', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0, stdout: '{"peakMb":1024}' }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, 'llamactl_admit_measure', { workload: 'gemma4' });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; stdout: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.stdout).toBe('{"peakMb":1024}');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('bun');
    expect(calls[0]!.args).toContain('admit');
    expect(calls[0]!.args).toContain('measure');
    expect(calls[0]!.args).toContain('gemma4');
  });

  test('failure (non-zero code) returns ok:false with code', async () => {
    const spawnFn = mockSpawn({ code: 1, stderr: 'workload not found' });
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, 'llamactl_admit_measure', { workload: 'missing-wl' });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; code: number; stderr: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(1);
    expect(parsed.stderr).toBe('workload not found');
  });

  test('node flag is appended to args when provided', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    await call(client, 'llamactl_admit_measure', { workload: 'granite', node: 'mac-mini' });
    expect(calls[0]!.args).toContain('--node=mac-mini');
  });
});

// ── llamactl_supervisor_execute ───────────────────────────────────────────────

describe('llamactl_supervisor_execute', () => {
  test('proposalId mode passes --execute flag', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0, stdout: 'executed' }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, 'llamactl_supervisor_execute', { proposalId: 'prop-42' });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    expect(calls[0]!.args).toContain('supervisor');
    expect(calls[0]!.args).toContain('--once');
    expect(calls[0]!.args).toContain('--execute=prop-42');
    expect(calls[0]!.args).not.toContain('--auto');
  });

  test('auto mode passes --auto flag', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    await call(client, 'llamactl_supervisor_execute', { auto: true });
    expect(calls[0]!.args).toContain('--auto');
    expect(calls[0]!.args).not.toSatisfy((a: string[]) => a.some((x) => x.startsWith('--execute=')));
  });

  test('severityThreshold is propagated in auto mode', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    await call(client, 'llamactl_supervisor_execute', { auto: true, severityThreshold: 2 });
    expect(calls[0]!.args).toContain('--severity-threshold=2');
  });

  test('node flag is appended when provided', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    await call(client, 'llamactl_supervisor_execute', { auto: true, node: 'mac-mini' });
    expect(calls[0]!.args).toContain('--node=mac-mini');
  });

  test('neither proposalId nor auto returns validation error without spawning', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, 'llamactl_supervisor_execute', {});
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  test('both proposalId and auto returns validation error without spawning', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = mockSpawn({ code: 0 }, calls);
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, 'llamactl_supervisor_execute', {
      proposalId: 'prop-1',
      auto: true,
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  test('non-zero exit returns ok:false', async () => {
    const spawnFn = mockSpawn({ code: 2, stderr: 'proposal not found' });
    const { client } = await connected({ spawn: spawnFn });

    const result = await call(client, 'llamactl_supervisor_execute', { proposalId: 'bad-id' });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; code: number };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(2);
  });
});
