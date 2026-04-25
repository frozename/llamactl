import { describe, expect, test, mock } from 'bun:test';

mock.module('@/themes', () => ({}));
mock.module('@/ui', () => ({ Badge: () => null }));

import { statusGlyph, fmtMs } from '../../../src/modules/ops/detail/iteration-card';
import type { IterationView } from '../../../src/lib/use-ops-session';

const base: IterationView = {
  iteration: 0,
  stepId: 'sp-1',
  tool: 'llamactl.workload.list',
  tier: 'read',
  reasoning: '',
  args: {},
};

describe('statusGlyph', () => {
  test('returns · when no outcome attached', () => {
    expect(statusGlyph(base)).toBe('·');
  });

  test('returns ✓ when wet outcome ok', () => {
    expect(statusGlyph({ ...base, wet: { ok: true, durationMs: 1 } })).toBe('✓');
  });

  test('returns ✗ when wet outcome failed', () => {
    expect(statusGlyph({ ...base, wet: { ok: false, durationMs: 1 } })).toBe('✗');
  });

  test('falls back to preview outcome when wet absent', () => {
    expect(statusGlyph({ ...base, preview: { ok: true, durationMs: 1 } })).toBe('✓');
  });
});

describe('fmtMs', () => {
  test('< 1000ms → ms suffix', () => {
    expect(fmtMs(750)).toBe('750ms');
  });

  test('≥ 1000ms → seconds with one decimal', () => {
    expect(fmtMs(1234)).toBe('1.2s');
  });
});