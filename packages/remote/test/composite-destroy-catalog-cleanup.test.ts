// packages/remote/test/composite-destroy-catalog-cleanup.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGatewayCatalog, readGatewayCatalog } from '../src/workload/gateway-catalog/io.js';
import { destroyComposite } from '../src/composite/apply.js';

describe('destroyComposite catalog cleanup', () => {
  let tmp: string;
  let prevSp: string | undefined;
  let prevEm: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cd-'));
    prevSp = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    prevEm = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'sp.yaml');
    process.env.LLAMACTL_EMBERSYNTH_CONFIG = join(tmp, 'em.yaml');
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as any;
  });

  afterEach(() => {
    if (prevSp === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prevSp;
    if (prevEm === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prevEm;
    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  const own = (names: string[]) => ({
    source: 'composite' as const,
    compositeNames: names,
    specHash: 'h',
  });

  test('removes solely-owned entries from sirius catalog', async () => {
    writeGatewayCatalog('sirius', [
      {
        name: 'mc-llama',
        kind: 'openai-compatible',
        baseUrl: 'http://h/v1',
        ownership: own(['mc']),
      } as any,
    ]);
    await destroyComposite({
      manifest: { apiVersion: 'llamactl/v1', kind: 'Composite', metadata: { name: 'mc', labels: {} }, spec: { services: [], workloads: [], ragNodes: [], gateways: [], dependencies: [] } } as any,
      backend: { destroyCompositeBoundary: async () => {} } as any,
      getWorkloadClient: () => ({} as any),
    });
    const after = readGatewayCatalog('sirius');
    expect(after.find((e) => e.name === 'mc-llama')).toBeUndefined();
  });

  test('keeps co-owned entries with shorter compositeNames', async () => {
    writeGatewayCatalog('sirius', [
      {
        name: 'mc-llama',
        kind: 'openai-compatible',
        baseUrl: 'http://h/v1',
        ownership: own(['mc', 'other']),
      } as any,
    ]);
    await destroyComposite({
      manifest: { apiVersion: 'llamactl/v1', kind: 'Composite', metadata: { name: 'mc', labels: {} }, spec: { services: [], workloads: [], ragNodes: [], gateways: [], dependencies: [] } } as any,
      backend: { destroyCompositeBoundary: async () => {} } as any,
      getWorkloadClient: () => ({} as any),
    });
    const after = readGatewayCatalog('sirius');
    expect(after[0]!.name).toBe('mc-llama');
    expect((after[0] as any).ownership.compositeNames).toEqual(['other']);
  });

  test('triggers reload only when changed', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response('ok', { status: 200 });
    }) as any;
    await destroyComposite({
      manifest: { apiVersion: 'llamactl/v1', kind: 'Composite', metadata: { name: 'mc', labels: {} }, spec: { services: [], workloads: [], ragNodes: [], gateways: [], dependencies: [] } } as any,
      backend: { destroyCompositeBoundary: async () => {} } as any,
      getWorkloadClient: () => ({} as any),
    });
    expect(calls.filter((c) => c.includes('/providers/reload')).length).toBe(0);
    expect(calls.filter((c) => c.includes('/config/reload')).length).toBe(0);
  });
});