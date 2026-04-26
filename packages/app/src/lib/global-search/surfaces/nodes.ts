// packages/app/src/lib/global-search/surfaces/nodes.ts
import type { Hit } from '../types';

export interface NodeItem {
  name: string;
  effectiveKind?: string;
}

export function matchNodes(needle: string, items: NodeItem[]): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const out: Hit[] = [];
  for (const n of items) {
    if (!n.name.toLowerCase().includes(lowered)) continue;
    const startsWith = n.name.toLowerCase().startsWith(lowered);
    out.push({
      surface: 'node',
      parentId: n.name,
      parentTitle: n.name,
      score: startsWith ? 0.8 : 0.5,
      matchKind: 'exact',
      action: {
        kind: 'open-tab',
        tab: {
          tabKey: `node:${n.name}`,
          title: n.name,
          kind: 'node',
          instanceId: n.name,
          openedAt: Date.now(),
        },
      },
    });
  }
  return out;
}