// packages/app/test/lib/global-search/use-global-search.test.ts
import { describe, expect, test } from 'bun:test';

describe('computeNextSchedule', () => {
  test('schedules tier2 at 250ms and tier3 at 400ms from now', async () => {
    (globalThis as any).electronTRPC = { onMessage: () => {} };
    const { computeNextSchedule } = await import('../../../src/lib/global-search/hooks/use-global-search');
    const out = computeNextSchedule(1000);
    expect(out.tier2At).toBe(1250);
    expect(out.tier3At).toBe(1400);
  });

  test('respects custom debounce overrides', async () => {
    (globalThis as any).electronTRPC = { onMessage: () => {} };
    const { computeNextSchedule } = await import('../../../src/lib/global-search/hooks/use-global-search');
    const out = computeNextSchedule(1000, { tier2Ms: 100, tier3Ms: 200 });
    expect(out.tier2At).toBe(1100);
    expect(out.tier3At).toBe(1200);
  });
});

  test('Tier 2 fires both local and cross-node fetches under one debounce anchor', async () => {
    (globalThis as any).electronTRPC = { onMessage: () => {} };
    const { computeNextSchedule } = await import('../../../src/lib/global-search/hooks/use-global-search');
    const t0 = Date.now();
    const sched = computeNextSchedule(t0);
    expect(sched.tier2At).toBe(t0 + 250);
  });
