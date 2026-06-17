import type { KvEntry } from "./registry.js";

const HALF_LIFE_MS = 6 * 3600 * 1000;
const PAYLOAD_SCALE_BYTES = 1024 * 1024;
const AGE_SCALE_MS = 60 * 60 * 1000;

export function evictionScore(entry: KvEntry, now: number): number {
  const ageMs = Math.max(0, now - entry.lastUsed);
  const decayedHits = entry.hits * Math.pow(0.5, ageMs / HALF_LIFE_MS);
  const ageComponent = ageMs / AGE_SCALE_MS;
  const hitProtection = decayedHits * 25;
  const sizeComponent = entry.payloadBytes / PAYLOAD_SCALE_BYTES;

  return ageComponent + sizeComponent - hitProtection;
}
