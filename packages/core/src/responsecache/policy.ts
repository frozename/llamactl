import type { ResponseCacheEntry } from './registry.js';
import type { ResponseCacheRegistry } from './registry.js';

const HALF_LIFE_MS = 6 * 3600 * 1000;
const PAYLOAD_SCALE_BYTES = 1024 * 1024;
const AGE_SCALE_MS = 60 * 60 * 1000;

export function responseEvictionScore(entry: ResponseCacheEntry, now: number): number {
  const ageMs = Math.max(0, now - entry.lastUsed);
  const decayedHits = entry.hits * Math.pow(0.5, ageMs / HALF_LIFE_MS);
  const ageComponent = ageMs / AGE_SCALE_MS;
  const hitProtection = decayedHits * 25;
  const sizeComponent = totalEntryBytes(entry) / PAYLOAD_SCALE_BYTES;

  return ageComponent + sizeComponent - hitProtection;
}

export interface ResponseEvictionRunResult {
  deleted: string[];
  totalBytesBefore: number;
  totalBytesAfter: number;
}

export function runResponseCacheEvictionIfOverBudget(
  registry: ResponseCacheRegistry,
  budgetBytes: number,
  now: number,
): ResponseEvictionRunResult {
  const entries = registry.listAll();
  let totalBytes = entries.reduce((sum, entry) => sum + totalEntryBytes(entry), 0);
  const totalBytesBefore = totalBytes;

  if (totalBytes <= budgetBytes) {
    return {
      deleted: [],
      totalBytesBefore,
      totalBytesAfter: totalBytes,
    };
  }

  const sorted = [...entries].sort((a, b) => responseEvictionScore(b, now) - responseEvictionScore(a, now));
  const deleted: string[] = [];
  for (const entry of sorted) {
    if (totalBytes <= budgetBytes) break;
    if (!registry.tryDelete(entry.sha)) continue;
    deleted.push(entry.sha);
    totalBytes -= totalEntryBytes(entry);
  }

  return {
    deleted,
    totalBytesBefore,
    totalBytesAfter: totalBytes,
  };
}

function totalEntryBytes(entry: ResponseCacheEntry): number {
  return entry.requestBodyBytes + entry.responseBodyBytes;
}
