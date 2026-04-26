import { describe, expect, test } from 'bun:test';
import { applyCompositeEntries } from '../src/workload/gateway-catalog/apply.js';
import type { SiriusProvider } from '../src/config/sirius-providers.js';

const baseDerived: SiriusProvider = {
  name: 'mc-llama',
  kind: 'openai-compatible',
  baseUrl: 'http://h:1/v1',
} as SiriusProvider;

describe('applyCompositeEntries — sirius', () => {
  test('appends new entry on empty current', () => {
    const r = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [],
    });
    expect(r.changed).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.next.length).toBe(1);
    const o = (r.next[0] as any).ownership;
    expect(o.compositeNames).toEqual(['mc']);
    expect(o.specHash).toBeTruthy();
  });

  test('idempotent on re-apply by same composite (same shape)', () => {
    const first = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [],
    });
    const second = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: first.next as SiriusProvider[],
    });
    expect(second.changed).toBe(false);
  });

  test('unions compositeNames when same shape from different composite', () => {
    const first = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [],
    });
    const second = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'other',
      derived: [baseDerived],
      current: first.next as SiriusProvider[],
    });
    expect(second.changed).toBe(true);
    const o = (second.next[0] as any).ownership;
    expect(o.compositeNames.sort()).toEqual(['mc', 'other']);
  });

  test('shape mismatch between two composites returns conflict', () => {
    const first = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [],
    });
    const second = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'other',
      derived: [{ ...baseDerived, baseUrl: 'http://different:1/v1' }],
      current: first.next as SiriusProvider[],
    });
    expect(second.conflicts.length).toBe(1);
    expect(second.conflicts[0]!.kind).toBe('shape');
    expect(second.conflicts[0]!.name).toBe('mc-llama');
  });

  test('name collision against operator entry returns conflict', () => {
    const operator: SiriusProvider = {
      name: 'mc-llama',
      kind: 'openai',
      apiKeyRef: '$OPENAI',
    } as SiriusProvider;
    const r = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [operator],
    });
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]!.kind).toBe('name');
    expect(r.conflicts[0]!.detail).toBe('operator');
  });
});
