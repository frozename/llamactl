import * as React from 'react';
import { useEffect } from 'react';
import { useThemeStore } from '@/stores/theme-store';
import { getTheme, type ThemeId } from '@/themes';

const SCANLINES_OVERLAY =
  'repeating-linear-gradient(0deg, rgba(0,255,159,0.035) 0 1px, transparent 1px 3px)';

/**
 * Mount at the root. Applies the active theme to <html>: sets
 * `data-theme` (drives tokens.css), sets the font-family override,
 * and optionally paints the preserved `scanlines` decoration (kept
 * for users migrated from the legacy `neon` theme).
 */
export function ThemeProvider({
  children,
  previewThemeId,
}: {
  children: React.ReactNode;
  previewThemeId?: ThemeId;
}): React.JSX.Element {
  const persistedId = useThemeStore((s) => s.themeId);
  const scanlines = useThemeStore((s) => s.scanlines);
  const effectiveId = previewThemeId ?? persistedId;

  useEffect(() => {
    const root = document.documentElement;
    const theme = getTheme(effectiveId);
    root.setAttribute('data-theme', theme.id);
    root.style.setProperty('font-family', theme.fontFamily);
  }, [effectiveId]);

  return (
    <>
      {children}
      {scanlines && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0"
          style={{ zIndex: 1000, background: SCANLINES_OVERLAY, mixBlendMode: 'screen' }}
        />
      )}
    </>
  );
}
