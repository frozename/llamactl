import type { KvEntry } from "./registry.js";

const HALF_LIFE_MS = 6 * 3600 * 1000;
const LIVE_PREFIX_BIAS = -1000;
const PAYLOAD_SCALE_BYTES = 1024 * 1024;
const AGE_SCALE_MS = 60 * 60 * 1000;

export function evictionScore(
  entry: KvEntry,
  liveTokens: number,
  livePrefixSha: string | null,
  protectedSha: string | null,
  now: number,
): number {
  if (protectedSha !== null && entry.sha === protectedSha) return Number.NEGATIVE_INFINITY;

  const ageMs = Math.max(0, now - entry.lastUsed);
  const decayedHits = entry.hits * Math.pow(0.5, ageMs / HALF_LIFE_MS);
  const ageComponent = ageMs / AGE_SCALE_MS;
  const hitProtection = decayedHits * 25;
  const sizeComponent = entry.payloadBytes / PAYLOAD_SCALE_BYTES;
  const liveOverlapPenalty =
    livePrefixSha !== null && entry.sha === livePrefixSha ? LIVE_PREFIX_BIAS : 0;
  const liveTokenComponent = liveTokens > 0 ? liveTokens / 10_000 : 0;

  return ageComponent + sizeComponent - hitProtection + liveOverlapPenalty - liveTokenComponent;
}
