# Beacon P4 — Primitive Adoption (Long-Tail)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all remaining legacy UI code across the application and fully adopt the `@/ui` token system (Beacon). By the end of this phase, the application will have a unified visual language and no dependencies on the old styling or hard-coded legacy CSS classes.

**Architecture:** Each remaining module gets a dedicated pass to strip out legacy inline classes (like Tailwind-esque utility strings) and replace them with standard inline React styles using CSS custom properties (`var(--color-...)`) alongside the standard Beacon primitives.

---

## The Find-and-Replace Playbook

Apply these substitutions (read the file first; don't rewrite code you don't understand):

| Legacy Pattern | Replacement Primitive |
| --- | --- |
| `<button className="...">` | `<Button variant="secondary" size="sm">` |
| `<span className="... bg-[color-mix…] ...">` | `<Badge variant="brand">` |
| `<span className="h-2 w-2 rounded-full bg-...">` | `<StatusDot tone="ok\|warn\|err\|idle" />` |
| Inline input with manual focus styles | `<Input>` |
| Empty-state hero blocks | `<EditorialHero>` (full-bleed) or `<AtmosphericPanel>` (inline) |
| Grids of stat numbers | `<StatCard>` |
| Utility classes (`text-xs`, `border-b`) | `style={{ fontSize: 12, borderBottom: '1px solid var(--color-border)' }}` |

---

## Task 1: Core Data & Stats (Dashboard & Cost)

**Files:**
- Modify: `packages/app/src/modules/dashboard/index.tsx` (the stats grid)
- Modify: `packages/app/src/modules/cost/index.tsx`

- [ ] **Step 1: Migrate Dashboard Stats Grid**
  Replace the ad-hoc stat blocks below the `EditorialHero` with `<StatCard>` components. Replace any raw buttons with `<Button>`.
- [ ] **Step 2: Migrate Cost Module**
  Replace tables and stat displays with standard UI components. If it has an empty state, use `<EditorialHero>`.
- [ ] **Step 3: Typecheck and Smoke Test**
  `bun run --cwd packages/app typecheck`
- [ ] **Step 4: Commit**
  `refactor(app): adopt @/ui primitives in dashboard and cost`

---

## Task 2: Cluster & Models

**Files:**
- Modify: `packages/app/src/modules/nodes/index.tsx`
- Modify: `packages/app/src/modules/models/catalog/index.tsx`
- Modify: `packages/app/src/modules/models/presets/index.tsx`
- Modify: `packages/app/src/modules/models/pulls/index.tsx`
- Modify: `packages/app/src/modules/models/bench/index.tsx`
- Modify: `packages/app/src/modules/models/lmstudio/index.tsx`
- Modify: `packages/app/src/modules/models/server/index.tsx`

- [ ] **Step 1: Nodes Module**
  Apply `<StatusDot>`, `<Badge>`, and `<Button>`. Ensure empty states use `<EditorialHero>`.
- [ ] **Step 2: Models Sub-Modules**
  Go through all 6 sub-modules in `packages/app/src/modules/models/`. Apply the playbook. Pay special attention to any form inputs (`<Input>`, `<select>`).
- [ ] **Step 3: Typecheck and Smoke Test**
  `bun run --cwd packages/app typecheck`
- [ ] **Step 4: Commit**
  `refactor(app/models): adopt @/ui primitives across models and nodes`

---

## Task 3: Operations & Knowledge

**Files:**
- Modify: `packages/app/src/modules/workloads/list/index.tsx`
- Modify: `packages/app/src/modules/workloads/composites/index.tsx`
- Modify: `packages/app/src/modules/knowledge/retrieval/index.tsx`
- Modify: `packages/app/src/modules/knowledge/pipelines/index.tsx`

- [ ] **Step 1: Workloads List & Composites**
  Adopt `<StatusDot>` for workload phase, `<Badge>` for model names, and `<Button>`.
- [ ] **Step 2: Knowledge Retrieval & Pipelines**
  Adopt `<Badge>` for entity types, `<Input>` for local filtering, and `<Kbd>` for inline shortcuts.
- [ ] **Step 3: Typecheck and Smoke Test**
  `bun run --cwd packages/app typecheck`
- [ ] **Step 4: Commit**
  `refactor(app/ops): adopt @/ui primitives in workloads and knowledge`

---

## Task 4: Configuration (Settings)

**Files:**
- Modify: `packages/app/src/modules/settings/index.tsx`

- [ ] **Step 1: Settings Layout**
  Replace form inputs with `<Input>`, raw buttons with `<Button>`. Fix spacing and typography using inline styles and `var(--color-...)`.
- [ ] **Step 2: Typecheck and Smoke Test**
  `bun run --cwd packages/app typecheck`
- [ ] **Step 3: Commit**
  `refactor(app/settings): adopt @/ui primitives`

---

## Task 5: End-of-Phase Verification

- [ ] **Step 1: Typecheck**
  Run `bun run --cwd packages/app typecheck`. Must exit 0.
- [ ] **Step 2: Run all tests**
  Run `bun test --cwd packages/app`. Must be green.
- [ ] **Step 3: Visual Audit**
  Run `bun run --cwd packages/app dev`. Verify no visual regressions or broken layouts in the migrated tabs.
- [ ] **Step 4: Tag Release**
  `git tag beacon-p4-primitives`
