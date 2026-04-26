// packages/app/src/lib/global-search/surfaces/presets.ts
import type { Hit } from '../types';

export interface PresetItem {
  name: string;
  description?: string;
}

export function matchPresets(needle: string, items: PresetItem[]): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const out: Hit[] = [];
  for (const p of items) {
    const blob = [p.name, p.description].filter(Boolean).join(' ').toLowerCase();
    if (!blob.includes(lowered)) continue;
    const startsWith = p.name.toLowerCase().startsWith(lowered);
    out.push({
      surface: 'preset',
      parentId: p.name,
      parentTitle: p.name,
      score: startsWith ? 0.8 : 0.5,
      matchKind: 'exact',
      action: {
        kind: 'open-tab',
        tab: {
          tabKey: 'module:presets',
          title: 'Presets',
          kind: 'module',
          openedAt: Date.now(),
        },
      },
    });
  }
  return out;
}