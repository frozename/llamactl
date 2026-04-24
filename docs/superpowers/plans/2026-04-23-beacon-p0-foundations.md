# Beacon P0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Beacon token set, the four theme families (Sirius/Ember/Clinical/Scrubs), the semantic type classes (`.t-h1/h2/h3/h4/lede/body/ui/meta/eyebrow/label/mono/code/brand`), the noise overlay, and a one-shot migration from the legacy `glass`/`neon`/`ops` theme ids — without changing any shell chrome behavior.

**Architecture:** Tokens live in a dedicated `tokens.css` imported from `index.css`. The `themes/index.ts` module keeps the same `Theme` interface so `ThemeProvider` + `ThemePicker` keep working unchanged. A one-shot migration step runs inside `theme-store` via Zustand's `migrate` hook, reading the legacy `localStorage` key and mapping to the new id. Only Inter + JetBrains Mono load from Google Fonts — per the frozen Beacon v2.0 system, display surfaces use Inter 300/600 at larger sizes with tight tracking, not a display serif. The noise overlay is a `body::before` SVG data-URI driven from `tokens.css`.

**Tech Stack:** Tailwind v4 `@theme` directive, zustand v5 with `persist` + `migrate`, Bun `bun:test` runner, Electron + Vite (electron-vite), TypeScript 5.9 strict.

---

## File Structure

Create:
- `packages/app/src/themes/tokens.css` — the full Beacon token CSS (shared across all four families, noise overlay, font declarations, scrollbar)
- `packages/app/src/themes/migrate.ts` — pure legacy-id mapping function + unit-testable
- `packages/app/test/themes/migrate.test.ts` — unit test for the migration mapping
- `tests/ui-flows/beacon-p0-verify.ts` — Electron-driven end-of-phase verification flow (data-theme, tokens, body background per family, Google Fonts link, legacy migration durability)

Modify:
- `packages/app/src/index.css` — replace the `@theme` block with an `@import "./themes/tokens.css"` line, drop `.activity-icon` class (becomes part of P2's rail), keep `.mono`
- `packages/app/src/themes/index.ts` — rewrite `THEMES` with Sirius/Ember/Clinical/Scrubs, keep the `Theme` interface shape, keep `mapVariant` field, default = `sirius`
- `packages/app/src/stores/theme-store.ts` — add `version: 2` + `migrate` function that calls `migrate.ts`, rename `localStorage` key to `beacon-theme` (Zustand `name`), **persist the migrated values to `beacon-theme` synchronously during the legacy read** so the migration survives a reload that happens before any user-driven state change
- `packages/app/src/shell/theme-provider.tsx` — pass the noise overlay through, otherwise unchanged
- `packages/app/src/index.html` — add Google Fonts preconnect + `<link>` for Inter + JetBrains Mono; **also add a synchronous early-read `<script>` that reads `localStorage['beacon-theme']` and sets `<html data-theme>` before the first paint** (prevents a 600ms flash of the default theme while Zustand asynchronously hydrates from localStorage on non-default themes)

Delete: none in P0.

---

## Task 1: Create the Beacon tokens CSS

**Files:**
- Create: `packages/app/src/themes/tokens.css`

- [ ] **Step 1: Create the tokens file**

Create `packages/app/src/themes/tokens.css` with the full Beacon token set. This file is the single source of truth for every CSS custom property the app reads.

```css
/* Beacon — token set for the four theme families (Sirius / Ember /
 * Clinical / Scrubs). Consumed at runtime: the JS ThemeProvider sets
 * data-theme on <html>, which activates one of the blocks below.
 *
 * Historical Tailwind @theme vars (--color-fg, --color-fg-muted,
 * --color-accent, --color-warn, --color-danger, --color-success)
 * are re-exported as aliases at the end so existing modules keep
 * compiling while P1/P3 migrate them to the new token names. */

:root, [data-theme='sirius'] {
  --color-brand: #6366f1;
  --color-brand-subtle: #4f46e5;
  --color-brand-muted: rgba(99,102,241,0.15);
  --color-brand-ghost: rgba(99,102,241,0.08);
  --color-brand-contrast: #ffffff;

  --color-surface-0: #0c0c0f;
  --color-surface-1: #141418;
  --color-surface-2: #1a1a20;
  --color-surface-3: #22222a;
  --color-surface-4: #2d2d38;
  --color-surface-overlay: rgba(0,0,0,0.6);

  --color-border: rgba(255,255,255,0.06);
  --color-border-subtle: rgba(255,255,255,0.03);
  --color-border-strong: rgba(255,255,255,0.12);
  --color-border-focus: var(--color-brand);

  --color-text: #ededf0;
  --color-text-secondary: #a8a8b2;
  --color-text-tertiary: #70707a;
  --color-text-ghost: #4a4a52;
  --color-text-inverse: #09090b;

  --color-ok: #34d399;
  --color-warn: #fbbf24;
  --color-err: #f87171;
  --color-info: #60a5fa;

  --glow-brand: radial-gradient(circle at 50% 50%, var(--color-brand-muted) 0%, transparent 60%);
  --glow-ember:  radial-gradient(circle at 50% 50%, rgba(245,158,11,0.12) 0%, transparent 60%);

  color-scheme: dark;
}

[data-theme='ember'] {
  --color-brand: #f59e0b;
  --color-brand-subtle: #d97706;
  --color-brand-muted: rgba(245,158,11,0.16);
  --color-brand-ghost: rgba(245,158,11,0.08);
  --color-brand-contrast: #0a0a08;
  --color-surface-0: #0a0a08;
  --color-surface-1: #131210;
  --color-surface-2: #1a1915;
  --color-surface-3: #22201b;
  --color-surface-4: #2c2a23;
  --color-border: rgba(255,245,220,0.06);
  --color-border-subtle: rgba(255,245,220,0.03);
  --color-border-strong: rgba(255,245,220,0.12);
  --color-text: #ece7da;
  --color-text-secondary: #b5ac95;
  --color-text-tertiary: #807868;
  --color-text-ghost: #544e42;
  color-scheme: dark;
}

[data-theme='clinical'] {
  --color-brand: #2563eb;
  --color-brand-subtle: #1d4ed8;
  --color-brand-muted: rgba(37,99,235,0.10);
  --color-brand-ghost: rgba(37,99,235,0.05);
  --color-brand-contrast: #ffffff;
  --color-surface-0: #faf9f7;
  --color-surface-1: #ffffff;
  --color-surface-2: #f3f2ef;
  --color-surface-3: #e6e5e0;
  --color-surface-4: #cfcdc7;
  --color-border: rgba(30,25,20,0.08);
  --color-border-subtle: rgba(30,25,20,0.04);
  --color-border-strong: rgba(30,25,20,0.14);
  --color-text: #14110d;
  --color-text-secondary: #4a4740;
  --color-text-tertiary: #8a867d;
  --color-text-ghost: #c0bdb5;
  --color-ok: #16a34a;
  --color-warn: #ca8a04;
  --color-err: #dc2626;
  --color-info: #2563eb;
  color-scheme: light;
}

[data-theme='scrubs'] {
  --color-brand: #14b8a6;
  --color-brand-subtle: #0d9488;
  --color-brand-muted: rgba(20,184,166,0.15);
  --color-brand-ghost: rgba(20,184,166,0.08);
  --color-brand-contrast: #06201c;
  --color-surface-0: #07130f;
  --color-surface-1: #0e1c18;
  --color-surface-2: #13241f;
  --color-surface-3: #1a2e28;
  --color-surface-4: #213d37;
  --color-border: rgba(180,230,220,0.08);
  --color-border-subtle: rgba(180,230,220,0.04);
  --color-border-strong: rgba(180,230,220,0.14);
  --color-text: #d4ede8;
  --color-text-secondary: #8cbcb2;
  --color-text-tertiary: #5d8f84;
  --color-text-ghost: #3d6b61;
  color-scheme: dark;
}

/* Shared non-color tokens */
:root {
  --font-sans:    'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;
  --font-display: 'Inter', system-ui, sans-serif; /* display == sans, just tighter */

  --fs-10: 10px; --fs-11: 11px; --fs-12: 12px; --fs-13: 13px;
  --fs-14: 14px; --fs-16: 16px; --fs-20: 20px; --fs-24: 24px;
  --fs-28: 28px; --fs-32: 32px; --fs-48: 48px; --fs-56: 56px;
  --fs-72: 72px; --fs-96: 96px; --fs-128: 128px;

  --lh-tight:  1.05;
  --lh-snug:   1.2;
  --lh-normal: 1.5;
  --lh-loose:  1.65;

  --s-1:4px;  --s-2:8px;  --s-3:12px; --s-4:16px;  --s-5:20px; --s-6:24px;
  --s-8:32px; --s-10:40px; --s-12:48px; --s-16:64px; --s-20:80px;
  --s-24:96px; --s-32:128px; --s-40:160px; --s-48:192px;

  --r-sm:3px; --r-md:6px; --r-lg:10px; --r-xl:16px; --r-2xl:24px; --r-pill:999px;

  --shadow-sm: 0 1px 2px rgba(0,0,0,0.20);
  --shadow-md: 0 8px 24px rgba(0,0,0,0.32);
  --shadow-lg: 0 20px 60px rgba(0,0,0,0.50);

  /* Chrome heights — operator UI */
  --h-title: 44px;
  --h-status: 26px;
  --h-tab: 34px;
  --h-input: 32px;
  --h-btn: 28px;
}

/* Foreground aliases + status-muted tints — per-theme because fg
 * aliases track --color-text values that vary per family. */
:root, [data-theme='sirius'], [data-theme='ember'], [data-theme='clinical'], [data-theme='scrubs'] {
  --fg1: var(--color-text);
  --fg2: var(--color-text-secondary);
  --fg3: var(--color-text-tertiary);
  --fg4: var(--color-text-ghost);

  --color-ok-muted:   rgba(52,211,153,0.12);
  --color-warn-muted: rgba(251,191,36,0.12);
  --color-err-muted:  rgba(248,113,113,0.12);
  --color-info-muted: rgba(96,165,250,0.12);
}

/* Legacy aliases — consumed by modules that still reference the pre-Beacon
 * token names. Removed at the end of P3 once every reference migrates. */
:root {
  --color-fg: var(--color-text);
  --color-fg-muted: var(--color-text-secondary);
  --color-fg-inverted: var(--color-text-inverse);
  --color-accent: var(--color-ok);
  --color-warning: var(--color-warn);
  --color-danger: var(--color-err);
  --color-success: var(--color-ok);
  --color-brand-dim: var(--color-brand-subtle);
}

/* Body defaults + noise overlay */
html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
body {
  margin: 0;
  font-family: var(--font-sans);
  font-size: var(--fs-14);
  line-height: 1.55;
  color: var(--color-text);
  background: var(--color-surface-0);
  transition: background 600ms ease, color 600ms ease;
}
body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0'/></filter><rect width='200' height='200' filter='url(%23n)' opacity='0.5'/></svg>");
  opacity: 0.025;
  mix-blend-mode: overlay;
}
::selection { background: var(--color-brand); color: var(--color-brand-contrast); }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-surface-3); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--color-surface-4); }

.mono { font-family: var(--font-mono); font-feature-settings: 'tnum'; letter-spacing: -0.02em; }
.display { font-family: var(--font-display); font-weight: 300; letter-spacing: -0.03em; line-height: 0.95; }
.eyebrow { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--color-text-tertiary); }
.eyebrow.brand { color: var(--color-brand); }

/* Semantic type classes — use these instead of re-authoring font stacks. */
.t-h1     { font-family: var(--font-sans); font-size: var(--fs-56); font-weight: 600; letter-spacing: -0.03em; line-height: var(--lh-tight); color: var(--fg1); }
.t-h2     { font-family: var(--font-sans); font-size: var(--fs-28); font-weight: 600; letter-spacing: -0.01em; line-height: 1.2; color: var(--fg1); }
.t-h3     { font-family: var(--font-sans); font-size: var(--fs-20); font-weight: 600; letter-spacing: -0.005em; line-height: 1.25; color: var(--fg1); }
.t-h4     { font-family: var(--font-sans); font-size: var(--fs-16); font-weight: 600; line-height: 1.35; color: var(--fg1); }
.t-lede   { font-family: var(--font-sans); font-size: 19px; font-weight: 300; line-height: 1.55; color: var(--fg2); max-width: 62ch; }
.t-body   { font-family: var(--font-sans); font-size: var(--fs-14); line-height: var(--lh-loose); color: var(--fg2); }
.t-ui     { font-family: var(--font-sans); font-size: var(--fs-13); line-height: 1.4; color: var(--fg1); }
.t-meta   { font-family: var(--font-sans); font-size: var(--fs-12); line-height: 1.5; color: var(--fg3); }
.t-eyebrow{ font-family: var(--font-mono); font-size: var(--fs-11); letter-spacing: 0.18em; text-transform: uppercase; color: var(--fg3); font-weight: 500; }
.t-label  { font-family: var(--font-mono); font-size: var(--fs-10); letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg3); font-weight: 500; }
.t-mono   { font-family: var(--font-mono); font-size: var(--fs-12); font-feature-settings: 'tnum'; letter-spacing: -0.02em; color: var(--fg1); }
.t-code   { font-family: var(--font-mono); font-size: 0.92em; padding: 1px 5px; border-radius: var(--r-sm); background: var(--color-surface-2); border: 1px solid var(--color-border); color: var(--fg1); }

/* Emphasis: brand color, upright — NEVER italic. Used as <em class="t-brand">. */
.t-brand  { color: var(--color-brand); font-weight: 400; font-style: normal; }
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/themes/tokens.css
git commit -m "style(app): add Beacon tokens.css (sirius/ember/clinical/scrubs families + legacy aliases)"
```

---

## Task 2: Wire tokens.css into the app + drop the old @theme block

**Files:**
- Modify: `packages/app/src/index.css`

- [ ] **Step 1: Rewrite `index.css`**

Replace the entire contents of `packages/app/src/index.css` with:

```css
@import "tailwindcss";
@import "./themes/tokens.css";

html,
body,
#root {
  height: 100%;
}
```

The `@theme` block is gone (tokens live in `tokens.css` now). The `.activity-icon` class is removed — the new rail is a proper component in P2 and doesn't need a utility. The `.mono` class moves into `tokens.css` (defined above).

- [ ] **Step 2: Type-check the app**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0 (no type errors). Existing modules still reference the legacy aliases (`--color-fg`, `--color-accent`, etc.) which are re-exported from `tokens.css` so nothing breaks.

- [ ] **Step 3: Launch the app and smoke-test**

Run: `bun run --cwd packages/app dev`
Expected: app opens, renders dashboard, background is `#0c0c0f` (Sirius surface-0), fonts are Inter, no blank/broken surfaces. Close the app.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/index.css
git commit -m "refactor(app): move tokens out of @theme block into tokens.css"
```

---

## Task 3: Load Inter + JetBrains Mono from Google Fonts, apply theme early

**Files:**
- Modify: `packages/app/src/index.html`

- [ ] **Step 1: Update `index.html` with the theme-early-read `<script>` and font `<link>` tags**

Replace the `<head>` block in `packages/app/src/index.html` with:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>llamactl</title>
  <script>
    (function () {
      try {
        var raw = localStorage.getItem('beacon-theme');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        var id = parsed && parsed.state && parsed.state.themeId;
        if (id === 'sirius' || id === 'ember' || id === 'clinical' || id === 'scrubs') {
          document.documentElement.setAttribute('data-theme', id);
        }
      } catch (e) {
        /* storage disabled / malformed — fall through to default theme */
      }
    })();
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
  />
</head>
```

Two faces only. Per the frozen Beacon v2.0 system: Inter handles UI body, section heads, and display (heavier weight + tighter tracking at larger sizes); JetBrains Mono handles data / identifiers / telemetry. No display serif.

The early-read `<script>` applies the persisted `data-theme` before the first paint. Without it, React mounts with `DEFAULT_THEME = 'sirius'`, Zustand hydrates from localStorage asynchronously, and the subsequent `data-theme` flip triggers the 600ms `transition` on `body.background` — producing a visible flash of Sirius on every reload for users on a non-default theme. The script is 12 lines and has no other job.

Keep the `<body>` block exactly as-is (it still uses `bg-[var(--color-surface-0)]` etc., which now resolve via `tokens.css`).

- [ ] **Step 2: Launch and verify**

Run: `bun run --cwd packages/app dev`
Expected: app opens, `<html>` font stack resolves to Inter for body, JetBrains Mono for `.mono` elements. Open DevTools → Fonts panel → confirm Inter (five weights) and JetBrains Mono (three weights) face families are loaded. No Instrument Serif.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/index.html
git commit -m "feat(app): load Inter + JetBrains Mono from Google Fonts"
```

---

## Task 4: Write the legacy theme-id migration function

**Files:**
- Create: `packages/app/src/themes/migrate.ts`
- Create: `packages/app/test/themes/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/app/test/themes/migrate.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { migrateLegacyThemeId, type LegacyThemeId, type BeaconThemeId } from '../../src/themes/migrate';

describe('migrateLegacyThemeId', () => {
  test('glass → sirius', () => {
    expect(migrateLegacyThemeId('glass')).toEqual({ themeId: 'sirius', extras: {} });
  });

  test('neon → sirius + scanlines opt-in', () => {
    expect(migrateLegacyThemeId('neon')).toEqual({ themeId: 'sirius', extras: { scanlines: true } });
  });

  test('ops → scrubs', () => {
    expect(migrateLegacyThemeId('ops')).toEqual({ themeId: 'scrubs', extras: {} });
  });

  test('unknown legacy id → sirius default', () => {
    expect(migrateLegacyThemeId('unknown' as LegacyThemeId)).toEqual({ themeId: 'sirius', extras: {} });
  });

  test('pass-through: already-new beacon id returns as-is', () => {
    const idsToPreserve: BeaconThemeId[] = ['sirius', 'ember', 'clinical', 'scrubs'];
    for (const id of idsToPreserve) {
      expect(migrateLegacyThemeId(id)).toEqual({ themeId: id, extras: {} });
    }
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `bun test --cwd packages/app test/themes/migrate.test.ts`
Expected: FAIL — "Cannot find module '../../src/themes/migrate'".

- [ ] **Step 3: Write the minimal implementation**

Create `packages/app/src/themes/migrate.ts`:

```typescript
/**
 * One-shot mapping from the pre-Beacon theme ids (glass/neon/ops) to
 * Beacon families. Called from the theme-store `migrate` hook on first
 * load after upgrading. Pure; no side-effects.
 */

export type LegacyThemeId = 'glass' | 'neon' | 'ops';
export type BeaconThemeId = 'sirius' | 'ember' | 'clinical' | 'scrubs';
export type AnyThemeId = LegacyThemeId | BeaconThemeId | string;

export interface MigrationExtras {
  /** True if the legacy theme had a decoration we want to preserve as
   *  an opt-in user preference (today only `neon` carries this — its
   *  scanlines overlay is kept as an opt-in decoration). */
  scanlines?: boolean;
}

export interface MigrationResult {
  themeId: BeaconThemeId;
  extras: MigrationExtras;
}

export function migrateLegacyThemeId(id: AnyThemeId): MigrationResult {
  switch (id) {
    case 'glass':
      return { themeId: 'sirius', extras: {} };
    case 'neon':
      return { themeId: 'sirius', extras: { scanlines: true } };
    case 'ops':
      return { themeId: 'scrubs', extras: {} };
    case 'sirius':
    case 'ember':
    case 'clinical':
    case 'scrubs':
      return { themeId: id, extras: {} };
    default:
      return { themeId: 'sirius', extras: {} };
  }
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `bun test --cwd packages/app test/themes/migrate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/themes/migrate.ts packages/app/test/themes/migrate.test.ts
git commit -m "feat(app): add legacy theme-id migration (glass/neon/ops → sirius/scrubs)"
```

---

## Task 5: Rewrite themes/index.ts with the four Beacon families

**Files:**
- Modify: `packages/app/src/themes/index.ts`

- [ ] **Step 1: Replace the entire file contents**

Replace `packages/app/src/themes/index.ts` with:

```typescript
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
```

- [ ] **Step 2: Type-check — expect failures in downstream callers**

Run: `bun run --cwd packages/app typecheck`
Expected: there may be 0–2 failures in files that reference the removed `'glass' | 'neon' | 'ops'` union literally. The app compiles through the legacy aliases in `tokens.css` but TS will complain about stringly-typed legacy ids.

If failures appear: note the file + line — they become fix-ups in Task 6.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/themes/index.ts
git commit -m "feat(app): replace Glass/Neon/Ops with Sirius/Ember/Clinical/Scrubs theme families"
```

---

## Task 6: Update the theme store — version bump + migrate hook, durable write

**Files:**
- Modify: `packages/app/src/stores/theme-store.ts`

- [ ] **Step 1: Rewrite the store to run the legacy migration on first load**

Replace `packages/app/src/stores/theme-store.ts` with:

```typescript
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
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 3: Manual migration smoke test**

This step exercises the migration by seeding the legacy key before launch.

1. Launch: `bun run --cwd packages/app dev`
2. Open DevTools → Application → Local Storage → `file://` origin.
3. Add a key `llamactl-theme` with value `{"state":{"themeId":"ops"},"version":0}`.
4. Reload the app window (Cmd-R).
5. In DevTools, verify: `llamactl-theme` is **gone**, `beacon-theme` is present, and its JSON contains `"themeId":"scrubs"`.
6. Repeat with `"themeId":"neon"` → expect `beacon-theme` to contain `"themeId":"sirius","scanlines":true`.
7. Repeat with `"themeId":"glass"` → expect `"themeId":"sirius","scanlines":false`.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/stores/theme-store.ts
git commit -m "feat(app): migrate theme-store to Beacon (one-shot mapping from legacy llamactl-theme key)"
```

---

## Task 7: Verify ThemeProvider still works end-to-end with the new themes

**Files:**
- Verify-only: `packages/app/src/shell/theme-provider.tsx`

The existing `ThemeProvider` applies `theme.vars`, sets `data-theme` on `<html>`, and conditionally paints `rootBackground` + `rootOverlay`. With Beacon, `vars` is empty for every family (tokens come from `tokens.css`), so the provider's only job now is setting `data-theme`. This works unchanged.

- [ ] **Step 1: Launch and cycle all four themes**

Run: `bun run --cwd packages/app dev`

Then open the theme picker (title-bar button or `⌘K` then `⌘T`) and arrow through every family. For each:

| Family   | Surface-0 hex | Brand hex | Fonts      |
|----------|--------------|-----------|------------|
| Sirius   | `#0c0c0f`    | `#6366f1` | Inter (UI) |
| Ember    | `#0a0a08`    | `#f59e0b` | Inter (UI) |
| Clinical | `#faf9f7`    | `#2563eb` | Inter (UI) |
| Scrubs   | `#07130f`    | `#14b8a6` | Inter (UI) |

For each: inspect `<html>` in DevTools → `data-theme` attribute matches the id → computed `background-color` on `<body>` matches the expected hex.

- [ ] **Step 2: Commit a verification note**

No code changes. Mark as verified in your notes and move on. If any theme fails to paint, check: the `<link>` tag in `index.html`, the `@import "./themes/tokens.css"` in `index.css`, the presence of `data-theme` on `<html>`.

---

## Task 8: Expose scanlines as a decoration the provider honors

**Files:**
- Modify: `packages/app/src/shell/theme-provider.tsx`

- [ ] **Step 1: Teach ThemeProvider to paint the scanlines overlay when `scanlines === true`**

Replace `packages/app/src/shell/theme-provider.tsx` with:

```typescript
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
```

The `rootBackground` behavior is gone — token CSS is the single source of truth for the page background now.

- [ ] **Step 2: Type-check**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 3: Smoke-test scanlines**

1. Launch: `bun run --cwd packages/app dev`
2. DevTools → localStorage → set `beacon-theme` `state.scanlines` to `true` → reload.
3. Confirm the faint green horizontal-stripe scanlines appear over the app.
4. Set scanlines back to `false` → reload → stripes disappear.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/shell/theme-provider.tsx
git commit -m "refactor(app): slim ThemeProvider to data-theme + font + optional scanlines"
```

---

## Task 9: End-of-phase verification

- [ ] **Step 1: Typecheck the whole app**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 2: Run the focused theme tests**

Run: `bun test --cwd packages/app test/themes/migrate.test.ts`
Expected: 5 tests pass.

- [ ] **Step 3: Run the top-level test suite**

Run: `bun run test`
Expected: green on every test that P0 could possibly affect. Pre-existing failures in CLI / network-bound smoke tests (catalog, env, recommendations, promote/uninstall) are unrelated to Beacon P0 surface and may be noted and ignored. P0's 7 commits only touch `packages/app/src/themes/*`, `theme-store.ts`, `theme-provider.tsx`, `index.css`, and `index.html`.

- [ ] **Step 4: Programmatic Beacon verification flow (authoritative)**

This is the verification gate for P0. It drives a built Electron bundle through `electron-mcp-server` and asserts every functional goal of P0 against the live renderer:

1. First launch: `<html data-theme="sirius">`, `body` background = `rgb(12, 12, 15)` (Sirius `--color-surface-0`), `--color-brand` = `#6366f1`, body `font-family` includes `Inter`.
2. Exactly one Google Fonts `<link>` pointing at `Inter:wght@300;400;500;600;700` + `JetBrains+Mono:wght@400;500;600&display=swap`.
3. For every theme (`ember`, `clinical`, `scrubs`, `sirius`): seed `beacon-theme` → reload → `data-theme`, `--color-surface-0` token, body `background-color`, and `--color-brand` all match the spec values in §3.4 and `tokens.css`.
4. Legacy migration for every legacy id (`glass`, `neon`, `ops`): seed `llamactl-theme` → reload → the legacy key is removed, `beacon-theme.state.themeId` holds the mapped Beacon id, `beacon-theme.state.scanlines` is `true` only for `neon`, and `<html data-theme>` matches.

The flow is at `tests/ui-flows/beacon-p0-verify.ts`. Run it against a fresh `--userDataDir` so there's no stale `beacon-theme` from previous runs:

```bash
export ELECTRON_MCP_DIR=/path/to/electron-mcp-server
bun run --cwd packages/app build                                    # rebuild so the bundle includes the P0 changes
TMP_USERDATA=$(mktemp -d -t beacon-p0-XXXXXX)
bun run tests/ui-flows/beacon-p0-verify.ts \
  --executable="$(pwd)/packages/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  --args="$(pwd)/packages/app" \
  --userDataDir="$TMP_USERDATA"
```

Expected final line: `PASS — Beacon P0 verification green` (33 PASS checks, 0 FAIL). Any FAIL is a blocker — do not tag `beacon-p0` if the flow is red.

- [ ] **Step 5: Final P0 commit marker**

Nothing to commit if all tasks above committed. Tag the commit:

```bash
git tag beacon-p0
```

---

## Self-review against the spec

- §3.1 Color tokens — covered in Task 1.
- §3.2 Type tokens — `--font-sans/-mono/-display` + scale in Task 1; Google Fonts loaded in Task 3.
- §3.3 Spacing/radius/shadow — covered in Task 1.
- §3.4 Four theme families — covered in Task 1 (CSS blocks) and Task 5 (TS registry).
- §3.5 Legacy migration — covered in Tasks 4 + 6 (pure function + store hook + durable write to `beacon-theme` during the legacy read).
- §5.6 Noise overlay — covered in Task 1 (`body::before`).
- §10 `beacon.scanlines` / `beacon.migrated` — Task 6 handles both (migrated = deletion of old key; scanlines persisted inside `beacon-theme`).
- Flash-of-wrong-theme on reload — prevented by the synchronous early-read `<script>` in Task 3. Without this, the 600ms `transition` on `body.background` animates from Sirius to the persisted theme on every reload.

Deferred to later phases:
- Primitives (`@app/ui`) → P1.
- Shell chrome rewrite → P2.
- Module flattening + editorial polish → P3.
- Removal of legacy aliases (`--color-fg` etc.) → end of P3.
