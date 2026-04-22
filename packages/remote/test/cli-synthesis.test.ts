import { describe, expect, test } from 'bun:test';

import {
  findCliBindingForNode,
  synthesizeProviderNodes,
} from '../src/config/provider-nodes.js';
import { CliBindingSchema, freshConfig } from '../src/config/schema.js';
import type { CliBinding, CliPreset } from '../src/config/schema.js';
import {
  loadConfig,
  resolveNode,
  saveConfig,
  upsertNode,
} from '../src/config/kubeconfig.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'bun:test';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-cli-synth-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeBinding(name: string, preset: CliPreset): CliBinding {
  return CliBindingSchema.parse({ name, preset });
}

function makeConfigWithAgent(
  clis: Array<{ name: string; preset: CliPreset }>,
): ReturnType<typeof freshConfig> {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, 'home', {
    name: 'mac-mini',
    endpoint: 'https://mac-mini.lan:7843',
    kind: 'agent',
    cli: clis.map((c) => makeBinding(c.name, c.preset)),
  });
  return cfg;
}

describe('synthesizeProviderNodes — CLI bindings', () => {
  test('emits one virtual provider node per (agent, cli binding) with source=cli', () => {
    const cfg = makeConfigWithAgent([
      { name: 'claude-pro', preset: 'claude' },
      { name: 'gemini-free', preset: 'gemini' },
    ]);
    const synth = synthesizeProviderNodes(cfg);
    const names = synth.map((n) => n.name).sort();
    expect(names).toContain('mac-mini.claude-pro');
    expect(names).toContain('mac-mini.gemini-free');
    const claude = synth.find((n) => n.name === 'mac-mini.claude-pro')!;
    expect(claude.kind).toBe('provider');
    expect(claude.provider?.source).toBe('cli');
    expect(claude.provider?.gateway).toBe('mac-mini');
    expect(claude.provider?.providerName).toBe('claude-pro');
  });

  test('agent without cli[] does not emit any cli virtual nodes', () => {
    const cfg = makeConfigWithAgent([]);
    const synth = synthesizeProviderNodes(cfg);
    const cliNodes = synth.filter((n) => n.provider?.source === 'cli');
    expect(cliNodes).toEqual([]);
  });

  test('multiple agents each contribute their own cli bindings', () => {
    let cfg = freshConfig();
    cfg = upsertNode(cfg, 'home', {
      name: 'mac-mini',
      endpoint: 'https://mac-mini.lan:7843',
      kind: 'agent',
      cli: [makeBinding('claude-pro', 'claude')],
    });
    cfg = upsertNode(cfg, 'home', {
      name: 'laptop',
      endpoint: 'https://laptop.lan:7843',
      kind: 'agent',
      cli: [makeBinding('codex-plus', 'codex')],
    });
    const synth = synthesizeProviderNodes(cfg);
    const names = synth.map((n) => n.name).sort();
    expect(names).toContain('mac-mini.claude-pro');
    expect(names).toContain('laptop.codex-plus');
  });
});

describe('findCliBindingForNode', () => {
  test('resolves a dotted <agent>.<cli> name to the hosting agent + binding', () => {
    const cfg = makeConfigWithAgent([{ name: 'claude-pro', preset: 'claude' }]);
    const hit = findCliBindingForNode(cfg, 'mac-mini.claude-pro');
    expect(hit).not.toBeNull();
    expect(hit!.agentName).toBe('mac-mini');
    expect(hit!.binding.name).toBe('claude-pro');
    expect(hit!.binding.preset).toBe('claude');
  });

  test('returns null when the name does not match the dotted shape', () => {
    const cfg = makeConfigWithAgent([{ name: 'claude-pro', preset: 'claude' }]);
    expect(findCliBindingForNode(cfg, 'mac-mini')).toBeNull();
    expect(findCliBindingForNode(cfg, 'nope.nowhere')).toBeNull();
    expect(findCliBindingForNode(cfg, 'mac-mini.no-such-cli')).toBeNull();
  });
});

describe('resolveNode — CLI dotted lookup', () => {
  test('lazy-resolves an <agent>.<cli> name into a virtual provider node', () => {
    const cfg = makeConfigWithAgent([{ name: 'claude-pro', preset: 'claude' }]);
    const cfgPath = join(tmp, 'config');
    saveConfig(cfg, cfgPath);
    const loaded = loadConfig(cfgPath);
    const resolved = resolveNode(loaded, 'mac-mini.claude-pro');
    expect(resolved.node.kind).toBe('provider');
    expect(resolved.node.provider?.source).toBe('cli');
    expect(resolved.node.provider?.gateway).toBe('mac-mini');
    expect(resolved.node.provider?.providerName).toBe('claude-pro');
  });

  test('resolveNode throws for an unknown <agent>.<cli> pair', () => {
    const cfg = makeConfigWithAgent([{ name: 'claude-pro', preset: 'claude' }]);
    const cfgPath = join(tmp, 'config');
    saveConfig(cfg, cfgPath);
    const loaded = loadConfig(cfgPath);
    expect(() => resolveNode(loaded, 'mac-mini.gemini-free')).toThrow();
  });
});
