import { describe, expect, test } from 'bun:test';

import { tierOf } from '../src/index.js';

/**
 * Phase 5 of composite-infra.md — severity classifier entries for
 * the four Composite MCP tools. Tier drives the healer's `--auto`
 * gate; getting this wrong means either (a) tier-3 destroys slip
 * into auto-execution or (b) tier-1 reads are blocked unnecessarily.
 *
 * Classification is suffix-based in `severity.ts`:
 *   `.list`     → tier 1 (read)
 *   `.apply`    → tier 2 (mutation-dry-run-safe)
 *   `.destroy`  → tier 3 (destructive)
 *
 * `.get` falls through to the tier-2 default (unknown suffix); the
 * healer treats it conservatively. The ops-chat dispatch layer has
 * its own tier override (`read`) for UI approval flow — the two
 * classifiers don't have to agree on reads because the healer's job
 * is to refuse auto-execution of anything risky, and a tier-2 floor
 * is strictly safer there.
 */

describe('Composite severity tiers', () => {
  test('llamactl.composite.list classifies as tier 1 (read)', () => {
    expect(tierOf('llamactl.composite.list')).toBe(1);
  });

  test('llamactl.composite.apply classifies as tier 2 (mutation-dry-run-safe)', () => {
    expect(tierOf('llamactl.composite.apply')).toBe(2);
  });

  test('llamactl.composite.destroy classifies as tier 3 (destructive)', () => {
    expect(tierOf('llamactl.composite.destroy')).toBe(3);
  });

  test('generic *.destroy suffix stays tier 3 for any namespace', () => {
    expect(tierOf('nova.cluster.destroy')).toBe(3);
    expect(tierOf('custom.foo.destroy')).toBe(3);
  });
});
