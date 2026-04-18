import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { runRunbook } from '../src/index.js';

/**
 * Golden-path end-to-end test — runs a runbook against the real
 * @llamactl/mcp server (no mock toolClient). Proves the runbook +
 * harness + MCP server + underlying helpers wire together correctly.
 *
 * This is the N.5 marquee demo distilled: fresh fleet, scoped entirely
 * into a tempdir, runbook drives a complete audit-fleet against the
 * real tools, summary payload matches expectations.
 */

let runtimeDir = '';
let auditDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-e2e-golden-'));
  auditDir = mkdtempSync(join(tmpdir(), 'llamactl-e2e-audit-'));

  // Seed a kubeconfig with one local agent + one cloud gateway.
  writeFileSync(
    join(runtimeDir, 'config'),
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
      clusters: [
        {
          name: 'home',
          nodes: [
            { name: 'local', endpoint: 'inproc://local' },
            {
              name: 'sirius-primary',
              endpoint: '',
              kind: 'gateway',
              cloud: { provider: 'sirius', baseUrl: 'http://127.0.0.1:1/v1' },
            },
          ],
        },
      ],
      users: [{ name: 'me', token: 'local' }],
    }),
  );

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

describe('golden-path: audit-fleet against real @llamactl/mcp', () => {
  test('runbook drives the full tool surface and surfaces a coherent fleet snapshot', async () => {
    const result = await runRunbook('audit-fleet', {}, { log: () => {} });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.tool)).toEqual([
      'llamactl.node.ls',
      'llamactl.promotions.list',
      'llamactl.workload.list',
      'llamactl.server.status',
      'llamactl.bench.compare',
    ]);
    const summary = result.summary as {
      cluster: string | null;
      nodes: Array<{ name: string; kind: string }>;
      promotions: unknown[];
      workloads: unknown[];
      installedAndBenched: unknown[];
    };
    expect(summary.cluster).toBe('home');
    // Kubeconfig seeded above: 1 agent + 1 gateway = 2 nodes.
    expect(summary.nodes).toHaveLength(2);
    const kinds = summary.nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(['agent', 'gateway']);
    // Fresh fleet — no promotions, no workloads, no installed models.
    expect(summary.promotions).toEqual([]);
    expect(summary.workloads).toEqual([]);
    expect(summary.installedAndBenched).toEqual([]);
  });
});
