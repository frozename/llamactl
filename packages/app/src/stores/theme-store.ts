import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_THEME, type ThemeId } from '@/themes';
import { migrateLegacyThemeId, type AnyThemeId } from '@/themes/migrate';

/**
 * Zustand store for the active Beacon theme + opt-in decorations
 * preserved from legacy themes (scanlines). Persisted to localStorage
 * under `beacon-theme`.
 *
 * First-load migration path: if a pre-Beacon key `llamactl-theme` is
 * present in localStorage (Zustand's previous persisted name), its id
 * is routed through `migrateLegacyThemeId` and the result seeds the
 * new store. The old key is cleared once the migration lands so the
 * migration runs exactly once.
 */
interface ThemeStore {
  themeId: ThemeId;
  scanlines: boolean;
  setThemeId: (id: ThemeId) => void;
  setScanlines: (on: boolean) => void;
}

interface PersistedShape {
  themeId: ThemeId;
  scanlines: boolean;
}

/** Reads the legacy localStorage key once on load, returns migrated
 *  values if present, otherwise undefined. Clears the legacy key on
 *  success so the migration is idempotent. */
function readLegacyAndClear(): PersistedShape | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  const raw = localStorage.getItem('llamactl-theme');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { state?: { themeId?: AnyThemeId } };
    const legacyId = parsed.state?.themeId;
    if (!legacyId) {
      localStorage.removeItem('llamactl-theme');
      return undefined;
    }
    const { themeId, extras } = migrateLegacyThemeId(legacyId);
    localStorage.removeItem('llamactl-theme');
    return { themeId, scanlines: extras.scanlines === true };
  } catch {
    localStorage.removeItem('llamactl-theme');
    return undefined;
  }
}

const legacySeed = readLegacyAndClear();

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      themeId: legacySeed?.themeId ?? DEFAULT_THEME,
      scanlines: legacySeed?.scanlines ?? false,
      setThemeId: (id) => set({ themeId: id }),
      setScanlines: (on) => set({ scanlines: on }),
    }),
    { name: 'beacon-theme', version: 1 },
  ),
);
