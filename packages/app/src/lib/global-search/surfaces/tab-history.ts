// packages/app/src/lib/global-search/surfaces/tab-history.ts
import type { Hit } from '../types';

export interface TabHistoryState {
  tabs: { tabKey: string; title: string; kind: string; openedAt: number; [k: string]: any }[];
  closed: { tabKey: string; title: string; kind: string; closedAt: number; [k: string]: any }[];
}

export function matchTabHistory(needle: string, state: TabHistoryState): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const out: Hit[] = [];
  const seen = new Set<string>();

  for (const t of state.tabs) {
    if (!t.title.toLowerCase().includes(lowered)) continue;
    seen.add(t.tabKey);
    out.push({
      surface: 'tab-history',
      parentId: t.tabKey,
      parentTitle: t.title,
      score: t.title.toLowerCase().startsWith(lowered) ? 0.8 : 0.5,
      matchKind: 'exact',
      action: { kind: 'open-tab', tab: { ...t, openedAt: Date.now() } },
    });
  }
  for (const c of state.closed) {
    if (seen.has(c.tabKey)) continue;
    if (!c.title.toLowerCase().includes(lowered)) continue;
    seen.add(c.tabKey);
    const { closedAt, ...rest } = c;
    const t = { ...rest, openedAt: Date.now() };
    out.push({
      surface: 'tab-history',
      parentId: c.tabKey,
      parentTitle: c.title,
      score: c.title.toLowerCase().startsWith(lowered) ? 0.7 : 0.4,
      matchKind: 'exact',
      action: { kind: 'open-tab', tab: t },
    });
  }
  return out;
}