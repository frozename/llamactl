// packages/remote/test/gateway-catalog-derive-sirius.test.ts
import { describe, expect, test } from 'bun:test';
import { deriveSiriusEntries } from '../src/workload/gateway-catalog/sirius-entries';
import type { CompositeGatewayContext } from '../src/workload/gateway-handlers/types';

const ctx: CompositeGatewayContext = {
  compositeName: 'mc',
  upstreams: [
    { name: 'llama-31-8b', endpoint: 'http://host.lan:8080/v1', nodeName: 'macbook-pro' },
    { name: 'qwen-72b', endpoint: 'http://atlas.lan:8080/v1', nodeName: 'atlas' },
  ],
  providerConfig: { tags: ['vision'], displayName: 'My Llama' },
};

describe('deriveSiriusEntries', () => {
  test('produces one openai-compatible provider per upstream', () => {
    const out = deriveSiriusEntries(ctx);
    expect(out.length).toBe(2);
    expect(out.every((e) => e.kind === 'openai-compatible')).toBe(true);
  });

  test('names are deterministic: <compositeName>-<upstream.name>', () => {
    const out = deriveSiriusEntries(ctx);
    expect(out.map((e) => e.name)).toEqual(['mc-llama-31-8b', 'mc-qwen-72b']);
  });

  test('baseUrl flows from upstream.endpoint', () => {
    const out = deriveSiriusEntries(ctx);
    expect(out[0]!.baseUrl).toBe('http://host.lan:8080/v1');
  });

  test('displayName from providerConfig wins per-entry', () => {
    const out = deriveSiriusEntries(ctx);
    expect(out[0]!.displayName).toBe('My Llama');
  });

  test('empty upstreams returns []', () => {
    expect(deriveSiriusEntries({ ...ctx, upstreams: [] })).toEqual([]);
  });
});
