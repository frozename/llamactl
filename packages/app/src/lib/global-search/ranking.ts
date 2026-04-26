// packages/app/src/lib/global-search/ranking.ts
import type { Hit, SurfaceGroup, SurfaceKind } from './types';

const SURFACE_TIER_BIAS: Record<SurfaceKind, number> = {
  'tab-history': 0.1,
  module: 0.1,
  workload: 0.1,
  node: 0.1,
  preset: 0.1,
  session: 0,
  knowledge: 0,
  logs: 0,
};

export function applySurfaceBias(hit: Hit): number {
  return hit.score + SURFACE_TIER_BIAS[hit.surface];
}

const TIE_BREAK_ORDER: Record<SurfaceKind, number> = {
  module: 8,
  'tab-history': 7,
  workload: 6,
  node: 5,
  preset: 4,
  session: 3,
  knowledge: 2,
  logs: 1,
};

export function sortGroups(groups: SurfaceGroup[]): SurfaceGroup[] {
  return groups.sort((a, b) => {
    const diff = b.topScore - a.topScore;
    if (Math.abs(diff) > 0.001) return diff;
    return TIE_BREAK_ORDER[b.surface] - TIE_BREAK_ORDER[a.surface];
  });
}