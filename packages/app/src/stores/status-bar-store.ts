import { create } from 'zustand';

/**
 * Module-scoped status-bar contributions. Modules push items on
 * mount (via a `useStatusBarItems` hook — one-liner) and the shell's
 * StatusBar reads them. Keyed by moduleId so stale contributions
 * from an un-visited module don't stick around (the store cleans
 * them up when a module's contribution changes).
 */
export interface StatusBarItem {
  /** Stable id within the owner module. */
  id: string;
  /** Compact text content — short. */
  text: string;
  /** Optional icon glyph (single char / emoji). */
  glyph?: string;
  /** Tooltip. */
  title?: string;
  /** Color hint — 'fg' | 'muted' | 'accent' | 'warn' | 'danger'. */
  tone?: 'fg' | 'muted' | 'accent' | 'warn' | 'danger';
  /** Click handler — if set, item renders as a clickable button. */
  onClick?: () => void;
}

interface StatusBarStore {
  /** moduleId → items array. */
  contributions: Record<string, StatusBarItem[]>;
  setModuleItems: (moduleId: string, items: StatusBarItem[]) => void;
  clearModuleItems: (moduleId: string) => void;
}

export const useStatusBarStore = create<StatusBarStore>((set) => ({
  contributions: {},
  setModuleItems: (moduleId, items) =>
    set((state) => ({
      contributions: { ...state.contributions, [moduleId]: items },
    })),
  clearModuleItems: (moduleId) =>
    set((state) => {
      const next = { ...state.contributions };
      delete next[moduleId];
      return { contributions: next };
    }),
}));
