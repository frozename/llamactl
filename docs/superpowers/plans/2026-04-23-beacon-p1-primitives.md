# Beacon P1 — Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Beacon primitive component library (`@/ui/*`) and a live sandbox page so every module in P3 has a disciplined vocabulary to adopt. No module is forced to migrate in P1 — the library ships standalone.

**Architecture:** All primitives are small React functional components in `packages/app/src/ui/`, exported through a single barrel (`packages/app/src/ui/index.ts`). They consume Beacon tokens from `tokens.css` via `var(--…)` references — no inline hex values, no per-component theme awareness. The sandbox page is registered as a palette-only module so `⌘⇧P → "UI Primitives"` opens it.

**Tech Stack:** React 19, TypeScript 5.9 strict, Tailwind v4 for one-off layout (not for component styling — styling lives in inline `style` attributes keyed to CSS custom properties), Lucide icons, Bun `bun:test` for logic-only unit tests.

---

## File Structure

Create (all under `packages/app/src/ui/`):
- `index.ts` — barrel export
- `classes.ts` — `cx()` utility for conditional class-name join + unit tests
- `button.tsx` — Button (primary/secondary/ghost/outline × sm/md/lg)
- `badge.tsx` — Badge (default/brand/ok/warn/err)
- `status-dot.tsx` — StatusDot (ok/warn/err/idle/info, optional pulse)
- `kbd.tsx` — Kbd key pill
- `input.tsx` — Input with brand focus ring + optional slots
- `tabs.tsx` — Tabs / Tab row (controlled)
- `tree-item.tsx` — Explorer TreeItem (indentable, with chev + icon + label + trailing)
- `card.tsx` — Card + Panel (containers)
- `atmospheric-panel.tsx` — gradient + blobs container
- `stat-card.tsx` — StatCard with sparkline
- `editorial-hero.tsx` — serif display hero with lede + pill row
- `command-bar.tsx` — title-bar breadcrumb / command entry
- `theme-orbs.tsx` — four-dot theme picker

Also create:
- `packages/app/src/modules/ui-primitives/index.tsx` — the sandbox page (palette-only module)
- `packages/app/test/ui/classes.test.ts` — tests for the `cx()` helper
- `packages/app/test/ui/button.test.ts` — logic-only variant-class mapping test
- `packages/app/test/ui/stat-card.test.ts` — sparkline scaling math

Modify:
- `packages/app/src/modules/registry.ts` — add the sandbox entry (palette-only, hidden from activity bar)

---

## Task 1: Scaffolding + `cx()` helper with tests

**Files:**
- Create: `packages/app/src/ui/classes.ts`
- Create: `packages/app/src/ui/index.ts`
- Create: `packages/app/test/ui/classes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/app/test/ui/classes.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { cx } from '../../src/ui/classes';

describe('cx', () => {
  test('joins strings with a space', () => {
    expect(cx('a', 'b')).toBe('a b');
  });

  test('skips falsy values', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  test('handles the record form — truthy key → include', () => {
    expect(cx('a', { b: true, c: false, d: true })).toBe('a b d');
  });

  test('empty input returns empty string', () => {
    expect(cx()).toBe('');
  });

  test('no trailing or double spaces', () => {
    expect(cx('a', '', 'b', null, 'c')).toBe('a b c');
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

Run: `bun test --cwd packages/app test/ui/classes.test.ts`
Expected: FAIL — "Cannot find module '../../src/ui/classes'".

- [ ] **Step 3: Create `cx()` implementation**

Create `packages/app/src/ui/classes.ts`:

```typescript
/**
 * Minimal class-name join: strings pass through, falsy are skipped,
 * records contribute their truthy-valued keys. Used across @/ui to
 * merge static classes with variant-driven ones without pulling in
 * clsx as a dependency.
 */

type Value = string | false | null | undefined | Record<string, boolean | null | undefined>;

export function cx(...values: Value[]): string {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (typeof v === 'string') {
      if (v.length > 0) out.push(v);
      continue;
    }
    for (const [key, flag] of Object.entries(v)) {
      if (flag) out.push(key);
    }
  }
  return out.join(' ');
}
```

- [ ] **Step 4: Run test — confirm passes**

Run: `bun test --cwd packages/app test/ui/classes.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Create the empty barrel export**

Create `packages/app/src/ui/index.ts`:

```typescript
export { cx } from './classes';
```

Future primitives append their exports here.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/ui packages/app/test/ui/classes.test.ts
git commit -m "feat(app/ui): add @/ui barrel + cx() class-name helper"
```

---

## Task 2: Button primitive

**Files:**
- Create: `packages/app/src/ui/button.tsx`
- Create: `packages/app/test/ui/button.test.ts`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Write the failing test (pure mapping logic)**

Create `packages/app/test/ui/button.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { buttonClasses, type ButtonVariant, type ButtonSize } from '../../src/ui/button';

describe('buttonClasses', () => {
  const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'outline'];
  const sizes: ButtonSize[] = ['sm', 'md', 'lg'];

  test('every variant × size combination returns a non-empty class list', () => {
    for (const v of variants) {
      for (const s of sizes) {
        const out = buttonClasses(v, s);
        expect(out.length).toBeGreaterThan(10);
        expect(out).toContain('bcn-btn');
        expect(out).toContain(`bcn-btn--${v}`);
        expect(out).toContain(`bcn-btn--${s}`);
      }
    }
  });

  test('unknown variant falls back to primary', () => {
    expect(buttonClasses('nope' as ButtonVariant, 'md')).toContain('bcn-btn--primary');
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test --cwd packages/app test/ui/button.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Button**

Create `packages/app/src/ui/button.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  loading?: boolean;
}

/** Pure — exported so the variant mapping is unit-testable without
 *  mounting React. */
export function buttonClasses(variant: ButtonVariant, size: ButtonSize): string {
  const v: ButtonVariant = ['primary', 'secondary', 'ghost', 'outline'].includes(variant)
    ? variant
    : 'primary';
  const s: ButtonSize = ['sm', 'md', 'lg'].includes(size) ? size : 'md';
  return cx('bcn-btn', `bcn-btn--${v}`, `bcn-btn--${s}`);
}

export function Button({
  variant = 'primary',
  size = 'md',
  leadingIcon,
  trailingIcon,
  loading = false,
  disabled,
  className,
  children,
  style,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(buttonClasses(variant, size), className)}
      style={{ ...BASE_STYLE, ...VARIANT_STYLE[variant], ...SIZE_STYLE[size], ...style }}
    >
      {leadingIcon && <span className="bcn-btn__icon">{leadingIcon}</span>}
      <span>{children}</span>
      {trailingIcon && <span className="bcn-btn__icon">{trailingIcon}</span>}
    </button>
  );
}

const BASE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  borderRadius: 'var(--r-lg)',
  transition: 'background 160ms, border-color 160ms, box-shadow 160ms',
  border: '1px solid transparent',
  fontFamily: 'var(--font-sans)',
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const VARIANT_STYLE: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--color-brand)',
    color: 'var(--color-brand-contrast)',
  },
  secondary: {
    background: 'var(--color-surface-3)',
    color: 'var(--color-text)',
    borderColor: 'var(--color-border)',
  },
  ghost: { background: 'transparent', color: 'var(--color-text-secondary)' },
  outline: {
    background: 'transparent',
    color: 'var(--color-text)',
    borderColor: 'var(--color-border-strong)',
  },
};

const SIZE_STYLE: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '5px 10px', fontSize: 12 },
  md: { padding: '8px 14px', fontSize: 13 },
  lg: { padding: '10px 18px', fontSize: 14 },
};
```

- [ ] **Step 4: Confirm tests pass**

Run: `bun test --cwd packages/app test/ui/button.test.ts`
Expected: PASS.

- [ ] **Step 5: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { Button, buttonClasses } from './button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './button';
```

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/ui/button.tsx packages/app/src/ui/index.ts packages/app/test/ui/button.test.ts
git commit -m "feat(app/ui): add Button primitive (primary/secondary/ghost/outline × sm/md/lg)"
```

---

## Task 3: Badge primitive

**Files:**
- Create: `packages/app/src/ui/badge.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/badge.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export type BadgeVariant = 'default' | 'brand' | 'ok' | 'warn' | 'err';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANT_STYLE: Record<BadgeVariant, React.CSSProperties> = {
  default: { background: 'var(--color-surface-3)', color: 'var(--color-text-secondary)' },
  brand:   { background: 'var(--color-brand-muted)', color: 'var(--color-brand)' },
  ok:      { background: 'rgba(52,211,153,0.15)', color: 'var(--color-ok)' },
  warn:    { background: 'rgba(251,191,36,0.15)', color: 'var(--color-warn)' },
  err:     { background: 'rgba(248,113,113,0.15)', color: 'var(--color-err)' },
};

const BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  borderRadius: 'var(--r-sm)',
  letterSpacing: '0.04em',
};

export function Badge({
  variant = 'default',
  className,
  style,
  children,
  ...rest
}: BadgeProps): React.JSX.Element {
  return (
    <span
      {...rest}
      className={cx('bcn-badge', `bcn-badge--${variant}`, className)}
      style={{ ...BASE, ...VARIANT_STYLE[variant], ...style }}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { Badge } from './badge';
export type { BadgeProps, BadgeVariant } from './badge';
```

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/ui/badge.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add Badge primitive (default/brand/ok/warn/err)"
```

---

## Task 4: StatusDot primitive

**Files:**
- Create: `packages/app/src/ui/status-dot.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/status-dot.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export type StatusDotTone = 'ok' | 'warn' | 'err' | 'idle' | 'info';

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone;
  pulse?: boolean;
  label?: React.ReactNode;
}

const COLOR: Record<StatusDotTone, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  err: 'var(--color-err)',
  idle: 'var(--color-text-ghost)',
  info: 'var(--color-info)',
};

export function StatusDot({
  tone = 'ok',
  pulse = false,
  label,
  className,
  style,
  ...rest
}: StatusDotProps): React.JSX.Element {
  const color = COLOR[tone];
  const glow = tone === 'idle' ? 'none' : `0 0 8px ${color}`;
  return (
    <span
      {...rest}
      className={cx('bcn-status-dot', className)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        color: 'var(--color-text-secondary)',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          boxShadow: glow,
          flexShrink: 0,
          animation: pulse ? 'bcn-pulse 2s ease-in-out infinite' : undefined,
        }}
      />
      {label && <span>{label}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Add the pulse keyframes to `tokens.css`**

Append to `packages/app/src/themes/tokens.css`:

```css
@keyframes bcn-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.3); }
}
```

- [ ] **Step 3: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { StatusDot } from './status-dot';
export type { StatusDotProps, StatusDotTone } from './status-dot';
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/ui/status-dot.tsx packages/app/src/ui/index.ts packages/app/src/themes/tokens.css
git commit -m "feat(app/ui): add StatusDot primitive with pulse animation"
```

---

## Task 5: Kbd primitive

**Files:**
- Create: `packages/app/src/ui/kbd.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/kbd.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Render compact (18×18 instead of 22×22). Used inside input hints. */
  compact?: boolean;
}

export function Kbd({ compact, className, style, children, ...rest }: KbdProps): React.JSX.Element {
  const size = compact ? { minWidth: 18, height: 18, fontSize: 10, padding: '0 5px' } : {};
  return (
    <kbd
      {...rest}
      className={cx('bcn-kbd', className)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 22,
        height: 22,
        padding: '0 6px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        color: 'var(--color-text-secondary)',
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border)',
        borderBottomWidth: 2,
        borderRadius: 'var(--r-sm)',
        lineHeight: 1,
        ...size,
        ...style,
      }}
    >
      {children}
    </kbd>
  );
}
```

- [ ] **Step 2: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { Kbd } from './kbd';
export type { KbdProps } from './kbd';
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/ui/kbd.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add Kbd primitive"
```

---

## Task 6: Input primitive

**Files:**
- Create: `packages/app/src/ui/input.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/input.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leadingSlot?: React.ReactNode;
  trailingSlot?: React.ReactNode;
  invalid?: boolean;
}

/**
 * Text input with Beacon focus-ring (brand-ghost 3 px). Optional
 * leading/trailing slots render inside the frame; the real <input>
 * stretches the middle. Pass ref through for focus management.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { leadingSlot, trailingSlot, invalid, className, style, disabled, ...rest },
  ref,
) {
  const borderColor = invalid ? 'var(--color-err)' : 'var(--color-border)';
  return (
    <label
      className={cx('bcn-input', invalid && 'bcn-input--invalid', disabled && 'bcn-input--disabled', className)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '9px 12px',
        fontSize: 13,
        background: 'var(--color-surface-2)',
        color: 'var(--color-text)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--r-lg)',
        transition: 'border-color 160ms, box-shadow 160ms, background 160ms',
        cursor: disabled ? 'not-allowed' : 'text',
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
      onFocusCapture={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-brand)';
        e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-brand-ghost)';
        e.currentTarget.style.background = 'var(--color-surface-1)';
      }}
      onBlurCapture={(e) => {
        e.currentTarget.style.borderColor = borderColor;
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.background = 'var(--color-surface-2)';
      }}
    >
      {leadingSlot}
      <input
        ref={ref}
        disabled={disabled}
        {...rest}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'inherit',
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
        }}
      />
      {trailingSlot}
    </label>
  );
});
```

- [ ] **Step 2: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { Input } from './input';
export type { InputProps } from './input';
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/ui/input.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add Input primitive with brand focus ring + slots"
```

---

## Task 7: Tabs primitive

**Files:**
- Create: `packages/app/src/ui/tabs.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/tabs.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (next: string) => void;
  children: React.ReactNode;
}

export interface TabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsCtx = React.createContext<{
  value: string;
  onValueChange: (next: string) => void;
} | null>(null);

export function Tabs({ value, onValueChange, className, children, ...rest }: TabsProps): React.JSX.Element {
  return (
    <TabsCtx.Provider value={{ value, onValueChange }}>
      <div
        role="tablist"
        {...rest}
        className={cx('bcn-tabs', className)}
        style={{
          display: 'flex',
          gap: 2,
          borderBottom: '1px solid var(--color-border-subtle)',
          width: '100%',
        }}
      >
        {children}
      </div>
    </TabsCtx.Provider>
  );
}

export function Tab({ value, className, children, ...rest }: TabProps): React.JSX.Element {
  const ctx = React.useContext(TabsCtx);
  if (!ctx) throw new Error('Tab must be rendered inside Tabs');
  const active = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (!e.defaultPrevented) ctx.onValueChange(value);
      }}
      className={cx('bcn-tab', active && 'bcn-tab--active', className)}
      style={{
        padding: '8px 14px',
        fontSize: 12,
        color: active ? 'var(--color-text)' : 'var(--color-text-tertiary)',
        borderBottom: active ? '1.5px solid var(--color-brand)' : '1.5px solid transparent',
        marginBottom: -1,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        transition: 'color 160ms',
      }}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { Tabs, Tab } from './tabs';
export type { TabsProps, TabProps } from './tabs';
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/ui/tabs.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add controlled Tabs primitive"
```

---

## Task 8: TreeItem primitive

**Files:**
- Create: `packages/app/src/ui/tree-item.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/tree-item.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export interface TreeItemProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  indent?: 0 | 1 | 2;
  active?: boolean;
  /** If true, render a chevron slot (collapsed); `undefined` = leaf; `false` = expanded. */
  collapsed?: boolean | undefined;
}

/**
 * One row in the Explorer tree. Indent is integer (0/1/2); deeper nesting
 * is intentionally not supported — if you need three levels, fold the
 * middle level into a section head instead.
 */
export function TreeItem({
  label,
  icon,
  trailing,
  indent = 0,
  active = false,
  collapsed,
  className,
  style,
  onClick,
  ...rest
}: TreeItemProps): React.JSX.Element {
  return (
    <div
      role="treeitem"
      aria-selected={active}
      onClick={onClick}
      {...rest}
      className={cx('bcn-tree-item', active && 'bcn-tree-item--active', className)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 4,
        paddingBottom: 4,
        paddingLeft: 14 + indent * 14,
        paddingRight: 18,
        fontSize: 13,
        color: active ? 'var(--color-text)' : 'var(--color-text-secondary)',
        background: active ? 'var(--color-brand-ghost)' : 'transparent',
        cursor: 'pointer',
        userSelect: 'none',
        position: 'relative',
        lineHeight: 1.4,
        ...style,
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            top: 2,
            bottom: 2,
            width: 2,
            background: 'var(--color-brand)',
            borderRadius: 2,
          }}
        />
      )}
      <span
        aria-hidden="true"
        style={{
          width: 10,
          color: 'var(--color-text-ghost)',
          fontSize: 9,
          flexShrink: 0,
          visibility: collapsed === undefined ? 'hidden' : 'visible',
          transform: collapsed ? 'rotate(-90deg)' : 'none',
          transition: 'transform 160ms',
        }}
      >
        ▾
      </span>
      {icon && (
        <span
          aria-hidden="true"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14 }}
        >
          {icon}
        </span>
      )}
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      {trailing && <span style={{ flexShrink: 0 }}>{trailing}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { TreeItem } from './tree-item';
export type { TreeItemProps } from './tree-item';
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/ui/tree-item.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add TreeItem primitive for Explorer rows"
```

---

## Task 9: Card, Panel, AtmosphericPanel

**Files:**
- Create: `packages/app/src/ui/card.tsx`
- Create: `packages/app/src/ui/atmospheric-panel.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create Card + Panel**

Create `packages/app/src/ui/card.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Surface tier: 1 (default) or 2 for an elevated variant. */
  tier?: 1 | 2;
  /** Render a subtle border (default: true). */
  bordered?: boolean;
}

export function Card({ tier = 1, bordered = true, className, style, children, ...rest }: CardProps): React.JSX.Element {
  const bg = tier === 2 ? 'var(--color-surface-2)' : 'var(--color-surface-1)';
  return (
    <div
      {...rest}
      className={cx('bcn-card', `bcn-card--tier${tier}`, className)}
      style={{
        background: bg,
        border: bordered ? '1px solid var(--color-border-subtle)' : 'none',
        borderRadius: 'var(--r-xl)',
        padding: 28,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Same visual weight as Card but meant for a larger section container
 *  without the 28 px internal padding. Caller controls layout. */
export function Panel({ tier = 1, bordered = true, className, style, children, ...rest }: CardProps): React.JSX.Element {
  const bg = tier === 2 ? 'var(--color-surface-2)' : 'var(--color-surface-1)';
  return (
    <div
      {...rest}
      className={cx('bcn-panel', `bcn-panel--tier${tier}`, className)}
      style={{
        background: bg,
        border: bordered ? '1px solid var(--color-border-subtle)' : 'none',
        borderRadius: 'var(--r-xl)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Create AtmosphericPanel**

Create `packages/app/src/ui/atmospheric-panel.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export interface AtmosphericPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Blob palette — `brand`/`amber` matches Beacon's hero aesthetic. */
  palette?: 'brand' | 'amber' | 'brand-amber';
}

/**
 * Gradient surface-1 background with two blurred blobs — used for
 * editorial hero containers (Dashboard landing, empty states, etc.).
 * Blobs are absolutely positioned inside the rounded frame; caller's
 * content renders above them at z:1.
 */
export function AtmosphericPanel({
  palette = 'brand-amber',
  className,
  style,
  children,
  ...rest
}: AtmosphericPanelProps): React.JSX.Element {
  const blobA = 'var(--color-brand)';
  const blobB = palette === 'brand-amber' ? '#f59e0b' : palette === 'amber' ? '#f59e0b' : 'var(--color-brand)';
  return (
    <div
      {...rest}
      className={cx('bcn-atmospheric', className)}
      style={{
        position: 'relative',
        padding: 48,
        borderRadius: 'var(--r-xl)',
        background: 'linear-gradient(135deg, var(--color-surface-1), var(--color-surface-2))',
        border: '1px solid var(--color-border-subtle)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: -80,
          right: -80,
          width: 320,
          height: 320,
          borderRadius: '50%',
          background: blobA,
          opacity: 0.10,
          filter: 'blur(60px)',
        }}
      />
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          bottom: -60,
          left: -60,
          width: 200,
          height: 200,
          borderRadius: '50%',
          background: blobB,
          opacity: 0.08,
          filter: 'blur(60px)',
        }}
      />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}
```

- [ ] **Step 3: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { Card, Panel } from './card';
export type { CardProps } from './card';
export { AtmosphericPanel } from './atmospheric-panel';
export type { AtmosphericPanelProps } from './atmospheric-panel';
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/ui/card.tsx packages/app/src/ui/atmospheric-panel.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add Card, Panel, AtmosphericPanel"
```

---

## Task 10: StatCard (with sparkline math)

**Files:**
- Create: `packages/app/src/ui/stat-card.tsx`
- Create: `packages/app/test/ui/stat-card.test.ts`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Write the failing test for the sparkline scaling**

Create `packages/app/test/ui/stat-card.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { sparklineHeights } from '../../src/ui/stat-card';

describe('sparklineHeights', () => {
  test('maps the max value to full height', () => {
    const out = sparklineHeights([1, 2, 4, 8], 32);
    expect(out[3]).toBe(32);
  });

  test('maps the min value to at least 2 px for visibility', () => {
    const out = sparklineHeights([0, 10], 32);
    expect(out[0]).toBeGreaterThanOrEqual(2);
  });

  test('empty input returns empty array', () => {
    expect(sparklineHeights([], 32)).toEqual([]);
  });

  test('all-equal values render at full height each', () => {
    expect(sparklineHeights([5, 5, 5], 20)).toEqual([20, 20, 20]);
  });

  test('respects the max-height argument', () => {
    const out = sparklineHeights([1, 10], 10);
    expect(out[1]).toBe(10);
    expect(out[0]).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test --cwd packages/app test/ui/stat-card.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement StatCard**

Create `packages/app/src/ui/stat-card.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  unit?: string;
  delta?: { text: string; direction?: 'up' | 'down' | 'flat' };
  sparkline?: readonly number[];
}

/**
 * Scales a sample series into bar heights for the 32 px sparkline.
 * Max value → full height; min value → floor of 2 px so zero samples
 * are still visible. Exported for unit testing.
 */
export function sparklineHeights(samples: readonly number[], maxHeight: number): number[] {
  if (samples.length === 0) return [];
  const max = Math.max(...samples);
  if (max === 0) return samples.map(() => Math.min(2, maxHeight));
  return samples.map((s) => {
    const raw = (s / max) * maxHeight;
    return Math.max(2, Math.round(raw));
  });
}

export function StatCard({
  label,
  value,
  unit,
  delta,
  sparkline,
  className,
  style,
  ...rest
}: StatCardProps): React.JSX.Element {
  const deltaColor =
    delta?.direction === 'up' ? 'var(--color-ok)' :
    delta?.direction === 'down' ? 'var(--color-err)' :
    'var(--color-text-secondary)';

  const heights = sparkline ? sparklineHeights(sparkline, 32) : undefined;

  return (
    <div
      {...rest}
      className={cx('bcn-stat-card', className)}
      style={{
        padding: 20,
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--r-lg)',
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 36,
          fontWeight: 600,
          lineHeight: 1,
          letterSpacing: '-0.02em',
          marginBottom: 6,
          color: 'var(--color-text)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
        {unit && (
          <span
            style={{
              color: 'var(--color-brand)',
              fontSize: 20,
              fontWeight: 400,
              verticalAlign: 'top',
              marginLeft: 2,
            }}
          >
            {unit}
          </span>
        )}
      </div>
      {delta && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: deltaColor }}>
          {delta.text}
        </div>
      )}
      {heights && (
        <div style={{ height: 32, marginTop: 10, display: 'flex', alignItems: 'flex-end', gap: 2 }}>
          {heights.map((h, i) => (
            <div
              key={i}
              aria-hidden="true"
              style={{
                flex: 1,
                height: h,
                background: 'var(--color-brand)',
                opacity: 0.6,
                borderRadius: 1,
                transition: 'opacity 200ms',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `bun test --cwd packages/app test/ui/stat-card.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { StatCard, sparklineHeights } from './stat-card';
export type { StatCardProps } from './stat-card';
```

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/ui/stat-card.tsx packages/app/src/ui/index.ts packages/app/test/ui/stat-card.test.ts
git commit -m "feat(app/ui): add StatCard with sparkline (+ sparklineHeights scaling)"
```

---

## Task 11: EditorialHero

**Files:**
- Create: `packages/app/src/ui/editorial-hero.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/editorial-hero.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';
import { AtmosphericPanel } from './atmospheric-panel';

export interface EditorialHeroProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Secondary emphasis span inside the title (renders in brand). Pass
   *  plain text or a <em> — this component wraps it. */
  titleAccent?: React.ReactNode;
  lede?: React.ReactNode;
  pills?: readonly { label: React.ReactNode; tone?: 'default' | 'ok' | 'info' }[];
  actions?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Hero block with serif display title, atmospheric backdrop, and an
 * optional pill row. Used on Dashboard landing, module empty states,
 * Settings section heads, About page. Never inside dense data views.
 */
export function EditorialHero({
  eyebrow,
  title,
  titleAccent,
  lede,
  pills,
  actions,
  className,
  style,
}: EditorialHeroProps): React.JSX.Element {
  return (
    <AtmosphericPanel className={cx('bcn-editorial-hero', className)} style={style}>
      {eyebrow && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--color-text-tertiary)',
            marginBottom: 20,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--color-brand)',
              boxShadow: '0 0 8px var(--color-brand)',
            }}
          />
          {eyebrow}
        </div>
      )}
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 400,
          fontSize: 'clamp(48px, 7vw, 96px)',
          letterSpacing: '-0.02em',
          lineHeight: 0.98,
          margin: '0 0 20px',
          color: 'var(--color-text)',
        }}
      >
        {title}
        {titleAccent && (
          <>
            {' '}
            <em style={{ fontStyle: 'italic', color: 'var(--color-brand)' }}>{titleAccent}</em>
          </>
        )}
      </h1>
      {lede && (
        <p
          style={{
            fontSize: 19,
            lineHeight: 1.55,
            color: 'var(--color-text-secondary)',
            maxWidth: '62ch',
            margin: '0 0 24px',
            fontWeight: 300,
          }}
        >
          {lede}
        </p>
      )}
      {pills && pills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: actions ? 24 : 0 }}>
          {pills.map((p, i) => (
            <span
              key={i}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 'var(--r-pill)',
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border-subtle)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-text-secondary)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background:
                    p.tone === 'ok' ? 'var(--color-ok)' :
                    p.tone === 'info' ? 'var(--color-info)' :
                    'var(--color-text-tertiary)',
                  boxShadow:
                    p.tone === 'ok' ? '0 0 6px var(--color-ok)' :
                    p.tone === 'info' ? '0 0 6px var(--color-info)' :
                    'none',
                }}
              />
              {p.label}
            </span>
          ))}
        </div>
      )}
      {actions && <div>{actions}</div>}
    </AtmosphericPanel>
  );
}
```

- [ ] **Step 2: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { EditorialHero } from './editorial-hero';
export type { EditorialHeroProps } from './editorial-hero';
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/ui/editorial-hero.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add EditorialHero"
```

---

## Task 12: CommandBar (title-bar breadcrumb)

**Files:**
- Create: `packages/app/src/ui/command-bar.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/command-bar.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';
import { Kbd } from './kbd';

export interface CommandBarCrumb {
  label: React.ReactNode;
  /** If true, render in full text color (active segment). */
  current?: boolean;
}

export interface CommandBarProps extends React.HTMLAttributes<HTMLButtonElement> {
  crumbs: readonly CommandBarCrumb[];
  /** Keyboard hint shown at the right edge. */
  shortcut?: React.ReactNode;
}

/**
 * Title-bar breadcrumb that behaves as a single button — clicking it
 * opens the command palette (⌘K). Orb-led, slash-separated, with a
 * kbd hint on the right. Used as the center slot of TitleBar Layout B.
 */
export function CommandBar({
  crumbs,
  shortcut = '⌘K',
  className,
  style,
  onClick,
  ...rest
}: CommandBarProps): React.JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      onClick={onClick}
      className={cx('bcn-command-bar', className)}
      style={{
        all: 'unset',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 16px',
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--r-lg)',
        minWidth: 360,
        maxWidth: 520,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--color-text-secondary)',
        cursor: 'text',
        transition: 'border-color 160ms',
        ...style,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-subtle)'; }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: 'var(--color-brand)',
          boxShadow: '0 0 10px var(--color-brand)',
          flexShrink: 0,
        }}
      />
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: 'var(--color-text-ghost)' }}>/</span>}
          <span style={{ color: c.current ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
            {c.label}
          </span>
        </React.Fragment>
      ))}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
        <Kbd compact>{shortcut}</Kbd>
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { CommandBar } from './command-bar';
export type { CommandBarProps, CommandBarCrumb } from './command-bar';
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/ui/command-bar.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add CommandBar breadcrumb primitive"
```

---

## Task 13: ThemeOrbs

**Files:**
- Create: `packages/app/src/ui/theme-orbs.tsx`
- Modify: `packages/app/src/ui/index.ts`

- [ ] **Step 1: Create the component**

Create `packages/app/src/ui/theme-orbs.tsx`:

```typescript
import * as React from 'react';
import { cx } from './classes';
import { THEMES, type ThemeId } from '@/themes';

export interface ThemeOrbsProps extends React.HTMLAttributes<HTMLDivElement> {
  activeId: ThemeId;
  onPick: (id: ThemeId) => void;
}

/** Four-dot theme picker — the title-bar control. Pure presentation;
 *  orchestration (persisting, hovering for live-preview) belongs to
 *  the caller. */
export function ThemeOrbs({ activeId, onPick, className, style, ...rest }: ThemeOrbsProps): React.JSX.Element {
  return (
    <div
      role="tablist"
      {...rest}
      className={cx('bcn-theme-orbs', className)}
      style={{
        display: 'flex',
        gap: 2,
        padding: 3,
        background: 'var(--color-surface-2)',
        borderRadius: 'var(--r-pill)',
        border: '1px solid var(--color-border-subtle)',
        ...style,
      }}
    >
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === activeId}
          onClick={() => onPick(t.id)}
          title={`${t.label} — ${t.tagline}`}
          style={{
            all: 'unset',
            width: 16,
            height: 16,
            borderRadius: '50%',
            cursor: 'pointer',
            position: 'relative',
            transition: 'transform 160ms',
            background: orbBackground(t.id),
            boxShadow: t.id === 'clinical' ? 'inset 0 0 0 1.5px #faf9f7' : undefined,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.15)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; }}
        >
          {t.id === activeId && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: -3,
                borderRadius: '50%',
                border: '1.5px solid var(--color-text)',
              }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

function orbBackground(id: ThemeId): string {
  switch (id) {
    case 'sirius':   return '#6366f1';
    case 'ember':    return '#f59e0b';
    case 'clinical': return '#2563eb';
    case 'scrubs':   return '#14b8a6';
  }
}
```

- [ ] **Step 2: Add to barrel**

Append to `packages/app/src/ui/index.ts`:

```typescript
export { ThemeOrbs } from './theme-orbs';
export type { ThemeOrbsProps } from './theme-orbs';
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/ui/theme-orbs.tsx packages/app/src/ui/index.ts
git commit -m "feat(app/ui): add ThemeOrbs title-bar picker"
```

---

## Task 14: Primitives sandbox module + palette entry

**Files:**
- Create: `packages/app/src/modules/ui-primitives/index.tsx`
- Modify: `packages/app/src/modules/registry.ts`

- [ ] **Step 1: Create the sandbox page**

Create `packages/app/src/modules/ui-primitives/index.tsx`:

```typescript
import * as React from 'react';
import { useThemeStore } from '@/stores/theme-store';
import {
  Badge,
  Button,
  Card,
  CommandBar,
  EditorialHero,
  Input,
  Kbd,
  Panel,
  StatCard,
  StatusDot,
  Tab,
  Tabs,
  ThemeOrbs,
  TreeItem,
  AtmosphericPanel,
} from '@/ui';
import type { ThemeId } from '@/themes';

/**
 * Visual verification surface for the @/ui primitive library. Not
 * shown on the activity bar — reachable via the command palette as
 * "Go to UI Primitives". Renders every primitive in every variant
 * against the active theme so designers + implementers can eyeball
 * coverage and color correctness across all four families.
 */
export default function UIPrimitivesSandbox(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const [tab, setTab] = React.useState('primitives');

  return (
    <div style={{ padding: 48, maxWidth: 1200, margin: '0 auto' }}>
      <EditorialHero
        eyebrow="Beacon · Primitives"
        title="The vocabulary"
        titleAccent="we share"
        lede="Every block below is drawn from the @/ui library. Switch themes from the title bar to verify color correctness; everything below repaints live."
        pills={[
          { label: 'healthy', tone: 'ok' },
          { label: 'P1 · Primitives', tone: 'info' },
        ]}
      />

      <Section title="Buttons">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="outline">Outline</Button>
        </Row>
        <Row>
          <Button variant="primary" size="sm">Small</Button>
          <Button variant="primary" size="md">Medium</Button>
          <Button variant="primary" size="lg">Large</Button>
        </Row>
      </Section>

      <Section title="Badges + StatusDots + Kbd">
        <Row>
          <Badge>default</Badge>
          <Badge variant="brand">brand</Badge>
          <Badge variant="ok">ok</Badge>
          <Badge variant="warn">warn</Badge>
          <Badge variant="err">err</Badge>
        </Row>
        <Row>
          <StatusDot tone="ok" label="healthy" />
          <StatusDot tone="warn" label="degraded" pulse />
          <StatusDot tone="err" label="down" pulse />
          <StatusDot tone="idle" label="offline" />
          <StatusDot tone="info" label="starting" pulse />
        </Row>
        <Row>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <Kbd>⌘⇧P</Kbd>
          <Kbd compact>⌘K</Kbd>
        </Row>
      </Section>

      <Section title="Input">
        <Input placeholder="Search…" />
        <div style={{ height: 12 }} />
        <Input placeholder="Invalid" invalid />
        <div style={{ height: 12 }} />
        <Input placeholder="Disabled" disabled />
      </Section>

      <Section title="Tabs">
        <Tabs value={tab} onValueChange={setTab}>
          <Tab value="primitives">Primitives</Tab>
          <Tab value="patterns">Patterns</Tab>
          <Tab value="tokens">Tokens</Tab>
        </Tabs>
        <p style={{ marginTop: 12, color: 'var(--color-text-secondary)' }}>
          Active tab: <code>{tab}</code>
        </p>
      </Section>

      <Section title="Tree items">
        <Panel>
          <TreeItem label="README.md" icon={<DotIcon />} active />
          <TreeItem label="color.css" icon={<DotIcon />} trailing={<span className="mono" style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>108</span>} />
          <TreeItem label="typography.css" icon={<DotIcon />} trailing={<span className="mono" style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>12</span>} />
          <TreeItem label="Workloads" collapsed={false} icon={<DotIcon />} />
          <TreeItem indent={1} label="wl-abc · qwen-coder" icon={<DotIcon />} trailing={<StatusDot tone="ok" />} />
          <TreeItem indent={1} label="wl-ghi · llama-70b" icon={<DotIcon />} trailing={<StatusDot tone="warn" pulse />} />
        </Panel>
      </Section>

      <Section title="StatCards">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <StatCard label="tokens / sec" value="48.2" unit="t/s" delta={{ text: '↑ 12 %', direction: 'up' }} sparkline={[10, 14, 9, 18, 22, 16, 28, 24, 32, 30, 38, 48]} />
          <StatCard label="workloads" value="3" delta={{ text: '— no change', direction: 'flat' }} />
          <StatCard label="queue depth" value="12" delta={{ text: '↓ 4', direction: 'down' }} sparkline={[20, 22, 18, 15, 14, 12, 16, 12, 10, 12]} />
          <StatCard label="nodes" value="4" unit="/6" />
        </div>
      </Section>

      <Section title="AtmosphericPanel">
        <AtmosphericPanel>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 64 }}>Beacon</h2>
          <p style={{ color: 'var(--color-text-secondary)', maxWidth: '50ch' }}>
            The atmospheric surface — gradient, two blurred blobs, noise overlay from tokens. Use for
            hero moments only.
          </p>
        </AtmosphericPanel>
      </Section>

      <Section title="CommandBar + ThemeOrbs">
        <Row>
          <CommandBar
            crumbs={[
              { label: 'beacon' },
              { label: 'Ops' },
              { label: 'wl-ghi', current: true },
            ]}
          />
          <ThemeOrbs activeId={themeId} onPick={(id: ThemeId) => setThemeId(id)} />
        </Row>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section style={{ marginTop: 48 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>{children}</div>;
}

function DotIcon(): React.JSX.Element {
  return <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--color-text-tertiary)', display: 'inline-block' }} />;
}
```

- [ ] **Step 2: Register the sandbox in `registry.ts` as a palette-only module**

Edit `packages/app/src/modules/registry.ts`. Add next to the other `lazy(() => …)` statements near the top:

```typescript
const LazyUIPrimitives = lazy(() => import('./ui-primitives/index'));
```

Then append to the `APP_MODULES` array (below the Settings entry, or anywhere in the list — position doesn't matter for palette-only modules):

```typescript
  {
    id: 'ui-primitives',
    labelKey: 'UI Primitives',
    icon: FolderKanban, // reused — P2/P3 will swap this when the registry schema changes
    Component: LazyUIPrimitives,
    activityBar: false,
    group: 'core',
    aliases: ['sandbox', 'components', 'primitives', 'beacon'],
  },
```

(`FolderKanban` is already imported at the top of `registry.ts`; no new imports needed.)

- [ ] **Step 3: Launch and verify**

Run: `bun run --cwd packages/app dev`

1. `⌘⇧P` → type `UI Primitives` → Enter. Sandbox renders.
2. Cycle themes via the title-bar picker or `⌘K⌘T`. Every primitive should repaint to the new palette without artifacts.
3. Hover + click the orbs. Buttons change color; the `active` border snaps to the new id.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/modules/ui-primitives packages/app/src/modules/registry.ts
git commit -m "feat(app): add UI Primitives sandbox (palette-only module)"
```

---

## Task 15: End-of-phase verification

- [ ] **Step 1: Typecheck**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 2: Run every P1 unit test**

Run: `bun test --cwd packages/app test/ui`
Expected: green. Three files — `classes.test.ts`, `button.test.ts`, `stat-card.test.ts` — 13+ tests total.

- [ ] **Step 3: Top-level suite**

Run: `bun run test`
Expected: green. Note any pre-existing unrelated failures and move on.

- [ ] **Step 4: Launch sandbox across all four themes**

Run: `bun run --cwd packages/app dev`
For each theme (Sirius, Ember, Clinical, Scrubs):
- Open UI Primitives sandbox.
- Visually confirm every section paints correctly (no broken colors, no `#000000` fallback on surfaces, no clipped heroes, no missing borders where they should exist).
- Clinical especially — status colors need to read on a light background.

- [ ] **Step 5: Tag**

```bash
git tag beacon-p1
```

---

## Self-review against the spec

- §4 Primitive inventory — all 14 primitives implemented:
  - Button ✓ (Task 2) · Badge ✓ (Task 3) · StatusDot ✓ (Task 4) · Kbd ✓ (Task 5)
  - Input ✓ (Task 6) · Tabs/Tab ✓ (Task 7) · TreeItem ✓ (Task 8)
  - Card/Panel ✓ (Task 9) · AtmosphericPanel ✓ (Task 9)
  - StatCard ✓ (Task 10) · EditorialHero ✓ (Task 11)
  - CommandBar ✓ (Task 12) · ThemeOrbs ✓ (Task 13)
- §4 "Storybook-style sandbox reachable via the command palette" — Task 14.
- No module is forced to migrate in P1 — the library ships standalone and P3 will migrate callers.

Deferred:
- Actual wiring of CommandBar + ThemeOrbs in the TitleBar → P2.
- Replacing existing inline button/badge/input markup across modules → P3.
- Removal of legacy `--color-fg`, `--color-accent`, etc. aliases → end of P3.
