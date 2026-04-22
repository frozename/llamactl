import { describe, expect, test } from 'bun:test';

import {
  CliBindingSchema,
  ClusterNodeSchema,
} from '../src/config/schema.js';

describe('CliBindingSchema', () => {
  test('applies preset defaults and accepts minimal shape', () => {
    const b = CliBindingSchema.parse({ name: 'claude-pro', preset: 'claude' });
    expect(b.name).toBe('claude-pro');
    expect(b.preset).toBe('claude');
    expect(b.format).toBe('text');
    expect(b.timeoutMs).toBe(120_000);
    expect(b.advertisedModels).toEqual([]);
    expect(b.capabilities).toEqual(['reasoning']);
  });

  test('name regex rejects uppercase / slashes / leading hyphen', () => {
    expect(() => CliBindingSchema.parse({ name: 'Claude-Pro' })).toThrow();
    expect(() => CliBindingSchema.parse({ name: 'claude/pro' })).toThrow();
    expect(() => CliBindingSchema.parse({ name: '-claude' })).toThrow();
  });

  test('preset=custom requires nothing inline (adapter enforces command/args)', () => {
    const b = CliBindingSchema.parse({ name: 'cust', preset: 'custom' });
    expect(b.preset).toBe('custom');
  });

  test('accepts env overrides + subscription label', () => {
    const b = CliBindingSchema.parse({
      name: 'codex-plus',
      preset: 'codex',
      env: { CODEX_MODEL: 'gpt-5' },
      subscription: 'chatgpt-plus-alex',
    });
    expect(b.env?.CODEX_MODEL).toBe('gpt-5');
    expect(b.subscription).toBe('chatgpt-plus-alex');
  });
});

describe('ClusterNodeSchema refine — CLI bindings are agent-only', () => {
  test('agent node with cli[] parses', () => {
    const n = ClusterNodeSchema.parse({
      name: 'mac-mini',
      endpoint: 'https://mac-mini.lan:7843',
      kind: 'agent',
      cli: [{ name: 'claude-pro', preset: 'claude' }],
    });
    expect(n.cli?.[0]?.name).toBe('claude-pro');
  });

  test('gateway node with cli[] rejected', () => {
    expect(() =>
      ClusterNodeSchema.parse({
        name: 'sirius',
        endpoint: 'https://sirius.lan:3000',
        kind: 'gateway',
        cloud: { provider: 'sirius', baseUrl: 'https://sirius.lan:3000' },
        cli: [{ name: 'claude-pro', preset: 'claude' }],
      }),
    ).toThrow();
  });

  test('rag node with cli[] rejected (cli only on agents)', () => {
    expect(() =>
      ClusterNodeSchema.parse({
        name: 'kb-pg',
        kind: 'rag',
        rag: {
          provider: 'pgvector',
          endpoint: 'postgres://kb@db:5432/kb',
          collection: 'docs',
        },
        cli: [{ name: 'claude-pro', preset: 'claude' }],
      }),
    ).toThrow();
  });

  test('empty cli[] on an agent is accepted (treated as no bindings)', () => {
    const n = ClusterNodeSchema.parse({
      name: 'mac-mini',
      endpoint: 'https://mac-mini.lan:7843',
      kind: 'agent',
      cli: [],
    });
    expect(n.cli).toEqual([]);
  });
});
