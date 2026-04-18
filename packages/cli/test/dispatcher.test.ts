import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_GLOBALS,
  extractGlobalFlags,
  isLocalDispatch,
  resolveEffectiveNodeName,
} from '../src/dispatcher.js';
import {
  config as kubecfg,
  configSchema,
} from '@llamactl/remote';

describe('extractGlobalFlags', () => {
  test('no global flags leaves argv untouched', () => {
    const r = extractGlobalFlags(['catalog', 'list']);
    expect(r.globals).toEqual(EMPTY_GLOBALS);
    expect(r.rest).toEqual(['catalog', 'list']);
  });

  test('--node <val> is extracted', () => {
    const r = extractGlobalFlags(['--node', 'gpu1', 'catalog', 'list']);
    expect(r.globals.nodeName).toBe('gpu1');
    expect(r.rest).toEqual(['catalog', 'list']);
  });

  test('-n <val> is extracted', () => {
    const r = extractGlobalFlags(['-n', 'gpu1', 'catalog', 'list']);
    expect(r.globals.nodeName).toBe('gpu1');
    expect(r.rest).toEqual(['catalog', 'list']);
  });

  test('--node=<val> is extracted', () => {
    const r = extractGlobalFlags(['--node=gpu1', 'catalog', 'list']);
    expect(r.globals.nodeName).toBe('gpu1');
    expect(r.rest).toEqual(['catalog', 'list']);
  });

  test('--context and --cluster-config extract', () => {
    const r = extractGlobalFlags([
      '--context', 'home',
      '--cluster-config=/tmp/cfg',
      'node', 'ls',
    ]);
    expect(r.globals.contextName).toBe('home');
    expect(r.globals.configPath).toBe('/tmp/cfg');
    expect(r.rest).toEqual(['node', 'ls']);
  });

  test('flags after -- are passed through untouched', () => {
    const r = extractGlobalFlags([
      'server', 'start', '--',
      '--node', 'gpu1',
    ]);
    expect(r.globals.nodeName).toBeNull();
    expect(r.rest).toEqual(['server', 'start', '--', '--node', 'gpu1']);
  });

  test('global flags can appear mid-argv', () => {
    const r = extractGlobalFlags([
      'catalog', 'list', '--node', 'gpu1', '--json',
    ]);
    expect(r.globals.nodeName).toBe('gpu1');
    expect(r.rest).toEqual(['catalog', 'list', '--json']);
  });

  test('missing value raises', () => {
    expect(() => extractGlobalFlags(['--node'])).toThrow(/requires a value/);
  });
});

describe('resolveEffectiveNodeName + isLocalDispatch', () => {
  let tmp: string;
  let cfgPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'llamactl-disp-'));
    cfgPath = join(tmp, 'config');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFresh(mutate?: (c: ReturnType<typeof configSchema.freshConfig>) => ReturnType<typeof configSchema.freshConfig>): void {
    let cfg = configSchema.freshConfig();
    if (mutate) cfg = mutate(cfg);
    kubecfg.saveConfig(cfg, cfgPath);
  }

  test('no --node, fresh config → local', () => {
    writeFresh();
    const env = { LLAMACTL_CONFIG: cfgPath };
    expect(resolveEffectiveNodeName({ ...EMPTY_GLOBALS, configPath: cfgPath }, env))
      .toBe('local');
    expect(isLocalDispatch({ ...EMPTY_GLOBALS, configPath: cfgPath }, env)).toBe(true);
  });

  test('--node gpu1 resolves to gpu1', () => {
    writeFresh((c) => kubecfg.upsertNode(c, 'home', {
      name: 'gpu1',
      endpoint: 'https://gpu1.lan:7843',
    }));
    const env = { LLAMACTL_CONFIG: cfgPath };
    const globals = { ...EMPTY_GLOBALS, nodeName: 'gpu1', configPath: cfgPath };
    expect(resolveEffectiveNodeName(globals, env)).toBe('gpu1');
    expect(isLocalDispatch(globals, env)).toBe(false);
  });

  test('--node local stays local', () => {
    writeFresh();
    const env = { LLAMACTL_CONFIG: cfgPath };
    const globals = { ...EMPTY_GLOBALS, nodeName: 'local', configPath: cfgPath };
    expect(isLocalDispatch(globals, env)).toBe(true);
  });
});
