/**
 * Deterministic hash helper for service spec → deployment fingerprint.
 *
 * `JSON.stringify` alone isn't stable: object-key order is
 * engine-defined when the keys are non-numeric, and fields marked
 * optional in Zod can serialize to `undefined` / be omitted
 * depending on how the spec was constructed. We recursively sort
 * object keys and drop `undefined` leaves so two specs that are
 * materially equal hash to the same digest across hosts, JS
 * engines, and zod versions.
 */
import { createHash } from 'node:crypto';

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = canonicalize(obj[k]);
  return out;
}
