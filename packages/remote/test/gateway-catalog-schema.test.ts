import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSiriusProviders,
  saveSiriusProviders,
} from '../src/config/sirius-providers.js';
import { loadEmbersynthConfig, saveEmbersynthConfig } from '../src/config/embersynth.js';
import { CompositeOwnershipSchema } from '../src/workload/gateway-catalog/schema.js';

describe('CompositeOwnership schema', () => {
  test('accepts shape with non-empty compositeNames', () => {
    const ok = CompositeOwnershipSchema.safeParse({
      source: 'composite',
      compositeNames: ['a'],
      specHash: 'h1',
    });
    expect(ok.success).toBe(true);
  });

  test('rejects empty compositeNames', () => {
    const out = CompositeOwnershipSchema.safeParse({
      source: 'composite',
      compositeNames: [],
      specHash: 'h1',
    });
    expect(out.success).toBe(false);
  });
});

describe('SiriusProvider schema with ownership', () => {
  let tmp: string;
  let path: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sp-'));
    path = join(tmp, 'sirius-providers.yaml');
    prev = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = path;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('round-trips ownership marker', () => {
    saveSiriusProviders([
      {
        name: 'mc-llama',
        kind: 'openai-compatible',
        baseUrl: 'http://host.lan:8080/v1',
        ownership: {
          source: 'composite',
          compositeNames: ['mc'],
          specHash: 'abc',
        },
      } as any,
    ]);
    const out = loadSiriusProviders();
    expect(out[0]!.ownership).toEqual({
      source: 'composite',
      compositeNames: ['mc'],
      specHash: 'abc',
    } as any);
  });

  test('parses operator entry without ownership marker', () => {
    saveSiriusProviders([
      { name: 'openai', kind: 'openai', apiKeyRef: '$OPENAI' } as any,
    ]);
    const out = loadSiriusProviders();
    expect(out[0]!.name).toBe('openai');
    expect((out[0] as any).ownership).toBeUndefined();
  });
});

describe('EmbersynthNode schema with ownership', () => {
  let tmp: string;
  let path: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'em-'));
    path = join(tmp, 'embersynth.yaml');
    prev = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    process.env.LLAMACTL_EMBERSYNTH_CONFIG = path;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('round-trips ownership marker on a node', () => {
    saveEmbersynthConfig({
      nodes: [
        {
          id: 'mc-llama',
          label: 'mc/llama',
          endpoint: 'http://host.lan:8080/v1',
          transport: 'http',
          enabled: true,
          capabilities: ['reasoning'],
          tags: ['vision'],
          providerType: 'openai-compatible',
          modelId: 'default',
          priority: 5,
          ownership: {
            source: 'composite',
            compositeNames: ['mc'],
            specHash: 'abc',
          },
        } as any,
      ],
      profiles: [],
      syntheticModels: {},
      server: { host: '127.0.0.1', port: 7777 },
    });
    const out = loadEmbersynthConfig();
    expect((out!.nodes[0] as any).ownership.compositeNames).toEqual(['mc']);
  });
});