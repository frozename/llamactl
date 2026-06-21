/**
 * Returns a shallow copy of `obj` with every entry whose value is `undefined`
 * removed. Lets call sites build objects for `exactOptionalPropertyTypes`
 * targets without scattering inline `...(v !== undefined ? { k: v } : {})`
 * ternary spreads (which inflate cognitive complexity): collapse them into a
 * single `...omitUndefined({ k: v, ... })`.
 */
export function omitUndefined<T extends object>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
