# Beacon Design System

**Beacon** is a unified design system distilled from two operator-class products — **llamactl** (web control plane for LLM fleet ops) and **novaflow** (desktop flow-composition workspace) — and formalized into one token library, four theme families, and one shared vocabulary of primitives and patterns.

The system's pitch: **theme as a variable, not an identity.** Swap `data-theme` on the root element and the product's feel changes — indigo calm, amber warmth, clinical daylight, teal focus — without a single component needing to re-render or re-author a color.

## At a glance

| | |
|---|---|
| **Themes** | 4 families · one DNA (Sirius, Ember, Clinical, Scrubs) |
| **Tokens** | 108 primitive · 42 semantic |
| **Primitives** | 9 (Button, Badge, Status, Keys, Input, Tabs, Tree, Panel, Card) |
| **Patterns** | 6 (Stat cards, Data table, Command palette, Filter bar, etc.) |
| **Type** | Inter (UI) · JetBrains Mono (data) |
| **Status** | v2.0 · frozen · shipping |

## Products it serves

| Surface | Mode | Theme baseline | Notes |
|---|---|---|---|
| **llamactl** | Dense web dashboard | Sirius (indigo, dark) | Fleet control plane. Tight tables, long telemetry, disciplined terminal aesthetic. |
| **novaflow** | Creative desktop workspace | Ember (amber, dark) | Canvas-first flow composition. Warm palettes, editorial breathing room. |
| **Clinical (bridge)** | Print, docs, daylight | Clinical (blue, light) | Light paper-toned surfaces for exports, printed runbooks, daylight use. |
| **Scrubs (bridge)** | On-call / monitoring | Scrubs (teal, dark) | Oceanic calm for long-shift operations review. |

## Sources

The system was extracted from two internal repositories (not included here):

- `github.com/frozename/llamactl` — web dashboard; source of the indigo brand, dark surface stack, Inter+JetBrains Mono pairing, status-dot convention, stat-card grid, and ⌘K command palette.
- `github.com/frozename/novaflow` — desktop canvas app; source of the amber brand, warm neutrals, editorial rhythm, generous spacing, and soft focus glows.

A **bridge layer** (this system) reconciles the two: one token namespace, four themes, fixed status semantics, unified motion grammar.

---

## Content fundamentals

### Voice

Beacon writes like an **operator's notebook** — precise, terse, confidence without ornament. It talks to engineers who already know what they're doing; it refuses to explain what `P95` means.

**Examples (from the source system):**

- _"Two tools. One system."_ — headline
- _"Drop `tokens-v2.css` into any project. Set `data-theme` on the root element to switch families."_ — getting started
- _"Reveal, never perform. Pulses on live data, glows around focus, slow fades on theme switch."_ — motion principle
- _"Nine primitives cover 90% of the interface. Each is token-driven — swap the theme, they follow."_ — intro

### Rules

| | |
|---|---|
| **Person** | Third person or imperative. Rarely "we," almost never "you." Docs instruct ("Drop this in"), specs describe ("Every primitive resolves to a token"). |
| **Tense** | Present. The system *is*, does, runs. Avoid future ("will support") and passive ("is supported by"). |
| **Casing** | **Sentence case** for everything — headings, labels, buttons. Title Case only for proper nouns (Sirius, Ember, Clinical, Scrubs, Inter, JetBrains Mono). |
| **Punctuation** | Em-dashes ( — ) connect clauses; never " - ". Periods in headlines are allowed when the line is a complete statement ("Two tools. One system."). No exclamation marks. |
| **Numbers** | Digits always (`4 themes`, `108 tokens`), units compact (`842ms`, `1.24M`, `99.98%`). Prefer SI shorthand. |
| **Emphasis** | One brand color, used sparingly, on a single word or count inside a line. Rendered as inline `<em>` (styled, not italic). Example: _"108 primitive · 42 semantic"_ with `108` and `42` in brand color. |
| **Terminal-ese** | Monospace is reserved for identifiers, commands, and telemetry values — never prose. `svc.llamactl.gateway`, `v2.1.4`, `⌘K`. |
| **Emoji** | **No.** Beacon uses unicode glyphs (`▸ ▾ ▲ ▼ ● ◉ ◎ ↗ ✓ ×`), keyboard symbols (`⌘ ⇧ ⌥`), and bullets (`·`) instead. No emoji anywhere — not in UI, not in docs. |
| **Ellipses** | Use `…` (single char) for progress/pending states. Never three dots. |
| **Separators** | Middle dots (`·`) between related fragments: `v2.0 · frozen · shipping`. Slashes (`/`) for paths. |

### Vibe

Written by someone who's been on-call at 3am. Warm, but not chatty. Informed, but doesn't perform it. Every word earns its place — if a sentence is removed and nothing is lost, it was filler.

---

## Visual foundations

### Color

- **Four themes**, all sharing the same semantic structure. Change `data-theme` on `<html>` or any ancestor; tokens below flip in place.
  - **Sirius** — dark indigo (default) — operator night
  - **Ember** — dark amber — warm workshop
  - **Clinical** — light paper — bright / print
  - **Scrubs** — dark teal — oceanic calm
- **Status palette is invariant.** `--color-ok` is always green, `--color-err` always red — regardless of theme. Semantic consistency beats theme mood. (Clinical tweaks status hues slightly for contrast on paper.)
- **Brand appears sparingly** — for one word per headline, focus rings, active indicators, primary buttons, pulsing orbs. Never as a full-bleed background.
- **Surfaces step in tiny increments** — `surface-0` (app bg) → `surface-4` (most raised). 4-5 steps, not 10. Steps are ~2-4% lighter/darker than the previous, never dramatic.
- Never use bluish-purple gradients. Never use decorative "cards with colored left border only."

### Type

- **Inter** (UI — 300/400/500/600/700) and **JetBrains Mono** (data — 400/500/600). That's it. No display serif, no script, no novelty.
- **Dual-density rule:** operator chrome uses 11–13px; doc surfaces use 14–19px body and large (56px) hero titles with `letter-spacing: -0.03em`.
- Monospace gets `font-feature-settings: 'tnum'` always — tabular numerals for aligned columns.
- Lede paragraphs are `font-weight: 300` with `line-height: 1.55`, capped at ~62ch.

### Spacing & layout

- 4px base, steps: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128.
- Operator surfaces run **tight** (4–8px gaps, 6–12px padding).
- Docs / marketing pages breathe — 56–120px section rhythm, 48–64px inner padding on hero blocks.
- Layout chrome: **fixed title bar (44px)**, **fixed status bar (26px)**, activity rail (56px), explorer (280px), surface fills the rest.

### Background

- **Solid surface tokens**, not gradients. Themes identify by tint, not imagery.
- A single **subtle noise overlay** (fractal SVG at ~2.5% opacity, `mix-blend-mode: overlay`) lives on `body::before` in every theme — gives flat dark surfaces a little grain.
- **Atmospheric glows** are reserved for hero blocks: blurred radial orbs (brand + accent color) behind a card, ~55/40/30% opacity, `filter: blur(60–70px)`. Use 2-3 layers, no more.

### Borders

- `--color-border` (6% white / 8% black) is default; `--color-border-subtle` (3/4%) separates dense content; `--color-border-strong` (10–14%) defines an important container.
- **Border radius scale:** `sm 3px` (kbd, chips) · `md 6px` (buttons, inputs) · `lg 10px` (panels) · `xl 16px` (hero cards) · `2xl 24px` (overlays) · `pill 999px`.
- Most surfaces are radius-`lg` or `xl`. Buttons are `md`. Chips/kbd are `sm`.

### Shadows

- **Three tiers**, all very subtle and dark-tuned:
  - `--shadow-sm: 0 1px 2px rgba(0,0,0,0.20)` — cards at rest
  - `--shadow-md: 0 8px 24px rgba(0,0,0,0.32)` — popovers, menus
  - `--shadow-lg: 0 20px 60px rgba(0,0,0,0.50)` — modals, overlays
- Never use inner shadows. Depth comes from surface steps, not glossy inset effects.

### Motion

- **Reveal, never perform.** Transitions are seasoning, not flavor.
- Every transition < **400ms**. Most are 120–260ms.
- Easing: `cubic-bezier(.4, 0, .2, 1)` (ease-out) for most; 600ms `ease` for theme switches specifically (background + color crossfade).
- **Three motion types:**
  - **Pulse** — 2s infinite, on live data indicators, ⌘K carret orbs (opacity + scale).
  - **Glow** — focus ring expansion (box-shadow 0 → 3px of brand-ghost).
  - **Fade / slide** — panels entering (right-edge slide 100% → 0%, 260ms).

### Hover & press

- **Hover (hierarchy by surface step):**
  - Ghost button: transparent → `surface-2`
  - Secondary: `surface-3` → `surface-4`
  - Primary: brand → brand-subtle + `box-shadow: 0 0 0 4px var(--color-brand-ghost)` (soft glow)
  - Row / tree item: transparent → `surface-2` or `brand-ghost`
- **Active indicator bar:** a 2px vertical rule of `--color-brand` on the left edge of an active nav item — never an accent-colored full background.
- **Press:** the Beacon system doesn't use shrink/scale on press. Instead, slightly deeper color (brand-subtle replaces brand). Keep it calm.
- **Focus:** `outline: 1px solid var(--color-border-focus); outline-offset: -1px` + a 3px `box-shadow` glow of `brand-ghost` on inputs.

### Transparency & blur

- Transparency is used mainly for:
  - Border colors (RGBA with very low alpha on white/black)
  - The noise overlay (2.5%)
  - Atmospheric glows (`mix-blend-mode: screen` with 25–55% opacity)
- Backdrop blur is **not** a staple — no frosted glass. The system prefers solid opaque surfaces.

### Imagery vibe

- The source system ships essentially zero photography. Its visual vocabulary is **colored orbs (atmospheric blurs)**, **noise texture**, **geometric unicode glyphs**, and **data visualization** (sparklines, ramps, status dots).
- If photography is introduced: cool, desaturated, 15% grain overlay, warm highlights only in Ember/Clinical contexts. Treat as rare.

### Cards

- Background: `--color-surface-1` (inside a `surface-0` page).
- Border: `1px solid var(--color-border-subtle)` or `--color-border`.
- Radius: `--r-xl` (16px) for content cards, `--r-lg` (10px) for dense panels.
- Shadow: `--shadow-sm` at rest; lift to `--shadow-md` only on "raised" states.
- Padding: 20–28px for content cards, 12–16px for dense/operator panels.

### Fixed elements

- `.titlebar` (44px, top-pinned) + `.statusbar` (26px, bottom-pinned) — always on screen in operator surfaces.
- Activity rail (56px) — left-pinned, vertical icon tray.
- Explorer (280px) — collapses below 960px viewport.

---

## Iconography

Beacon uses **no icon font and no SVG icon set of its own.** It deliberately ships with a vocabulary of **unicode glyphs** and **geometric symbols** used as single characters in mono type:

| Usage | Glyph(s) |
|---|---|
| Folder / disclosure | `▸ ▾` |
| Sort / arrows | `▲ ▼ ↗ ↑ ↓` |
| Status dot | `●` (paired with color) |
| Orb / bullet | `◉ ◎ ●` |
| Check / close | `✓ ×` |
| Separators | `/ · › —` |
| Menu / settings | `☰ ⌕ ◐ ↺ ⎇ ⚙` |
| Keys | `⌘ ⇧ ⌥ ⌃ ↵ ⇥` |

**Beacon does not use emoji, ever.** It avoids decorative pictograms. Where a surface needs "iconography," Beacon uses:

1. A **colored dot** (8px circle with optional glow shadow) for status
2. A **letter badge** (1–2 chars, monospace, colored background) for file type chips in the explorer
3. A **unicode glyph** (above table) for affordances and chrome buttons

If a product integrated with Beacon genuinely needs line icons (e.g. a marketing page), the recommended drop-in is **[Lucide](https://lucide.dev/)** (CDN: `https://unpkg.com/lucide@latest`) — its 1.5px stroke, sentence-case naming, and geometric construction align with Beacon's aesthetic.

> **This is a substitution flag** — Beacon's source repositories did not include a shipped icon set. Lucide is a recommendation, not an authoritative part of the system. If you have an internal icon library to plug in instead, use that.

Logos: the source system did not include a standalone Beacon logomark. The product wordmark is set in **Inter 600**, lowercase (`beacon`), with an 8px indigo **orb** (with matching box-shadow glow) as a lockup element. See `assets/beacon-lockup.svg`.

---

## Index — what's in this folder

```
README.md                    ← this file
SKILL.md                     ← skill metadata (for Claude Code / SKILL loading)
tokens.css                   ← full Beacon v2 token set (drop-in stylesheet)
colors_and_type.css          ← semantic layer: fg1–4, .t-h1, .t-lede, etc.
source_reference.html        ← the original "Design System v3" IDE preview

assets/                      ← logo wordmark, orb lockup, noise texture
fonts/                       ← (Inter & JetBrains Mono loaded via Google Fonts)
preview/                     ← HTML cards used by the Design System tab
ui_kits/
  llamactl/                  ← web control-plane UI kit
  novaflow/                  ← creative canvas UI kit
```

No slide templates were provided — `slides/` is not included.

### What was built here

This system packages everything needed to design for Beacon:

- **`tokens.css`** + **`colors_and_type.css`** — drop-in stylesheet. `data-theme` on the root swaps families.
- **`preview/`** — 21 standalone preview cards (type, color ramps, spacing, every primitive + key patterns). Each renders a single concept at its canonical size and is registered as an asset.
- **`ui_kits/llamactl/`** — full dense control plane UI kit on Sirius. Title bar, rail, explorer, tabs, stat cards, data table, streaming logs, ⌘K palette, status bar. `index.html` is interactive — ⌘K to open the palette, click tabs to switch between Services and Logs.
- **`ui_kits/novaflow/`** — full creative canvas UI kit on Ember. Top bar with tool palette, layers panel, artboard with selection handles, inspector with typography / fill / effects, timeline with transport + playhead. V/F/T/P/R/I/M/C keyboard shortcuts swap tools.
- **`SKILL.md`** — machine-readable ruleset for loading this system as a design skill.
- **`assets/`** — beacon lockup, orb, noise overlay SVG.

### Caveats & substitutions

- **Icons** — Beacon's source system ships no icon library. UI uses unicode glyphs where possible. If a future surface needs true line icons, the recommended substitute is [Lucide](https://lucide.dev) — flagged clearly in the Iconography section above, not authoritative.
- **Fonts** — loaded via Google Fonts, not self-hosted. For air-gapped deploys, replace the `@import` with self-hosted `@font-face` rules.
- **UI kits** are cosmetic recreations built on the tokens. Data is representative fixtures; interactivity is illustrative (tool swaps, palette overlay, tab switching).
- **Photography** — the source system is essentially photo-free. No imagery library is included; the recommended vocabulary is orbs, noise, glyphs, and data viz.
- **Slide / deck template** — not provided in source, not included.

### Themes, in one line each

- **Sirius** — indigo on carbon-black · operator default
- **Ember** — amber on warm dark · workshop / creative
- **Clinical** — disciplined blue on paper · light / print
- **Scrubs** — teal on oceanic dark · monitoring / on-call

### Quick start

```html
<link rel="stylesheet" href="colors_and_type.css" />
<html data-theme="sirius"> <!-- or ember | clinical | scrubs -->
```

That's it — every token resolves immediately. Switch themes by mutating `data-theme`.
