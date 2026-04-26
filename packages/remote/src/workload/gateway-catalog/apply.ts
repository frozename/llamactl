import { entrySpecHash } from './hash.js';
import type { ApplyConflict, CompositeOwnership } from './schema.js';

type AnyEntry = Record<string, unknown> & { ownership?: CompositeOwnership };

export interface ApplyOpts<T> {
  kind: 'sirius' | 'embersynth';
  compositeName: string;
  derived: T[];
  current: T[];
}

export interface ApplyResult<T> {
  next: T[];
  changed: boolean;
  conflicts: ApplyConflict[];
}

const KEY_OF: Record<string, string> = { sirius: 'name', embersynth: 'id' };

export function applyCompositeEntries<T extends AnyEntry>(
  opts: ApplyOpts<T>,
): ApplyResult<T> {
  const key = KEY_OF[opts.kind]!;
  const map = new Map<string, T>();
  for (const e of opts.current) {
    map.set(String((e as any)[key]), e);
  }
  const conflicts: ApplyConflict[] = [];
  let changed = false;

  for (const d of opts.derived) {
    const k = String((d as any)[key]);
    const existing = map.get(k);
    const newHash = entrySpecHash(d);

    if (!existing) {
      const next = {
        ...d,
        ownership: {
          source: 'composite' as const,
          compositeNames: [opts.compositeName],
          specHash: newHash,
        },
      };
      map.set(k, next as T);
      changed = true;
      continue;
    }

    if (!existing.ownership) {
      conflicts.push({ kind: 'name', name: k, detail: 'operator' });
      continue;
    }

    const existingHash = entrySpecHash(existing);
    if (existingHash !== newHash) {
      conflicts.push({
        kind: 'shape',
        name: k,
        detail: `existing shape (specHash=${existingHash}) does not match composite-derived shape (specHash=${newHash})`,
      });
      continue;
    }

    if (existing.ownership.compositeNames.includes(opts.compositeName)) {
      // Already owned by this composite + same shape → no-op.
      continue;
    }

    const next = {
      ...existing,
      ownership: {
        ...existing.ownership,
        compositeNames: [...existing.ownership.compositeNames, opts.compositeName].sort(),
        specHash: newHash,
      },
    };
    map.set(k, next as T);
    changed = true;
  }

  return { next: [...map.values()], changed, conflicts };
}
