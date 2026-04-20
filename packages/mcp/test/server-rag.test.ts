import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMcpServer } from '../src/server.js';

/**
 * Phase 5 of rag-nodes.md — the 4 RAG MCP tools (search, store,
 * delete, listCollections) must be registered with the correct names
 * and input schemas mirroring the tRPC `ragX` procedure inputs.
 *
 * Execution-path assertions live in
 * `packages/remote/test/router-rag.test.ts` (adapter dispatch) and
 * `packages/remote/test/ops-chat-dispatch.test.ts` (ops-chat
 * routing). The MCP server is a thin caller shim over the tRPC
 * procedures, so we only test registration + schema shape here.
 */

let runtimeDir = '';
let auditDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-mcp-rag-'));
  auditDir = mkdtempSync(join(tmpdir(), 'llamactl-mcp-rag-audit-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, 'preset-overrides.tsv'),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, 'embersynth.yaml'),
    LLAMACTL_CONFIG: join(runtimeDir, 'config'),
    LLAMACTL_MCP_PIPELINES_DIR: join(runtimeDir, 'mcp-pipelines'),
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

async function connected() {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client };
}

describe('@llamactl/mcp RAG tool registration', () => {
  test('listTools includes the four llamactl.rag.* tools', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain('llamactl.rag.search');
    expect(names).toContain('llamactl.rag.store');
    expect(names).toContain('llamactl.rag.delete');
    expect(names).toContain('llamactl.rag.listCollections');
  });

  test('llamactl.rag.search advertises the node+query+topK+filter+collection shape', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'llamactl.rag.search');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('Search a RAG node');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('node');
    expect(schema.properties).toHaveProperty('query');
    expect(schema.properties).toHaveProperty('topK');
    expect(schema.properties).toHaveProperty('filter');
    expect(schema.properties).toHaveProperty('collection');
    // topK has a default and is therefore optional; node + query stay required.
    expect(schema.required).toContain('node');
    expect(schema.required).toContain('query');
  });

  test('llamactl.rag.store advertises the node+documents shape', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'llamactl.rag.store');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('Store documents in a RAG node');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('node');
    expect(schema.properties).toHaveProperty('documents');
    expect(schema.properties).toHaveProperty('collection');
    expect(schema.required).toContain('node');
    expect(schema.required).toContain('documents');
  });

  test('llamactl.rag.delete advertises the node+ids shape', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'llamactl.rag.delete');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('Delete documents from a RAG node');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('node');
    expect(schema.properties).toHaveProperty('ids');
    expect(schema.properties).toHaveProperty('collection');
    expect(schema.required).toContain('node');
    expect(schema.required).toContain('ids');
  });

  test('llamactl.rag.listCollections advertises the node-only shape', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'llamactl.rag.listCollections');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('List collections on a RAG node');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('node');
    expect(schema.required).toContain('node');
    // No other required fields.
    expect(schema.required).toHaveLength(1);
  });
});
