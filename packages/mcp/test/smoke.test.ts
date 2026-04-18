import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpServer } from '../src/server.js';

/**
 * Smoke tests for the llamactl MCP surface. Every mutation has a
 * dry-run + wet-run case; the audit sink is scoped to a tempdir so
 * tests never touch `~/.llamactl/mcp/audit/*`.
 */

let runtimeDir = '';
let auditDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-mcp-runtime-'));
  auditDir = mkdtempSync(join(tmpdir(), 'llamactl-mcp-audit-'));
  // Scope llamactl state (preset-overrides.tsv etc.) + audit writes
  // into the sandbox so no test touches the real `~/.llamactl`.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, 'preset-overrides.tsv'),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, 'embersynth.yaml'),
    LLAMACTL_CONFIG: join(runtimeDir, 'config'),
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
  return { client, server };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

function auditLines(server: string): Array<Record<string, unknown>> {
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir).filter((f) => f.startsWith(`${server}-`));
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const body = readFileSync(join(auditDir, f), 'utf8');
    for (const line of body.trim().split('\n')) {
      if (line) out.push(JSON.parse(line));
    }
  }
  return out;
}

describe('@llamactl/mcp read surface', () => {
  test('listTools advertises the full read + mutation surface', async () => {
    const { client } = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'llamactl.bench.compare',
      'llamactl.catalog.list',
      'llamactl.catalog.promote',
      'llamactl.catalog.promoteDelete',
      'llamactl.embersynth.sync',
      'llamactl.node.ls',
      'llamactl.promotions.list',
    ]);
  });

  test('llamactl.catalog.list returns curated entries', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'llamactl.catalog.list',
      arguments: { scope: 'builtin' },
    });
    const parsed = JSON.parse(textOf(result)) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });
});

describe('@llamactl/mcp mutations', () => {
  test('catalog.promote dry-run previews without writing or emitting a wet audit', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'llamactl.catalog.promote',
      arguments: {
        profile: 'macbook-pro-48g',
        preset: 'best',
        rel: 'acme/model-Q4.gguf',
        dryRun: true,
      },
    });
    const parsed = JSON.parse(textOf(result)) as { dryRun: boolean; message: string };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.message).toContain('acme/model-Q4.gguf');

    // No file written.
    expect(existsSync(join(runtimeDir, 'preset-overrides.tsv'))).toBe(false);

    // Audit captures the dry-run.
    const audits = auditLines('llamactl');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.tool).toBe('llamactl.catalog.promote');
    expect(audits[0]!.dryRun).toBe(true);
  });

  test('catalog.promote wet-run writes TSV and audits the action', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'llamactl.catalog.promote',
      arguments: {
        profile: 'macbook-pro-48g',
        preset: 'best',
        rel: 'acme/model-Q4.gguf',
        dryRun: false,
      },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; promotions: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.promotions).toHaveLength(1);

    const tsv = readFileSync(join(runtimeDir, 'preset-overrides.tsv'), 'utf8');
    expect(tsv).toContain('acme/model-Q4.gguf');

    const audits = auditLines('llamactl');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.dryRun).toBe(false);
    expect((audits[0]!.result as { ok: boolean }).ok).toBe(true);
  });

  test('catalog.promoteDelete round-trips', async () => {
    const { client } = await connected();
    await client.callTool({
      name: 'llamactl.catalog.promote',
      arguments: {
        profile: 'macbook-pro-48g',
        preset: 'best',
        rel: 'acme/model-Q4.gguf',
        dryRun: false,
      },
    });

    // Dry-run delete — still there.
    const dry = await client.callTool({
      name: 'llamactl.catalog.promoteDelete',
      arguments: { profile: 'macbook-pro-48g', preset: 'best', dryRun: true },
    });
    const dryParsed = JSON.parse(textOf(dry)) as { dryRun: boolean; prior: { rel: string } | null };
    expect(dryParsed.dryRun).toBe(true);
    expect(dryParsed.prior?.rel).toBe('acme/model-Q4.gguf');

    // Wet-run delete — gone.
    const wet = await client.callTool({
      name: 'llamactl.catalog.promoteDelete',
      arguments: { profile: 'macbook-pro-48g', preset: 'best', dryRun: false },
    });
    const wetParsed = JSON.parse(textOf(wet)) as { ok: boolean; removed: boolean };
    expect(wetParsed.ok).toBe(true);
    expect(wetParsed.removed).toBe(true);
  });

  test('embersynth.sync dry-run reports would-be config without writing', async () => {
    const yamlPath = join(runtimeDir, 'embersynth.yaml');
    const { client } = await connected();
    const result = await client.callTool({
      name: 'llamactl.embersynth.sync',
      arguments: { path: yamlPath, dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as {
      dryRun: boolean;
      profiles: string[];
      syntheticModels: string[];
    };
    expect(parsed.dryRun).toBe(true);
    // Default profiles include `private-first` from K.4.
    expect(parsed.profiles).toContain('private-first');
    expect(parsed.syntheticModels).toContain('fusion-private-first');
    expect(existsSync(yamlPath)).toBe(false);
  });

  test('embersynth.sync wet-run writes the YAML', async () => {
    const yamlPath = join(runtimeDir, 'embersynth.yaml');
    const { client } = await connected();
    const result = await client.callTool({
      name: 'llamactl.embersynth.sync',
      arguments: { path: yamlPath, dryRun: false },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(existsSync(yamlPath)).toBe(true);
    const body = readFileSync(yamlPath, 'utf8');
    expect(body).toContain('private-first');
  });
});
