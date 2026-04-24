/**
 * Minimal class-name join: strings pass through, falsy are skipped,
 * records contribute their truthy-valued keys. Used across @/ui to
 * merge static classes with variant-driven ones without pulling in
 * clsx as a dependency.
 */

export type Value = string | false | null | undefined | Record<string, boolean | null | undefined>;

export function cx(...values: Value[]): string {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (typeof v === 'string') {
      out.push(v);
      continue;
    }
    for (const [key, flag] of Object.entries(v)) {
      if (flag) out.push(key);
    }
  }
  return out.join(' ');
}
