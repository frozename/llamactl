import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server.js';

/**
 * Smoke test: spin up the llamactl MCP server in-process, wire it to a
 * client via the SDK's InMemoryTransport, and exercise the tool
 * surface. If this passes, the server is well-formed enough for
 * Claude Code or any other MCP-speaking client to connect over stdio.
 */

async function connected() {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('@llamactl/mcp smoke', () => {
  test('listTools advertises the llamactl tool surface', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'llamactl.bench.compare',
      'llamactl.catalog.list',
      'llamactl.node.ls',
    ]);
  });

  test('callTool(llamactl.catalog.list) returns a JSON blob', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'llamactl.catalog.list',
      arguments: { scope: 'builtin' },
    });
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    expect(content?.type).toBe('text');
    const parsed = JSON.parse(content!.text) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    // The builtin catalog is hardcoded; it should never be empty.
    expect(parsed.length).toBeGreaterThan(0);
  });

  test('callTool(llamactl.node.ls) returns the current cluster shape', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'llamactl.node.ls',
      arguments: {},
    });
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    expect(content?.type).toBe('text');
    const parsed = JSON.parse(content!.text) as {
      context: string | null;
      cluster: string | null;
      nodes: Array<{ name: string; kind: string }>;
    };
    expect(parsed).toHaveProperty('nodes');
    expect(Array.isArray(parsed.nodes)).toBe(true);
    // Every node the helper surfaces should advertise an agent/gateway/provider kind.
    for (const n of parsed.nodes) {
      expect(['agent', 'gateway', 'provider']).toContain(n.kind);
    }
  });
});
