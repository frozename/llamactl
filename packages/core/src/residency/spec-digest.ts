/**
 * Canonical digest of a post-placement ModelRun manifest plus the effective
 * launch args as transmitted on the wire. Used by the target-owned admission
 * authority to distinguish two starts of the same workload name that differ
 * in args or placement. Canonicalization: recursive key sort, undefined
 * properties dropped, arrays order-preserving, then SHA-256 over the JSON.
 */

import { createHash } from "node:crypto";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(entries).sort()) {
      const entry = entries[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  return null;
}

export function computeModelRunSpecDigest(
  manifest: unknown,
  effectiveArgs: readonly string[],
): string {
  const canonical = canonicalize({ manifest, args: [...effectiveArgs] });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
