/**
 * Beacon theme families. Each family declares the `Theme` shape the
 * ThemeProvider applies to `<html>` at runtime: a set of CSS custom
 * properties, an optional root background and overlay (preserved for
 * scanlines opt-in), and a NodeMap variant so the cluster
 * visualization stays coherent with the chrome.
 *
 * Token values live in `tokens.css` (applied by the data-theme
 * attribute). This file drives font-family overrides, the optional
 * background/overlay, and the NodeMap variant — everything the
 * ThemeProvider can't get from CSS alone.
 */

export type ThemeId = 'sirius' | 'ember' | 'clinical' | 'scrubs';

export interface Theme {
  id: ThemeId;
  label: string;
  tagline: string;
  /** NodeMap variant paired with this theme. */
  mapVariant: 'glass' | 'neon' | 'hex';
  /** Root font-family override. */
  fontFamily: string;
  /** CSS custom properties applied at runtime. Kept for backwards
   *  compatibility with ThemeProvider, but in Beacon the actual
   *  tokens come from tokens.css via data-theme. This map stays
   *  empty for all four families. */
  vars: Record<string, string>;
  rootBackground?: string;
  rootOverlay?: string;
}

const SANS_STACK = "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const MONO_STACK = "'JetBrains Mono', ui-monospace, Menlo, monospace";

export const THEMES: readonly Theme[] = [
  {
    id: 'sirius',
    label: 'Sirius',
    tagline: 'Indigo calm. Default operator-night dark.',
    mapVariant: 'glass',
    fontFamily: SANS_STACK,
    vars: {},
  },
  {
    id: 'ember',
    label: 'Ember',
    tagline: 'Warm amber dark. Workshop mood.',
    mapVariant: 'glass',
    fontFamily: SANS_STACK,
    vars: {},
  },
  {
    id: 'clinical',
    label: 'Clinical',
    tagline: 'Bright, high-contrast, morning light.',
    mapVariant: 'hex',
    fontFamily: SANS_STACK,
    vars: {},
  },
  {
    id: 'scrubs',
    label: 'Scrubs',
    tagline: 'Teal-dark. Hospital-quiet precision.',
    mapVariant: 'hex',
    fontFamily: SANS_STACK,
    vars: {},
  },
];

export const DEFAULT_THEME: ThemeId = 'sirius';

export function getTheme(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** Null-safe helper: accepts any string (e.g. a legacy id that hasn't
 *  been migrated yet) and returns the closest match. Callers that
 *  know they already have a valid id should use `getTheme` instead. */
export function coerceThemeId(id: string | null | undefined): ThemeId {
  if (id === 'sirius' || id === 'ember' || id === 'clinical' || id === 'scrubs') return id;
  return DEFAULT_THEME;
}

/** Keep a handle on the mono stack for components that need it
 *  explicitly (e.g. data-heavy subtrees). */
export const MONO_FONT_STACK = MONO_STACK;
