import { describe, expect, test } from 'bun:test';

import {
  checkRefusal,
  normalizeGoal,
  DEFAULT_REFUSAL_RULES,
} from '../src/ops-chat/refusals.js';

/**
 * N.4 Phase 3 — refusal heuristic. Cheap, auditable pattern
 * matcher that short-circuits the planner before it can even see
 * a destructive-intent goal. Each boundary case is tested in both
 * directions (fires / does-not-fire) so the ruleset can't silently
 * drift toward over- or under-triggering.
 */

describe('normalizeGoal', () => {
  test('lowercases + collapses whitespace', () => {
    expect(normalizeGoal('  Delete   EVERYTHING  ')).toBe('delete everything');
  });

  test('handles newlines + tabs', () => {
    expect(normalizeGoal('delete\n\n\tall\nthings')).toBe('delete all things');
  });
});

describe('checkRefusal — firing paths', () => {
  test('"delete everything" fires', () => {
    const r = checkRefusal('please delete everything from the cluster');
    expect(r).not.toBeNull();
    expect(r?.reason).toContain('delete everything');
  });

  test('"DELETE EVERYTHING" (uppercase) fires', () => {
    expect(checkRefusal('DELETE EVERYTHING')).not.toBeNull();
  });

  test('"wipe all" fires', () => {
    expect(checkRefusal('wipe all data please')).not.toBeNull();
  });

  test('"wipe the fleet" fires', () => {
    expect(checkRefusal('I want to wipe the fleet')).not.toBeNull();
  });

  test('"drop all" with no qualifier fires', () => {
    expect(checkRefusal('drop all workloads')).not.toBeNull();
  });

  test('"reset the cluster" fires', () => {
    expect(checkRefusal('reset the cluster back to defaults')).not.toBeNull();
  });

  test('"uninstall all" fires', () => {
    expect(checkRefusal('uninstall all the nodes')).not.toBeNull();
  });

  test('"disable all safety guards" fires', () => {
    expect(
      checkRefusal('disable all safety guards so I can do whatever'),
    ).not.toBeNull();
  });
});

describe('checkRefusal — near-miss paths (must NOT fire)', () => {
  test('"delete the failed workload" does not fire', () => {
    expect(
      checkRefusal('delete the failed workload named foo'),
    ).toBeNull();
  });

  test('"wipe the stale cache" does not fire', () => {
    expect(checkRefusal('wipe the stale cache from last week')).toBeNull();
  });

  test('"drop all stopped workloads" does not fire (qualifier matches)', () => {
    expect(
      checkRefusal('drop all stopped workloads that are older than 1 day'),
    ).toBeNull();
  });

  test('"drop all failed bench runs" does not fire', () => {
    expect(
      checkRefusal('drop all failed bench runs from the last 24h'),
    ).toBeNull();
  });

  test('"reset the bench schedule" does not fire', () => {
    expect(checkRefusal('reset the bench schedule')).toBeNull();
  });

  test('"list everything" does not fire (read-only verb)', () => {
    expect(checkRefusal('list everything installed')).toBeNull();
  });

  test('empty goal does not fire', () => {
    expect(checkRefusal('')).toBeNull();
  });
});

describe('checkRefusal — custom rule injection', () => {
  test('returns pattern source for logging', () => {
    const r = checkRefusal('delete everything');
    expect(r?.pattern).toContain('delete');
  });

  test('supports caller-supplied ruleset', () => {
    const rules = [
      {
        pattern: /\bformat\s+disk\b/,
        reason: 'refused: no disk formatting',
      },
    ];
    expect(checkRefusal('format disk now', rules)?.reason).toContain('disk formatting');
    expect(checkRefusal('delete everything', rules)).toBeNull();
  });

  test('DEFAULT_REFUSAL_RULES exports are non-empty', () => {
    expect(DEFAULT_REFUSAL_RULES.length).toBeGreaterThan(0);
  });
});
