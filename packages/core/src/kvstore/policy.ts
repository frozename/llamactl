import type { KvEntry, KvRegistry } from './registry.js';

export interface LookupParams {
  candidatePrefixes: Array<{
    sha: string;
    prefixByteLength: number;
    tokenCount: number;
  }>;
  workload: string;
  quantBits: number;
  ctxSize: number;
  workloadEpoch: string;
}

export function longestPrefixLookup(registry: KvRegistry, params: LookupParams): KvEntry | null {
  const sortedCandidates = [...params.candidatePrefixes].sort((a, b) => b.prefixByteLength - a.prefixByteLength);
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
