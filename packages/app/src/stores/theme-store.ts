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

/** Writes the migrated shape to the new `beacon-theme` key in the
 *  exact envelope Zustand persist expects, so the migration survives
 *  a subsequent reload before any state change has triggered a
 *  serialize. Without this, the store seeds from the legacy read but
 *  never writes, and the next reload reverts to the default theme. */
function writeBeaconTheme(shape: PersistedShape): void {
  try {
    localStorage.setItem(
      'beacon-theme',
      JSON.stringify({ state: shape, version: 1 }),
    );
  } catch {
    /* storage quota / disabled — silently tolerate */
  }
}

/** Reads the legacy localStorage key once on load, returns migrated
 *  values if present, otherwise undefined. Clears the legacy key on
 *  success so the migration is idempotent, and writes the migrated
 *  values to `beacon-theme` so the migration is durable across
 *  reloads that occur before any subsequent state change. */
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
    const shape: PersistedShape = { themeId, scanlines: extras.scanlines === true };
    localStorage.removeItem('llamactl-theme');
    writeBeaconTheme(shape);
    return shape;
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
