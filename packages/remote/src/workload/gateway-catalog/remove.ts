import type { CompositeOwnership } from './schema.js';

type AnyEntry = Record<string, unknown> & { ownership?: CompositeOwnership };

export interface RemoveOpts<T> {
  kind: 'sirius' | 'embersynth';
  compositeName: string;
  current: T[];
}

export interface RemoveResult<T> {
  next: T[];
  changed: boolean;
  removedNames: string[];
}

const KEY_OF: Record<string, string> = { sirius: 'name', embersynth: 'id' };

export function removeCompositeEntries<T extends AnyEntry>(
  opts: RemoveOpts<T>,
): RemoveResult<T> {
  const key = KEY_OF[opts.kind]!;
  const next: T[] = [];
  const removedNames: string[] = [];
  let changed = false;

  for (const e of opts.current) {
    if (!e.ownership) {
      next.push(e);
      continue;
    }
    if (!e.ownership.compositeNames.includes(opts.compositeName)) {
      next.push(e);
      continue;
    }
    const remaining = e.ownership.compositeNames.filter((n) => n !== opts.compositeName);
    changed = true;
    if (remaining.length === 0) {
      removedNames.push(String((e as any)[key]));
      continue;
    }
    next.push({ ...e, ownership: { ...e.ownership, compositeNames: remaining } } as T);
  }

  return { next, changed, removedNames };
}
