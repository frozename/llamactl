import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentContext,
  defaultConfigPath,
  loadConfig,
  removeNode,
  resolveNode,
  resolveToken,
  saveConfig,
  upsertCluster,
  upsertNode,
} from '../src/config/kubeconfig.js';
import {
  ConfigSchema,
  freshConfig,
  LOCAL_NODE_ENDPOINT,
  LOCAL_NODE_NAME,
} from '../src/config/schema.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-kcfg-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('kubeconfig', () => {
  test('loadConfig returns fresh defaults when file absent', () => {
    const path = join(tmp, 'no-such-config');
    const cfg = loadConfig(path);
    expect(cfg.apiVersion).toBe('llamactl/v1');
    expect(cfg.currentContext).toBe('default');
    expect(cfg.clusters[0]?.nodes[0]?.name).toBe(LOCAL_NODE_NAME);
    expect(cfg.clusters[0]?.nodes[0]?.endpoint).toBe(LOCAL_NODE_ENDPOINT);
  });

  test('saveConfig + loadConfig round-trip preserves structure', () => {
    const path = join(tmp, 'config');
    const original = freshConfig();
    saveConfig(original, path);
    const yaml = readFileSync(path, 'utf8');
    expect(yaml).toContain('apiVersion: llamactl/v1');
    expect(yaml).toContain('kind: Config');
    const roundtrip = loadConfig(path);
    expect(roundtrip).toEqual(original);
  });

  test('saveConfig refuses to persist invalid config', () => {
    const path = join(tmp, 'config');
    const bad = { ...freshConfig(), apiVersion: 'wrong/v0' };
    expect(() => saveConfig(bad as never, path)).toThrow();
  });

  test('loadConfig rejects malformed YAML', () => {
    const path = join(tmp, 'config');
    writeFileSync(path, 'apiVersion: llamactl/v1\nkind: NotAConfig\n', 'utf8');
    expect(() => loadConfig(path)).toThrow();
  });

  test('resolveNode returns node, context, and user', () => {
    let cfg = freshConfig();
    cfg = upsertNode(cfg, 'home', {
      name: 'gpu1',
      endpoint: 'https://gpu1.lan:7843',
      certificateFingerprint: 'sha256:aa',
    });
    const resolved = resolveNode(cfg, 'gpu1');
    expect(resolved.node.endpoint).toBe('https://gpu1.lan:7843');
    expect(resolved.context.name).toBe('default');
    expect(resolved.user.name).toBe('me');
  });

  test('resolveNode throws when node is missing', () => {
    const cfg = freshConfig();
    expect(() => resolveNode(cfg, 'nope')).toThrow(/not found/);
  });

  test('upsertNode adds then replaces same node by name', () => {
    let cfg = freshConfig();
    cfg = upsertNode(cfg, 'home', { name: 'a', endpoint: 'https://a:1' });
    cfg = upsertNode(cfg, 'home', { name: 'a', endpoint: 'https://a:2' });
    const found = cfg.clusters.find((c) => c.name === 'home')?.nodes.filter((n) => n.name === 'a');
    expect(found).toHaveLength(1);
    expect(found?.[0]?.endpoint).toBe('https://a:2');
  });

  test('removeNode removes a remote node but refuses to remove local', () => {
    let cfg = freshConfig();
    cfg = upsertNode(cfg, 'home', { name: 'gpu1', endpoint: 'https://gpu1:7843' });
    cfg = removeNode(cfg, 'home', 'gpu1');
    expect(cfg.clusters.find((c) => c.name === 'home')?.nodes.map((n) => n.name))
      .toEqual([LOCAL_NODE_NAME]);
    expect(() => removeNode(cfg, 'home', LOCAL_NODE_NAME)).toThrow(/refusing/);
  });

  test('resolveToken reads inline token', () => {
    const cfg = freshConfig();
    const user = cfg.users[0]!;
    expect(resolveToken(user)).toBe('inproc-local');
  });

  test('resolveToken reads tokenRef path and trims', () => {
    const tokenPath = join(tmp, 'mytoken');
    writeFileSync(tokenPath, '  secret-token  \n', 'utf8');
    expect(resolveToken({ name: 'u', tokenRef: tokenPath })).toBe('secret-token');
  });

  test('currentContext throws when config references unknown context', () => {
    const cfg = { ...freshConfig(), currentContext: 'missing' };
    expect(() => currentContext(cfg)).toThrow(/not found/);
  });

  test('upsertCluster adds a new cluster', () => {
    let cfg = freshConfig();
    cfg = upsertCluster(cfg, {
      name: 'lan',
      nodes: [{ name: 'a', endpoint: 'https://a:1' }],
    });
    expect(cfg.clusters.map((c) => c.name).sort()).toEqual(['home', 'lan']);
  });

  test('defaultConfigPath honors LLAMACTL_CONFIG override', () => {
    const override = join(tmp, 'explicit');
    expect(defaultConfigPath({ LLAMACTL_CONFIG: override })).toBe(override);
  });

  test('defaultConfigPath falls back to DEV_STORAGE/config', () => {
    expect(defaultConfigPath({ DEV_STORAGE: '/foo' })).toBe('/foo/config');
  });

  test('schema allows both token and tokenRef on a user', () => {
    const cfg = freshConfig();
    cfg.users.push({ name: 'other', tokenRef: '/tmp/t', token: 'x' });
    expect(() => ConfigSchema.parse(cfg)).not.toThrow();
  });

  test('schema rejects a user with neither token nor tokenRef', () => {
    const cfg = freshConfig();
    cfg.users.push({ name: 'bad' });
    expect(() => ConfigSchema.parse(cfg)).toThrow();
  });
});
