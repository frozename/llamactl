import type { AppModule } from '@/modules/registry';

export interface SearchHit {
  m: AppModule;
  score: number;
}

const MAX_RESULTS = 30;

/** Pure — exported so the ranking is unit-testable without rendering. */
export function searchModules(modules: readonly AppModule[], query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return modules
    .filter((m) => m.beaconGroup && m.beaconGroup !== 'hidden')
    .map((m) => {
      const hay = [m.labelKey, ...(m.aliases ?? []), m.id].join(' ').toLowerCase();
      const score = hay.includes(needle)
        ? m.labelKey.toLowerCase().startsWith(needle)
          ? 2
          : 1
        : 0;
      return { m, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.m.labelKey.localeCompare(b.m.labelKey))
    .slice(0, MAX_RESULTS);
}
