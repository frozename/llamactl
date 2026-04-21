import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMcpServer } from '../src/server.js';

/**
 * Phase 5 of composite-infra.md — the 4 Composite MCP tools (apply,
 * destroy, list, get) must be registered with the correct names and
 * input schemas mirroring the tRPC `composite{Apply,Destroy,List,Get}`
 * procedure inputs.
 *
 * Execution-path assertions live in `packages/remote/test/composite-
 * apply.test.ts` (applier + rollback) and `packages/remote/test/
 * composite-router.test.ts` (dry-run + list/get through the caller).
 * The MCP server is a thin caller shim, so we only test registration
 * + schema shape here.
 */

let runtimeDir = '';
let auditDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-mcp-composite-'));
  auditDir = mkdtempSync(join(tmpdir(), 'llamactl-mcp-composite-audit-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, 'preset-overrides.tsv'),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, 'embersynth.yaml'),
    LLAMACTL_CONFIG: join(runtimeDir, 'config'),
    LLAMACTL_COMPOSITES_DIR: join(runtimeDir, 'composites'),
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

describe('@llamactl/mcp Composite tool registration', () => {
  test('listTools includes the four llamactl.composite.* tools', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain('llamactl.composite.apply');
    expect(names).toContain('llamactl.composite.destroy');
    expect(names).toContain('llamactl.composite.list');
    expect(names).toContain('llamactl.composite.get');
  });

  test('llamactl.composite.apply advertises the manifestYaml+dryRun shape', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'llamactl.composite.apply');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('Apply a Composite manifest');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('manifestYaml');
    expect(schema.properties).toHaveProperty('dryRun');
    // manifestYaml has no default and is therefore required; dryRun
    // defaults to false and is optional.
    expect(schema.required).toContain('manifestYaml');
  });

  test('llamactl.composite.destroy advertises the name+dryRun+purgeVolumes shape', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'llamactl.composite.destroy');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('Destroy a Composite');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('name');
    expect(schema.properties).toHaveProperty('dryRun');
    expect(schema.properties).toHaveProperty('purgeVolumes');
    // Only `name` is required — dryRun and purgeVolumes both default.
    expect(schema.required).toContain('name');
    expect(schema.required ?? []).not.toContain('purgeVolumes');
  });

  test('llamactl.composite.list advertises no required input', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'llamactl.composite.list');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('List Composites');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    // No required fields — `{}` input is valid.
    expect(schema.required ?? []).toEqual([]);
  });

  test('llamactl.composite.get advertises the name-only shape', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'llamactl.composite.get');
    expect(tool).toBeDefined();
    expect(tool!.title).toBe('Get one Composite');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('name');
    expect(schema.required).toContain('name');
    expect(schema.required).toHaveLength(1);
  });
});
