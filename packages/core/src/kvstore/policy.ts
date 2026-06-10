import type { KvEntry, KvRegistry } from "./registry.js";

import { evictionScore } from "./evictionScore.js";

export interface LookupParams {
  candidatePrefixes: {
    sha: string;
    prefixByteLength: number;
    tokenCount: number;
  }[];
  workload: string;
  quantBits: number;
  ctxSize: number;
  workloadEpoch: string;
}

export function longestPrefixLookup(registry: KvRegistry, params: LookupParams): KvEntry | null {
  const sortedCandidates = [...params.candidatePrefixes].sort(
    (a, b) => b.prefixByteLength - a.prefixByteLength,
  );
  for (const candidate of sortedCandidates) {
    const entry = registry.findBySha(candidate.sha);
    if (!entry) continue;
    if (entry.quarantined === 1) continue;
    if (entry.workload !== params.workload) continue;
    if (entry.quantBits !== params.quantBits) continue;
    if (entry.ctxSize !== params.ctxSize) continue;
    if (entry.prefixByteLength !== candidate.prefixByteLength) continue;
    if (entry.tokens !== candidate.tokenCount) continue;
    if (entry.workloadEpoch !== params.workloadEpoch) continue;
    return entry;
  }
  return null;
}

export interface EvictionRunResult {
  deleted: string[];
  blockedActive: string[];
  totalPayloadBytesBefore: number;
  totalPayloadBytesAfter: number;
}

export function runEvictionIfOverBudget(
  registry: KvRegistry,
  workload: string,
  byteBudget: number,
  now: number,
): EvictionRunResult {
  const workloadEntries = registry.listAll().filter((entry) => entry.workload === workload);
  let totalPayloadBytes = workloadEntries.reduce((sum, entry) => sum + entry.payloadBytes, 0);
  if (totalPayloadBytes <= byteBudget) {
    return {
      deleted: [],
      blockedActive: [],
      totalPayloadBytesBefore: totalPayloadBytes,
      totalPayloadBytesAfter: totalPayloadBytes,
    };
  }

  const sorted = [...workloadEntries].sort((a, b) => {
    const scoreA = evictionScore(a, 0, null, null, now);
    const scoreB = evictionScore(b, 0, null, null, now);
    return scoreB - scoreA;
  });

  const deleted: string[] = [];
  const blockedActive: string[] = [];
  for (const entry of sorted) {
    if (totalPayloadBytes <= byteBudget) break;
    if (registry.tryDelete(entry.sha)) {
      deleted.push(entry.sha);
      totalPayloadBytes -= entry.payloadBytes;
      continue;
    }
    blockedActive.push(entry.sha);
  }

  return {
    deleted,
    blockedActive,
    totalPayloadBytesBefore: workloadEntries.reduce((sum, entry) => sum + entry.payloadBytes, 0),
    totalPayloadBytesAfter: totalPayloadBytes,
  };
}
