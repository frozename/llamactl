import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { router } from '../src/router.js';
import type { Composite } from '../src/composite/schema.js';
import { saveComposite } from '../src/composite/store.js';

/**
 * Phase 5 of composite-infra.md — router-level coverage for the
 * composite procedures. We test dry-run + list + get here; wet-run
 * apply is covered by `composite-apply.test.ts` (which injects a
 * fake `RuntimeBackend` directly into `applyComposite`). The router
 * composes the backend via `getCompositeRuntime()` which is not
 * injectable — exercising it in tests would require a live Docker
 * daemon, which we deliberately skip here.
 */

let runtimeDir = '';
let compositesDir = '';
let configPath = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-composite-router-'));
  compositesDir = join(runtimeDir, 'composites');
  configPath = join(runtimeDir, 'config');
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LLAMACTL_COMPOSITES_DIR: compositesDir,
    LLAMACTL_CONFIG: configPath,
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
});

function sampleManifest(overrides: Partial<Composite['spec']> = {}): Composite {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Composite',
    metadata: { name: 'kb-stack' },
    spec: {
      services: [
        {
          kind: 'chroma',
          name: 'chroma-1',
          node: 'local',
          runtime: 'docker',
          port: 8001,
          image: { repository: 'chromadb/chroma', tag: '1.5.8' },
        },
      ],
      workloads: [],
      ragNodes: [
        {
          name: 'kb',
          node: 'local',
          binding: {
            provider: 'chroma',
            // Non-empty placeholder — the applier auto-wires the
            // real endpoint from the backing service at apply time.
            endpoint: 'placeholder',
            extraArgs: [],
          },
          backingService: 'chroma-1',
        },
      ],
      gateways: [],
      dependencies: [],
      onFailure: 'rollback',
      ...overrides,
    },
  };
}

describe('router compositeApply — dry-run', () => {
  test('valid manifest returns { dryRun, manifest, order, impliedEdges }', async () => {
    const caller = router.createCaller({});
    const yaml = stringifyYaml(sampleManifest());
    const res = await caller.compositeApply({ manifestYaml: yaml, dryRun: true });
    expect(res.dryRun).toBe(true);
    if (!res.dryRun) throw new Error('type narrowing failed');
    expect(res.manifest.metadata.name).toBe('kb-stack');
    expect(res.order).toHaveLength(2); // service + rag
    // Service must come before the rag that depends on it (implicit
    // edge rag/kb → service/chroma-1).
    const serviceIdx = res.order.findIndex(
      (r) => r.kind === 'service' && r.name === 'chroma-1',
    );
    const ragIdx = res.order.findIndex((r) => r.kind === 'rag' && r.name === 'kb');
    expect(serviceIdx).toBeLessThan(ragIdx);
    // impliedEdges picks up the rag.backingService auto-wire.
    expect(res.impliedEdges).toHaveLength(1);
    expect(res.impliedEdges[0]?.from).toEqual({ kind: 'rag', name: 'kb' });
    expect(res.impliedEdges[0]?.to).toEqual({ kind: 'service', name: 'chroma-1' });
  });

  test('invalid YAML surfaces BAD_REQUEST', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.compositeApply({ manifestYaml: 'not: [valid: yaml', dryRun: true }),
    ).rejects.toThrow(/invalid composite manifest/);
  });

  test('manifest missing required fields surfaces BAD_REQUEST', async () => {
    const caller = router.createCaller({});
    // apiVersion is required — omit it.
    const bad = stringifyYaml({
      kind: 'Composite',
      metadata: { name: 'x' },
      spec: { services: [], workloads: [], ragNodes: [], gateways: [] },
    });
    await expect(
      caller.compositeApply({ manifestYaml: bad, dryRun: true }),
    ).rejects.toThrow(/invalid composite manifest/);
  });
});

describe('router compositeList + compositeGet', () => {
  test('empty directory → empty list', async () => {
    const caller = router.createCaller({});
    const listed = await caller.compositeList();
    expect(listed).toEqual([]);
  });

  test('compositeList returns saved composites sorted by name', async () => {
    const a = { ...sampleManifest(), metadata: { name: 'alpha' } } satisfies Composite;
    const b = { ...sampleManifest(), metadata: { name: 'zeta' } } satisfies Composite;
    saveComposite(a, compositesDir);
    saveComposite(b, compositesDir);

    const caller = router.createCaller({});
    const listed = await caller.compositeList();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.metadata.name).toBe('alpha');
    expect(listed[1]?.metadata.name).toBe('zeta');
  });

  test('compositeGet returns the stored manifest', async () => {
    const m = sampleManifest();
    saveComposite(m, compositesDir);
    const caller = router.createCaller({});
    const got = await caller.compositeGet({ name: 'kb-stack' });
    expect(got).not.toBeNull();
    expect(got?.metadata.name).toBe('kb-stack');
    expect(got?.spec.services[0]?.name).toBe('chroma-1');
  });

  test('compositeGet returns null when absent', async () => {
    const caller = router.createCaller({});
    const got = await caller.compositeGet({ name: 'does-not-exist' });
    expect(got).toBeNull();
  });
});

describe('router compositeDestroy — dry-run', () => {
  test('dry-run returns reverse-topo order without deleting', async () => {
    saveComposite(sampleManifest(), compositesDir);
    const caller = router.createCaller({});
    const res = await caller.compositeDestroy({ name: 'kb-stack', dryRun: true });
    expect(res.dryRun).toBe(true);
    if (!res.dryRun) throw new Error('type narrowing failed');
    expect(res.name).toBe('kb-stack');
    expect(res.wouldRemove).toHaveLength(2);
    // Reverse-topo: rag (depends on service) tears down before service.
    expect(res.wouldRemove[0]?.kind).toBe('rag');
    expect(res.wouldRemove[1]?.kind).toBe('service');

    // YAML still there (dry-run doesn't touch disk).
    const still = await caller.compositeGet({ name: 'kb-stack' });
    expect(still).not.toBeNull();
  });

  test('destroy of missing composite surfaces NOT_FOUND', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.compositeDestroy({ name: 'never-existed', dryRun: true }),
    ).rejects.toThrow(/not found/);
  });
});
