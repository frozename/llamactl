import * as React from 'react';
import { useEffect } from 'react';
import { useThemeStore } from '@/stores/theme-store';
import { getTheme, type ThemeId } from '@/themes';

/**
 * Mount at the root. Applies the active theme's CSS custom properties +
 * font-family to `document.documentElement`, updates `data-theme` so
 * downstream selectors (conditional SVG decorations, etc.) can key on
 * it, and optionally injects a fixed background + overlay layer
 * (scanlines) when the theme declares one.
 *
 * Accepts an optional `previewThemeId` override used by the theme
 * picker for VSCode-style live-preview — when arrow keys move through
 * options we apply the highlighted one WITHOUT committing to the
 * zustand store; on commit/Enter the store updates and this prop
 * goes back to undefined.
 */
export function ThemeProvider({
  children,
  previewThemeId,
}: {
  children: React.ReactNode;
  previewThemeId?: ThemeId;
}): React.JSX.Element {
  const persistedId = useThemeStore((s) => s.themeId);
  const effectiveId = previewThemeId ?? persistedId;

  useEffect(() => {
    const root = document.documentElement;
    const theme = getTheme(effectiveId);
    for (const [key, value] of Object.entries(theme.vars)) {
      root.style.setProperty(key, value);
    }
    root.style.setProperty('font-family', theme.fontFamily);
    root.setAttribute('data-theme', theme.id);
    if (theme.rootBackground) {
      document.body.style.background = theme.rootBackground;
    } else {
      document.body.style.background = '';
    }
    return () => {
      // Intentionally don't strip the vars on unmount — the next
      // ThemeProvider render will overwrite them; leaving the last
      // values avoids a flash while re-mounting.
    };
  }, [effectiveId]);

  const theme = getTheme(effectiveId);
  return (
    <>
      {children}
      {theme.rootOverlay && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0"
          style={{
            zIndex: 1000,
            background: theme.rootOverlay,
            mixBlendMode: 'screen',
          }}
        />
      )}
    </>
  );
}
