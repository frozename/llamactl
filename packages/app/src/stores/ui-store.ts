import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Renderer-level UI state shared across modules. Per-module stores live
 * inside each module folder and read/write their own slice; this store
 * only owns what the shell itself needs (active module, command palette
 * visibility, etc.).
 */
interface UIStore {
  activeModule: string;
  setActiveModule: (id: string) => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      activeModule: 'dashboard',
      setActiveModule: (id) => set({ activeModule: id }),
      commandPaletteOpen: false,
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
    }),
    {
      name: 'llamactl-ui',
      partialize: (state) => ({ activeModule: state.activeModule }),
    },
  ),
);
