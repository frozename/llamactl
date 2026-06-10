---
name: beacon-design-system
description: Beacon design system — 4 themes (Sirius, Ember, Clinical, Scrubs), 150 tokens, 9 primitives, Inter + JetBrains Mono. Use when designing for llamactl, novaflow, or any surface meant to feel part of the Beacon operator family.
---

# Beacon design system

Unified token system across two operator-class products. Theme-as-a-variable: swap `data-theme` on `<html>` and every color, surface, and brand hue flips in place without a single component re-authoring.

## When to use

- Designing for **llamactl** (fleet / control plane / dense web UI) → `data-theme="sirius"`
- Designing for **novaflow** (creative canvas / flow composer) → `data-theme="ember"`
- Exports, print, daylight surfaces → `data-theme="clinical"`
- Monitoring / on-call surfaces that need calm → `data-theme="scrubs"`
- New product meant to feel adjacent to the Beacon family → pick the closest theme; do not invent new brand colors

## Setup

Always link `colors_and_type.css` (which `@import`s `tokens.css`) and set a theme on the root:

```html
<link rel="stylesheet" href="colors_and_type.css" />
<html data-theme="sirius"></html>
```

Fonts (Inter, JetBrains Mono) are loaded via Google Fonts inside the stylesheet — nothing to add.

## Design rules — non-negotiable

1. **Never hard-code a color.** Use tokens: `var(--color-surface-1)`, `var(--color-text-secondary)`, `var(--color-brand)`, `var(--color-ok)`. If a token does not exist for your need, you probably don't need the color.
2. **Brand color appears sparingly.** One accented word per headline, one focus ring, one primary button, one status dot. Never a full-bleed background.
3. **Status colors are invariant** across themes. `ok`=green, `warn`=amber, `err`=red, `info`=blue/brand. Don't retint them per theme.
4. **Sentence case everywhere.** Including buttons, headings, labels. Proper nouns only (Sirius, Ember, Inter).
5. **No emoji. Ever.** Use unicode glyphs: `▸ ▾ ▲ ▼ ● ◉ ✓ × ⌕ ⌘ ⇧ ↗ ↺ ⎇ ⚙`.
6. **Mono for identifiers and telemetry only** — never for prose. `svc.gateway`, `v2.1.4`, `⌘K`, `842ms`.
7. **Operator surfaces run tight** (11–13px, 4–8px gaps). **Doc/marketing surfaces breathe** (14–18px body, 48–96px section rhythm).
8. **Depth comes from surface steps**, not shadow. Shadows are subtle (sm/md/lg, all dark-tuned). Never inner shadow. Never frosted glass as a default.
9. **Motion reveals, never performs.** < 400ms, `cubic-bezier(.4, 0, .2, 1)`. Theme switches fade 600ms. Pulse only on _live_ data indicators.
10. **Radius scale is fixed:** sm 3 · md 6 · lg 10 · xl 16 · 2xl 24 · pill. Cards are xl; buttons are md; chips/kbd are sm.
11. **Emphasis inside a line is an `<em>` painted brand** (`font-style: normal` via the `.t-emph` class). Never italic.
12. **Never use purple-blue gradient backgrounds** or cards-with-colored-left-border-only. These are Beacon's "do not" list.

## Available tokens (summary)

Full list in `tokens.css`. Semantic aliases in `colors_and_type.css`.

- **Surfaces:** `--color-surface-0` (app bg) → `--color-surface-4` (most raised)
- **Text:** `--color-text`, `--color-text-secondary`, `--color-text-tertiary`, `--color-text-ghost`
- **Borders:** `--color-border-subtle`, `--color-border`, `--color-border-strong`, `--color-border-focus`
- **Brand:** `--color-brand`, `--color-brand-subtle`, `--color-brand-ghost`
- **Status:** `--color-ok`, `--color-warn`, `--color-err`, `--color-info` (theme-invariant)
- **Type:** `--font-sans` (Inter), `--font-mono` (JetBrains Mono)
- **Radius:** `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`, `--r-2xl`, `--r-pill`
- **Shadow:** `--shadow-sm`, `--shadow-md`, `--shadow-lg`

## Primitives (see `preview/` and `ui_kits/` for usage)

`Button` (primary/secondary/ghost/outline × sm/md/lg) · `Badge` (mono chip) · `Status` (dot + label) · `Keys` (kbd with raised bottom border) · `Input` (focus ring glow) · `Tabs` (underline, brand accent) · `Tree` (explorer sidebar) · `Panel` · `Card` (radius-xl, shadow-sm).

## Patterns

- **Stat cards grid** — 4-up, mono labels, 28px numeric values with brand-colored unit suffix, tiny spark, delta chip
- **Data table** — mono columns, status badges, tabular numerals, `surface-2` header row
- **Command palette** (⌘K) — 560px overlay, pulsing carret orb, grouped list with shortcut hints
- **Streaming log view** — fixed-height scroller, mono, severity-colored `lv` column
- **Title bar + status bar chrome** — 44px top, 26px bottom, activity rail 56px, explorer 280px

## Fixtures (realistic placeholder names)

Use these when inventing copy — they match the source vocabulary:

- Services: `llamactl-gateway`, `novaflow-render`, `shared-auth-gateway`, `scheduler-cron`
- Regions: `us-west-2`, `us-east-1`, `eu-west-1`
- Versions: `v2.1.4`, `v4.0.2`
- Tenants: `acme`, `apex`, `vertex`
- People: third-person notebooks — avoid names unless needed

## Reference material

- `README.md` — full visual foundations, voice, content rules
- `colors_and_type.css` / `tokens.css` — the actual tokens
- `preview/*.html` — every primitive as a standalone preview card
- `ui_kits/llamactl/index.html` — dense web control plane (Sirius)
- `ui_kits/novaflow/index.html` — creative canvas (Ember)
- `source_reference.html` — the original source system page; read this for voice calibration
- `assets/` — beacon lockup SVG, noise overlay

## When unsure

Read `source_reference.html` — it is the ground truth for tone and composition. Then read the relevant preview card. Do not invent a new component before checking if one of the 9 primitives covers it.
