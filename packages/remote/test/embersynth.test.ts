import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  generateEmbersynthConfig,
  loadEmbersynthConfig,
  listSyntheticModelIds,
  saveEmbersynthConfig,
  DEFAULT_EMBERSYNTH_PROFILES,
} from '../src/config/embersynth.js';
import type { Config } from '../src/config/schema.js';

/**
 * Covers the llamactl → embersynth config bridge:
 *   * `init` generates a valid config from kubeconfig + sirius-providers.
 *   * `sync` regenerates the nodes block while preserving profiles.
 *   * `syntheticModels` seeds the synth-node fanout.
 */

let tmp = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-embersynth-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function makeCfgWithAgent(): Config {
  return {
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
            name: 'gpu1',
            endpoint: 'https://gpu1.lan:7843',
            certificateFingerprint: 'sha256:abc',
          },
        ],
      },
    ],
    users: [{ name: 'me', token: 'agent-bearer' }],
  };
}

describe('embersynth config bridge', () => {
  test('generateEmbersynthConfig derives nodes from agents + sirius providers', () => {
    const siriusFile = join(tmp, 'sirius-providers.yaml');
    writeFileSync(
      siriusFile,
      stringifyYaml({
        apiVersion: 'llamactl/v1',
        kind: 'SiriusProviderList',
        providers: [
          {
            name: 'openai',
            kind: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKeyRef: '$OPENAI_API_KEY',
          },
          {
            name: 'anthropic',
            kind: 'anthropic',
            baseUrl: 'https://api.anthropic.com/v1',
            apiKeyRef: '$ANTHROPIC_API_KEY',
          },
        ],
      }),
    );
    process.env.LLAMACTL_SIRIUS_PROVIDERS = siriusFile;

    const cfg = generateEmbersynthConfig({ cfg: makeCfgWithAgent() });

    // agent: `gpu1` is included; `local` (inproc) is skipped.
    const agentIds = cfg.nodes.filter((n) => n.id.startsWith('agent-')).map((n) => n.id);
    expect(agentIds).toEqual(['agent-gpu1']);

    // sirius providers come through with capability guesses applied.
    const openai = cfg.nodes.find((n) => n.id === 'provider-openai');
    expect(openai?.capabilities).toEqual(['reasoning', 'tools', 'json_mode']);
    const anthropic = cfg.nodes.find((n) => n.id === 'provider-anthropic');
    expect(anthropic?.capabilities).toEqual(['reasoning', 'long_context', 'tools']);

    // auth translates apiKeyRef → bearer token. (Kept as `$ENV_VAR`
    // placeholder; embersynth expands env vars via its YAML loader.)
    expect(openai?.auth).toEqual({ type: 'bearer', token: '$OPENAI_API_KEY' });

    // Default profiles seeded; syntheticModels map covers them.
    expect(cfg.profiles.map((p) => p.id).sort()).toEqual([
      'auto',
      'fast',
      'private',
      'private-first',
      'vision',
    ]);
    expect(cfg.syntheticModels).toEqual({
      'fusion-auto': 'auto',
      'fusion-fast': 'fast',
      'fusion-private': 'private',
      'fusion-private-first': 'private-first',
      'fusion-vision': 'vision',
    });
  });

  test('private-first profile has preferred tags and falls back', () => {
    const cfg = generateEmbersynthConfig({ cfg: makeCfgWithAgent() });
    const pf = cfg.profiles.find((p) => p.id === 'private-first');
    expect(pf).toBeTruthy();
    expect(pf!.preferredTags).toEqual(['private']);
    expect(pf!.preferLowerPriority).toBe(true);
    // Soft preference — no requiredTags means cloud nodes stay eligible.
    expect(pf!.requiredTags).toBeUndefined();
  });

  test('sync preserves hand-edited profiles + syntheticModels', () => {
    const existing = generateEmbersynthConfig({ cfg: makeCfgWithAgent() });
    existing.profiles.push({
      id: 'custom',
      label: 'My Custom Profile',
      description: 'hand-rolled routing',
      requiredTags: ['private'],
    });
    existing.syntheticModels['fusion-custom'] = 'custom';

    const re = generateEmbersynthConfig({
      cfg: makeCfgWithAgent(),
      existing,
    });

    expect(re.profiles.map((p) => p.id)).toContain('custom');
    expect(re.syntheticModels['fusion-custom']).toBe('custom');
  });

  test('listSyntheticModelIds returns the keys of syntheticModels', () => {
    const cfg = generateEmbersynthConfig({ cfg: makeCfgWithAgent() });
    const ids = listSyntheticModelIds(cfg);
    expect(ids).toEqual(
      Object.keys(cfg.syntheticModels).sort(),
    );
  });

  test('bench records drive priority + contextWindow per agent', () => {
    const cfg = makeCfgWithAgent();
    const history = [
      {
        updated_at: '2026-04-01T00:00:00Z',
        machine: 'gpu1',
        rel: 'org/model-Q4.gguf',
        mode: 'text' as const,
        ctx: '32768',
        build: 'b4000',
        profile: 'long',
        gen_ts: '72.5',
        prompt_ts: '850',
        launch_args: '--flash-attn',
      },
    ];
    const out = generateEmbersynthConfig({ cfg, benchHistory: history });
    const gpu1 = out.nodes.find((n) => n.id === 'agent-gpu1');
    expect(gpu1).toBeTruthy();
    expect(gpu1!.priority).toBe(1);
    expect(gpu1!.optimization?.contextWindow).toBe(32768);
    expect(gpu1!.modelId).toBe('org/model-Q4.gguf');
  });

  test('agent without bench records gets neutral priority 5 + no optimization', () => {
    const out = generateEmbersynthConfig({
      cfg: makeCfgWithAgent(),
      benchHistory: [],
    });
    const gpu1 = out.nodes.find((n) => n.id === 'agent-gpu1');
    expect(gpu1?.priority).toBe(5);
    expect(gpu1?.optimization).toBeUndefined();
  });

  test('priority bands span gen_ts ranges deterministically', () => {
    const base = makeCfgWithAgent();
    const makeHistory = (genTps: string) => [
      {
        updated_at: '2026-04-01T00:00:00Z',
        machine: 'gpu1',
        rel: 'x/y.gguf',
        mode: 'text' as const,
        ctx: '8192',
        build: 'b1',
        profile: 'p',
        gen_ts: genTps,
        prompt_ts: '100',
        launch_args: '',
      },
    ];
    const slow = generateEmbersynthConfig({ cfg: base, benchHistory: makeHistory('3.0') });
    expect(slow.nodes.find((n) => n.id === 'agent-gpu1')?.priority).toBe(8);
    const mid = generateEmbersynthConfig({ cfg: base, benchHistory: makeHistory('20.0') });
    expect(mid.nodes.find((n) => n.id === 'agent-gpu1')?.priority).toBe(4);
    const fast = generateEmbersynthConfig({ cfg: base, benchHistory: makeHistory('45.0') });
    expect(fast.nodes.find((n) => n.id === 'agent-gpu1')?.priority).toBe(2);
  });

  test('loadEmbersynthConfig returns null when file absent, round-trips when saved', () => {
    const path = join(tmp, 'embersynth.yaml');
    expect(loadEmbersynthConfig(path)).toBeNull();
    const cfg = generateEmbersynthConfig({ cfg: makeCfgWithAgent() });
    saveEmbersynthConfig(cfg, path);
    const loaded = loadEmbersynthConfig(path);
    expect(loaded).toBeTruthy();
    expect(loaded!.profiles.length).toBe(DEFAULT_EMBERSYNTH_PROFILES.length);
    expect(loaded!.nodes.length).toBe(cfg.nodes.length);
  });
});
