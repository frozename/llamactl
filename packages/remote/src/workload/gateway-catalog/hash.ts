// packages/remote/src/workload/gateway-catalog/hash.ts
import { createHash } from 'node:crypto';

/**
 * Stable hash of an entry's "shape" — deliberately ignores the
 * `ownership` block (so adding/removing a composite from compositeNames
 * doesn't trigger a "shape changed" reapply for the entry's other
 * owners) and ignores the `specHash` field on the existing ownership
 * if any (chicken-and-egg).
 */
export function entrySpecHash(entry: unknown): string {
  const stripped = stripOwnership(entry);
  const json = stableStringify(stripped);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function stripOwnership(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOwnership);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (k === 'ownership') continue;
      out[k] = stripOwnership((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stableStringify(value: any): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
