import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Persisted per-user Explorer collapse state. Keys are free-form
 * strings — one per collapsible row (group ids like `workspace`, or
 * composite keys like `ops/workloads` for dynamic sub-groups).
 * Default = not collapsed.
 */
interface Store {
  collapsed: Record<string, boolean>;
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
  set: (key: string, value: boolean) => void;
}

export const useExplorerCollapse = create<Store>()(
  persist(
    (set, get) => ({
      collapsed: {},
      isCollapsed: (key) => get().collapsed[key] === true,
      toggle: (key) =>
        set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),
      set: (key, value) =>
        set((s) => ({ collapsed: { ...s.collapsed, [key]: value } })),
    }),
    { name: 'beacon-explorer-collapsed', version: 1 },
  ),
);
