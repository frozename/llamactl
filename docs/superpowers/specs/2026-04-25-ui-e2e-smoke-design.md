# UI E2E + smoke test suite — design

Status: approved 2026-04-25.

## Problem

The Beacon UI Renewal (P0–P3 + cleanup) is shipped. None of the new
shell-level surfaces (tab bar, rail views, dynamic tab routing,
command palette, theme switching) carry e2e coverage. The 13 flows in
`tests/ui-flows/` predate Beacon, target the retired IDELayout shell,
and are not gated in CI. `packages/app/test/` covers pure logic only
(stores, registry, dispatch, ranking, bucketing) — every activity-bar
module is otherwise untested. The single CI signal touching Electron
today is `.github/workflows/ui-audit.yml` (pixel regression of static
module screenshots), which deliberately does not exercise flows.

This design specifies a tiered UI test suite: a fast, broad Tier A
that blocks PRs; a deeper Tier B of bespoke flows that runs nightly
and on-demand; and a contracts-only Tier C that promotes the existing
`cross-repo-smoke.yml` to nightly.

## Goals

- Catch shell-level boot regressions (white screens, lazy-load
  failures, theme-token drift, error-boundary fallbacks) on every PR.
- Catch product-flow regressions (operator console tier approval,
  pipelines apply→run→remove, chat A/B compare, projects detail
  open/close, pipelines wizard validation) before they ship to a
  release tag.
- Catch cross-repo schema drift on a daily cadence without paying for
  it on every PR.
- Make adding a new module cost ~3 lines of test discipline (one
  required field on the registry entry).

## Non-goals

- Replacing `ui-audit.yml`'s pixel-regression gate. It stays as-is;
  it is a different signal.
- Driving real backends (sirius-gateway, embersynth, nova-backed
  dispatch) from CI. Tier C remains contracts-only. UI smokes run
  against `LLAMACTL_TEST_PROFILE=1`.
- Migrating off `electron-mcp-server` / `pilot-driver.ts`. Decision:
  keep building on this driver. Tooling improvements (locator
  helpers, retry, trace capture) flow upstream into electron-mcp,
  not into this repo.
- Repairing every existing flow. 8 of the 13 are deleted; 5 are
  repaired.

## Architecture

```
┌─ Tier A (PR-gated, ~90s, macos-latest) ───────────────────────┐
│  scripts/smoke-tier-a.sh                                       │
│    ├─ tests/ui-flows/tier-a-modules.ts                         │
│    │     palette loop over APP_MODULES + activity-bar nav      │
│    └─ tests/ui-flows/shell/                                    │
│          theme-switch.ts, command-palette.ts, rail-views.ts,   │
│          tab-bar.ts, dynamic-tabs.ts, error-boundary.ts        │
└────────────────────────────────────────────────────────────────┘

┌─ Tier B (nightly + manual, ~10 min, macos-latest) ─────────────┐
│  scripts/smoke-ui-flows.sh                                     │
│    ├─ tests/ui-flows/pipelines-apply-run-flow.ts (E2E backend) │
│    ├─ tests/ui-flows/ops-chat-flow.ts                          │
│    ├─ tests/ui-flows/chat-compare-flow.ts                      │
│    ├─ tests/ui-flows/pipelines-wizard-flow.ts                  │
│    └─ tests/ui-flows/projects-tab-flow.ts                      │
└────────────────────────────────────────────────────────────────┘

┌─ Tier C (nightly + manual, macos-latest, existing) ────────────┐
│  scripts/smoke-cross-repo.sh                                   │
│    contracts/schema-drift across llamactl + sirius-gateway +   │
│    embersynth (existing workflow, unchanged body, retriggered) │
└────────────────────────────────────────────────────────────────┘
```

All three tiers share the existing `electron-mcp-server` / `pilot-driver.ts`
JSON-RPC primitives where applicable.

## Schema change — `AppModule`

Add one required field to `packages/app/src/modules/registry.ts`:

```ts
export interface AppModule {
  // ... existing fields

  /** Tier-A smoke: a `data-testid` selector that proves the module
   *  mounted correctly. The smoke harness asserts this element is
   *  visible after navigating to the module. Required for every
   *  module that ships in the activity bar or palette. */
  smokeAffordance: string;
}
```

The field is required — type-checking enforces that any new module
declares its smoke affordance. Existing 21 entries each get a value.
Pattern: prefer the most stable, always-rendered element on the
module's main view (a container `data-testid` like `settings-root` /
`cost-tier` is preferred over a conditionally-rendered child).
Modules that already carry stable testids on main affordances
(`settings`, `cost`, parts of `ops-chat`, `projects`) reuse them; the
rest gain a testid as part of Phase 1.

## Tier A — module-loop harness

File: `tests/ui-flows/tier-a-modules.ts`. Two passes, both halt-on-
first-failure.

**Pass 1 — palette navigation loop:**

```
for each m in APP_MODULES:
    open command palette (Cmd+Shift+P)
    type m.labelKey
    Enter
    wait for [data-testid=m.smokeAffordance], timeout 5s
    assert no console errors since iteration start
    assert no [data-testid="beacon-error-boundary"] present
    close active tab
```

The palette reaches every registered module — activity-bar (10) plus
palette-only (11) — through one navigation primitive. ~21 iterations
× ~3s = ~63s.

**Pass 2 — activity-bar navigation:**

```
for each m in APP_MODULES where m.activityBar === true:
    click activity-bar icon for m
    assert useTabStore.activeKey === `module:${m.id}`
```

Tests the activity-bar onClick handler explicitly (separate code
path from `shell/commands.ts`). Covers both `position: 'top'` (8
modules) and `position: 'bottom'` (2 modules). ~10 iterations × ~1s
= ~10s.

**Per-iteration isolation.** Between iterations: close all tabs,
clear closed-tab LRU, reset to a known shell state. An earlier
module's leakage cannot taint later assertions.

**Failure output.** First failure emits
`{ moduleId, affordance, lastConsoleErrors[], screenshotPath }` to
stdout and exits non-zero. Halt-on-first-failure: a broken module
usually means the bundle is broken, and downstream modules will
cascade-fail.

**Profile.** `LLAMACTL_TEST_PROFILE=1`. tRPC calls hit stubbed
responses; no real daemon required. The smokes assert mount
correctness, not data correctness.

## Tier A — shell smokes

Six files under `tests/ui-flows/shell/`, each a hand-written flow on
top of `pilot-driver.ts`:

| File | Asserts |
|---|---|
| `theme-switch.ts` | Cycle all four themes via `ThemeOrbs`; `[data-theme]` on `<html>` flips and persists across reload (`localStorage` key `beacon-theme`, version 2). |
| `command-palette.ts` | `Cmd+Shift+P` opens; type "log" filters; `Enter` opens Logs; `Esc` closes without opening a tab. |
| `rail-views.ts` | Click each rail icon (Explorer, Search, Sessions, Fleet, Tokens); the matching panel becomes visible and the previous becomes hidden. No pixel checks. |
| `tab-bar.ts` | Open 3 modules → reorder via drag → close middle tab → `activeKey` falls back right then left. Pin a tab → close-others → pinned survives. |
| `dynamic-tabs.ts` | Programmatically `useTabStore.open({ kind: 'workload', instanceId: 'wl-fixture' })`; assert `WorkloadDetail` renders. Same for `node` and `ops-session`. Requires fixture data via the test profile (see Open questions). |
| `error-boundary.ts` | After all other Tier A passes, sweep the DOM: no `[data-testid="beacon-error-boundary"]` anywhere. Belt-and-suspenders against the per-module assertion. |

Estimated total Tier A runtime: **~90 seconds**, plus checkout +
build (~3 minutes wall-clock per PR).

## Tier B — triage + repair

Existing `tests/ui-flows/` content: 13 flow files plus
`pilot-driver.ts` plus `README.md`.

**Delete (8):** `beacon-p0-verify.ts`, `pipelines-tab-flow.ts`,
`quality-tab-flow.ts`, `plan-chat-flow.ts`, `ops-chat-refusal-flow.ts`,
`multi-node-flow.ts`, `cloud-rag-flow.ts`. Bundled walks inside
`pilot-driver.ts` are peeled out (or dropped); `pilot-driver.ts`
itself stays as the driver primitive.

**Keep + repair (5):**

| Flow | Repair scope |
|---|---|
| `pipelines-apply-run-flow.ts` | Update navigation to palette/activity-bar; verify `data-testid` selectors against current code. |
| `ops-chat-flow.ts` | Same — navigation + selectors. |
| `chat-compare-flow.ts` | Same. |
| `pipelines-wizard-flow.ts` | Same. |
| `projects-tab-flow.ts` | Same; specifically validate the EditorialHero empty-state landed in P3. |

Each repair is one commit. Estimated 30–60 minutes per flow.

**Cadence.** All 5 run via `scripts/smoke-ui-flows.sh` exactly as
today. Triggered by `ui-flows-nightly.yml` cron + `workflow_dispatch`.
Failures post an issue or notify; do not block PRs.

## Tier C — contracts only

`.github/workflows/cross-repo-smoke.yml` body is unchanged: still
checks out llamactl + sibling repos (nova, sirius-gateway, embersynth)
and runs `scripts/smoke-cross-repo.sh` to detect schema drift in
`@nova/contracts`.

Trigger changes from `on: [push, pull_request]` to:

```yaml
on:
  schedule: [{ cron: '0 9 * * *' }]
  workflow_dispatch:
```

Cost reduction: this workflow currently runs on every PR; nightly
brings it to ~1 run/day plus manual triggers.

## CI workflow inventory

| Workflow | Trigger | Blocks merge? |
|---|---|---|
| `ui-tier-a.yml` (new) | PR + push to main | yes |
| `ui-flows-nightly.yml` (new) | nightly cron + manual | no (advisory) |
| `cross-repo-smoke.yml` (existing, retriggered) | nightly cron + manual | no (advisory) |
| `ui-audit.yml` (existing, untouched) | as-is | as-is |

`ui-tier-a.yml` is the only new merge-blocking check. Tier A runs on
`macos-latest` because Electron requires a GUI environment. Cost is
roughly ~10x a Linux runner per minute of wall-clock; the ~3-minute
runtime budget keeps this manageable.

## Phasing

Three sequential phases. Each phase ends green; the next phase
begins from a clean tree.

**Phase 1 — Tier A foundation (~1.5 days).**
Add `smokeAffordance` to `AppModule`. Audit every entry in
`APP_MODULES`; pick or add a stable `data-testid` per module. Build
the harness (`tests/ui-flows/tier-a-modules.ts` + 6 shell smokes +
`scripts/smoke-tier-a.sh`). Wire `.github/workflows/ui-tier-a.yml`.
Verify locally and in CI. Commit per logical unit.

**Phase 2 — Tier B triage + repair (~0.5–1 day).**
Delete the 8 stale flows in one commit. Repair the 5 keepers, one
commit per flow. Wire `.github/workflows/ui-flows-nightly.yml`.
Verify the nightly workflow once via `workflow_dispatch`.

**Phase 3 — Tier C cadence (~10 minutes).**
Edit `cross-repo-smoke.yml` triggers from PR/push to cron + manual.
One commit. Verify with `workflow_dispatch`.

## Open questions / risks

1. **Dynamic-tab fixtures.** `dynamic-tabs.ts` (Tier A shell smoke)
   needs a workload, a node, and an ops-session in the test profile.
   `LLAMACTL_TEST_PROFILE` today does not provide these. Options:
   (a) extend the profile to seed fixtures (small change in
   `packages/core/test-profile/` if it exists, or wherever the
   profile is defined); (b) drop `dynamic-tabs.ts` from Tier A and
   move it to Tier B against a real backend. Lean: (a) — keep Tier A
   self-contained.

2. **macOS runner cost.** Tier A runs on `macos-latest`, ~10x Linux
   minute cost. ~3-minute wall-clock per PR is the budget. If the
   real number trends >5 minutes after Phase 1, revisit by either
   parallelizing the module loop (workers per module group) or
   moving to a self-hosted Mac runner.

3. **Activity-bar drag interactions.** `tab-bar.ts` asserts drag-to-
   reorder. `electron-mcp-server`'s mouse-event support is
   sufficient for this today; if drag tests turn out to be flaky in
   CI, fall back to programmatic `useTabStore.move` and assert the
   resulting state, accepting that the drag handler itself is no
   longer covered by Tier A.

4. **Halt-on-first-failure vs collect-all.** Phase 1 ships
   halt-on-first-failure. If failed-PR diagnostics turn out to want
   "show me every broken module at once", revisit. Not worth
   pre-engineering.

## Out of scope

- Pixel-regression integration with Tier A. `ui-audit.yml` stays
  separate.
- Real-backend cross-repo UI flows. If desired later, ship as a
  separate design.
- Visual smoke for the primitives sandbox (`/UIPrimitives`). The
  sandbox is design-tooling, not a product surface.
- Replacing `electron-mcp-server` / `pilot-driver.ts`. Strategic
  decision: keep building on it.
