import { createHash } from "node:crypto";

const RESPONSE_CACHE_IGNORED_FIELDS = new Set(["x_omlx_request_handle", "x_omlx_restore_epoch"]);

// Cache layers share a request identity hash but scope independently:
// KV cache adds workload epoch as discriminator, while response cache adds
// workload + workload epoch + protocol variant. The SHA is only one part of
// identity; row-level discriminators live in each cache table tuple.
export function canonicalRequestSha(bodyText: string | Uint8Array): string {
  const rawBytes =
    typeof bodyText === "string" ? Buffer.from(bodyText, "utf8") : Buffer.from(bodyText);
  const text = typeof bodyText === "string" ? bodyText : Buffer.from(bodyText).toString("utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    const canonical = JSON.stringify(sortJsonValue(stripIgnoredFields(parsed, true)));
    return createHash("sha1").update(canonical).digest("hex");
  } catch {
    return createHash("sha1").update(rawBytes).digest("hex");
  }
}

export function boundaryNaiveBytePrefixSha(bodyText: string | Uint8Array): string {
  const bytes =
    typeof bodyText === "string" ? Buffer.from(bodyText, "utf8") : Buffer.from(bodyText);
  return createHash("sha1").update(bytes).digest("hex");
}

function stripIgnoredFields(value: unknown, isRoot: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => stripIgnoredFields(item, false));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !(isRoot && RESPONSE_CACHE_IGNORED_FIELDS.has(key)))
        .map(([key, nested]) => [key, stripIgnoredFields(nested, false)]),
    );
  }
  return value;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}
