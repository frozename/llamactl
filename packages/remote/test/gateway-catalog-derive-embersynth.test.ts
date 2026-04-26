// packages/remote/test/gateway-catalog-derive-embersynth.test.ts
import { describe, expect, test } from 'bun:test';
import { deriveEmbersynthEntries } from '../src/workload/gateway-catalog/embersynth-entries';
import type { CompositeGatewayContext } from '../src/workload/gateway-handlers/types';

const ctx: CompositeGatewayContext = {
  compositeName: 'mc',
  upstreams: [
    { name: 'llama-31-8b', endpoint: 'http://host.lan:8080/v1', nodeName: 'macbook-pro' },
  ],
  providerConfig: { tags: ['vision'], priority: 3, displayName: 'Llama 3.1' },
};

describe('deriveEmbersynthEntries', () => {
  test('one upstream → one node entry', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out.length).toBe(1);
  });

  test('id is deterministic: <compositeName>-<upstream.name>', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out[0]!.id).toBe('mc-llama-31-8b');
  });

  test('endpoint flows from upstream.endpoint', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out[0]!.endpoint).toBe('http://host.lan:8080/v1');
  });

  test('tags flow into node.tags', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out[0]!.tags).toEqual(['vision']);
  });

  test('priority flows from providerConfig.priority', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out[0]!.priority).toBe(3);
  });

  test('default priority is 10 when providerConfig.priority absent', () => {
    const out = deriveEmbersynthEntries({ ...ctx, providerConfig: {} });
    expect(out[0]!.priority).toBe(10);
  });

  test('empty upstreams returns []', () => {
    expect(deriveEmbersynthEntries({ ...ctx, upstreams: [] })).toEqual([]);
  });
});
