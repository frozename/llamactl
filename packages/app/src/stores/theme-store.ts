import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_THEME, type ThemeId } from '@/themes';

/**
 * Zustand store for the active theme id. Persisted to localStorage so
 * the choice survives reloads. Separate from the in-memory "preview"
 * state the picker uses while the user is arrowing through themes —
 * that's purely component-local until they commit with Enter.
 */
interface ThemeStore {
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME,
      setThemeId: (id) => set({ themeId: id }),
    }),
    { name: 'llamactl-theme' },
  ),
);
