import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_THEME, type ThemeId } from '@/themes';

/**
 * Zustand store for the active Beacon theme + opt-in decorations
 * preserved from legacy themes (scanlines). Persisted to localStorage
 * under `beacon-theme`.
 */
interface ThemeStore {
  themeId: ThemeId;
  scanlines: boolean;
  setThemeId: (id: ThemeId) => void;
  setScanlines: (on: boolean) => void;
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME,
      scanlines: false,
      setThemeId: (id) => set({ themeId: id }),
      setScanlines: (on) => set({ scanlines: on }),
    }),
    { name: 'beacon-theme', version: 2 },
  ),
);
