// packages/app/src/lib/global-search/surfaces/workloads.ts
import type { Hit } from '../types';

export interface WorkloadItem {
  name: string;
  model?: string;
  node?: string;
}

export function matchWorkloads(needle: string, items: WorkloadItem[]): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const out: Hit[] = [];
  for (const w of items) {
    const fields = [w.name, w.model, w.node].filter(Boolean) as string[];
    const blob = fields.join(' ').toLowerCase();
    if (!blob.includes(lowered)) continue;
    const startsWith = w.name.toLowerCase().startsWith(lowered);
    out.push({
      surface: 'workload',
      parentId: w.name,
      parentTitle: w.name,
      score: startsWith ? 0.8 : 0.5,
      matchKind: 'exact',
      action: {
        kind: 'open-tab',
        tab: {
          tabKey: `workload:${w.name}`,
          title: w.name,
          kind: 'workload',
          instanceId: w.name,
          openedAt: Date.now(),
        },
      },
    });
  }
  return out;
}