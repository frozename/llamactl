import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_MODULES } from '../src/modules/registry';

/**
 * Drift gate: tests/ui-audit-modules.json (consumed by the ui-audit
 * pixel-regression driver via scripts/audit.sh) must stay in lockstep
 * with the module registry. The audit silently skips modules that are
 * missing from the JSON and hard-fails on ids/testids that no longer
 * exist, so any registry change has to be mirrored there.
 *
 * Regenerate with:
 *   bun -e 'import { APP_MODULES } from "./packages/app/src/modules/registry.ts";
 *     console.log(JSON.stringify(APP_MODULES.map((m) => {
 *       const e = { id: m.id, label: m.labelKey };
 *       if (m.smokeAffordance !== `${m.id}-root`) e.rootTestId = m.smokeAffordance;
 *       return e;
 *     }), null, 2));' > tests/ui-audit-modules.json
 * (then reseed baselines for any added module: scripts/audit.sh update)
 */

const MODULES_JSON_PATH = resolve(import.meta.dir, '../../../tests/ui-audit-modules.json');

interface AuditModuleEntry {
  id: string;
  label: string;
  rootTestId?: string;
}

describe('ui-audit-modules.json drift', () => {
  const actual = JSON.parse(readFileSync(MODULES_JSON_PATH, 'utf8')) as AuditModuleEntry[];

  const expected: AuditModuleEntry[] = APP_MODULES.map((m) => {
    const entry: AuditModuleEntry = { id: m.id, label: m.labelKey };
    if (m.smokeAffordance !== `${m.id}-root`) entry.rootTestId = m.smokeAffordance;
    return entry;
  });

  test('covers every registry module, in registry order, with matching labels/testids', () => {
    expect(actual).toEqual(expected);
  });

  test('driver derivation (rootTestId ?? `${id}-root`) resolves to each smokeAffordance', () => {
    // Locks the contract the driver relies on: when rootTestId is
    // omitted, `${id}-root` must BE the smokeAffordance.
    for (const [i, entry] of actual.entries()) {
      const derived = entry.rootTestId ?? `${entry.id}-root`;
      expect(derived).toBe(APP_MODULES[i]!.smokeAffordance);
    }
  });
});
