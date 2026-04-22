/**
 * llamactl themes — three full visual languages that swap in one
 * click (VSCode-style). A theme defines every CSS var the app reads
 * plus a font stack, and pairs with a matching NodeMap variant so
 * the cluster visualization stays coherent with the chrome.
 *
 * Themes cascade via CSS custom properties set on `document.documentElement`
 * — modules don't need to know the theme exists; they keep using
 * `var(--color-accent)` etc. Adding a theme = appending to this file.
 */

export type ThemeId = 'glass' | 'neon' | 'ops';

export interface Theme {
  id: ThemeId;
  label: string;
  tagline: string;
  /** NodeMap variant paired with this theme. */
  mapVariant: 'glass' | 'neon' | 'hex';
  /** Root font-family override. */
  fontFamily: string;
  /** CSS custom properties to set on :root. Keys are property names
   *  (with leading `--`); values are any valid CSS value. */
  vars: Record<string, string>;
  /** Optional decoration overlay — a CSS background property that
   *  the ThemeProvider layers under the app's content. Used for the
   *  cyberpunk scanlines. */
  rootBackground?: string;
  rootOverlay?: string;
}

export const THEMES: readonly Theme[] = [
  {
    id: 'glass',
    label: 'Glass',
    tagline: 'Minimalist cards, soft shadows, Tailscale-ish calm.',
    mapVariant: 'glass',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
    vars: {
      '--color-surface-0': '#0d1117',
      '--color-surface-1': '#161b22',
      '--color-surface-2': '#21262d',
      '--color-border': '#30363d',
      '--color-fg': '#e6edf3',
      '--color-fg-muted': '#8b949e',
      '--color-fg-inverted': '#0d1117',
      '--color-brand': '#58a6ff',
      '--color-brand-dim': '#1f6feb',
      '--color-accent': '#7ee2b8',
      '--color-warn': '#f0b36a',
      '--color-warning': '#f0b36a',
      '--color-danger': '#f85149',
      '--color-success': '#3fb950',
    },
  },
  {
    id: 'neon',
    label: 'Neon',
    tagline: 'Terminal-black, monospace, glowing edges. 3 a.m. sysadmin chic.',
    mapVariant: 'neon',
    fontFamily:
      '"JetBrains Mono", "SF Mono", "Menlo", "Monaco", "Courier New", ui-monospace, monospace',
    rootBackground: 'radial-gradient(ellipse at top left, #0a0d14 0%, #03040a 70%)',
    rootOverlay:
      'repeating-linear-gradient(0deg, rgba(0,255,159,0.035) 0 1px, transparent 1px 3px)',
    vars: {
      '--color-surface-0': '#05060a',
      '--color-surface-1': '#0a0d14',
      '--color-surface-2': '#101522',
      '--color-border': '#1f2a44',
      '--color-fg': '#c7f9e4',
      '--color-fg-muted': '#5f7a78',
      '--color-fg-inverted': '#000308',
      '--color-brand': '#00e5ff',
      '--color-brand-dim': '#008ba3',
      '--color-accent': '#00ff9f',
      '--color-warn': '#ffcc33',
      '--color-warning': '#ffcc33',
      '--color-danger': '#ff00c8',
      '--color-success': '#00ff9f',
    },
  },
  {
    id: 'ops',
    label: 'Ops',
    tagline: 'Dense NOC console. Hex tiles, industrial navy, every pixel earns.',
    mapVariant: 'hex',
    fontFamily: '"Inter", "SF Pro Display", -apple-system, sans-serif',
    vars: {
      '--color-surface-0': '#0b1220',
      '--color-surface-1': '#111a2d',
      '--color-surface-2': '#1a2540',
      '--color-border': '#1f2e4d',
      '--color-fg': '#dce5f1',
      '--color-fg-muted': '#7084a0',
      '--color-fg-inverted': '#0b1220',
      '--color-brand': '#1ec4b6',
      '--color-brand-dim': '#127d74',
      '--color-accent': '#fba94c',
      '--color-warn': '#fba94c',
      '--color-warning': '#fba94c',
      '--color-danger': '#ff5d67',
      '--color-success': '#1ec4b6',
    },
  },
];

export const DEFAULT_THEME: ThemeId = 'glass';

export function getTheme(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}
