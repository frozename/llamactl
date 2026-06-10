# UI regression gate

Pixel-diff gate for the Electron UI. Every PR and every push to `main`
renders all 22 registry modules under a hermetic test profile, compares
each screenshot against the committed baselines at
`tests/ui-audit-baselines/`, and fails the build if any module drifts.

## What it checks

The driver (`ui-audit-driver-v2.ts` in
[electron-mcp-server](https://github.com/frozename/electron-mcp)) is
library-generic — it reads the module list from
[`tests/ui-audit-modules.json`](../tests/ui-audit-modules.json) (passed
via `--modules=<path>` from `scripts/audit.sh`) and walks each entry in
order. That file mirrors `APP_MODULES` in
`packages/app/src/modules/registry.ts` — all 22 modules, in registry
order, as `{ id, label, rootTestId? }` entries (`rootTestId` carries the
registry's `smokeAffordance` whenever it differs from the driver's
`<id>-root` derivation, e.g. `models.bench` → `models-bench-root`). The
drift test `packages/app/test/ui-audit-modules-drift.test.ts` fails the
unit suite if the JSON and the registry ever diverge; its header comment
has the one-liner to regenerate the file.

Navigation and setup are app-supplied scripts (the Beacon shell has no
per-module aria-label buttons):

- [`tests/ui-audit-nav.js.tpl`](../tests/ui-audit-nav.js.tpl) — passed
  via `--nav-script`; opens each module through the test-only
  `window.useTabStore` handle, the same primitive Tier A uses.
- [`tests/ui-audit-setup.js`](../tests/ui-audit-setup.js) — passed via
  `--setup-script`; dismisses the FirstRunTip onboarding overlay that a
  fresh hermetic `userDataDir` always shows (it would otherwise sit on
  top of every screenshot).

Add a new module to the registry + this JSON file (and capture a
baseline PNG) in the same PR that introduces the feature.

Each screenshot is diffed against `tests/ui-audit-baselines/<module-id>.png`
via the `screenshot_diff` MCP tool. A module fails when:

- Any pixel differs by more than `pixelThreshold=0` (exact-match per-pixel), **AND**
- The ratio of differing pixels exceeds `threshold=0.01` (1% of the frame).

Both thresholds apply together — one stray pixel won't trip the gate,
but ~2% of the frame drifting will.

## Running locally

```sh
bun run audit             # diff against committed baselines; non-zero exit on breach
bun run audit:update      # reseed baselines from the current built UI
bun run audit:functional  # render every module and gate on console/network health
```

The runner (`scripts/audit.sh`) handles everything:

1. Builds `packages/app` (electron-vite).
2. Creates a throwaway `LLAMACTL_TEST_PROFILE` + a private Chromium
   `userDataDir` — so the audit can't bleed into your real `$DEV_STORAGE`
   and parallel runs can't collide on Chromium's singleton lock.
3. Spawns the driver under `$ELECTRON_MCP_DIR` (defaults to
   `../electron-mcp-server`; set the env var if your checkout lives
   elsewhere).
4. Writes diff PNGs to `.audit-diffs/` on failure.

## Handling a failing audit

1. **Pull the diff artifacts.** In CI the workflow uploads
   `llamactl/.audit-diffs/` as the `ui-audit-diffs` artifact. Download
   and open the PNGs — they show the baseline, the current capture, and
   the highlighted differences side-by-side.
2. **Decide if the change is intentional.** Two possibilities:
   - **Unintentional drift** — a component picked up a style regression,
     a stray console warning is rendering, theme tokens shifted. Fix
     the regression and re-run the audit locally.
   - **Intentional change** — you shipped a UI update that the
     baselines haven't caught up with yet. Reseed:
     ```sh
     bun run audit:update
     git add tests/ui-audit-baselines/
     git commit -m "ui: reseed audit baselines"
     ```
     Commit the new baselines alongside the UI change in the same PR
     so reviewers can see both in one diff.
3. **Re-run the audit** (`bun run audit`). Expect exit 0.

## Threshold tuning

Current defaults (`scripts/audit.sh`):

```
--threshold=0.01       # 1% of total pixels
--pixelThreshold=0     # exact-match per-pixel
```

These are tight. If flakiness cascades from font antialiasing,
subpixel rendering differences between macOS versions, or GPU raster
variation, loosen `pixelThreshold` first (values 1–10 tolerate minor
noise without letting real regressions through). Resist raising
`threshold` above 0.05 — beyond that the gate loses signal.

Any threshold change is a deliberate act; prefer reseeding over loosening
when a known-good UI has drifted.

## Hermetic guarantees

The gate is only trustworthy if the state is reproducible. Three
invariants keep it hermetic:

- `LLAMACTL_TEST_PROFILE=/tmp/llamactl-audit-profile` reroots every
  model path, runtime dir, and cache under one scratch prefix, and pins
  `LLAMA_CPP_PORT` to the sentinel `65534` so Logs/Server always show
  "offline" the same way. The prefix is a FIXED path (not mktemp): the
  Settings module renders the resolved paths verbatim, so a random
  profile path bakes a different string into every run and the baseline
  can never match CI. See
  [`AGENTS.md`](../AGENTS.md#test-profiles-for-hermetic-audits) for the
  full env table.
- The git-repo quick-pick scan in the Projects module expands `~`
  against `LLAMACTL_TEST_PROFILE` (not `$HOME`) when the profile is set,
  so the operator's real repos never render into baselines.
- A per-run `userDataDir` for Chromium so no extension, history, or
  saved window state leaks between runs.
- `--force-device-scale-factor=1` pins Chromium to 1× rendering, so
  baselines seeded on a Retina dev machine (2× by default) have the
  same pixel geometry CI produces. Without it every diff fails on
  dimensions alone.
- `LLAMACTL_WINDOW_SIZE=1024x640` pins the BrowserWindow itself. The CI
  runner's virtual display is smaller than the app's 1280×800 default
  and macOS silently clamps the window to the visible area (~1024×681),
  which also fails every baseline on dimensions. 1024×640 fits the
  runner while satisfying the app's 920×600 minimum.
- `DEV_STORAGE=$PROFILE` is pinned explicitly, and EVERY other
  ResolvedEnv key is blanked for the launched app. The resolver's
  priority is individual env var > test-profile default, and a dev
  shell that ran `eval "$(llamactl env --eval)"` exports them all
  individually — `LLAMA_CPP_MODELS` (Catalog `installed` flags),
  `LOCAL_AI_RUNTIME_DIR` (custom catalog entries), `LLAMA_CPP_HOST` /
  `PORT` (live server state), and the rest would otherwise leak real
  machine state into baselines — state CI doesn't have. `resolveEnv`
  treats empty as unset, so blanking falls through to the test-profile
  defaults. `LLAMA_CPP_MACHINE_PROFILE` is pinned to `balanced` rather
  than blanked: its fallback sniffs hardware memory, and a 48 GiB dev
  machine vs a CI runner would render different profile names and ctx
  defaults in Settings.
- The electron-mcp-server driver is pinned to a specific commit SHA in
  [`.github/workflows/ui-audit.yml`](../.github/workflows/ui-audit.yml) —
  bump that pin explicitly when the driver changes.

Never seed baselines from a non-hermetic run. They'd bake whatever was
in your real storage into the repo forever.

## CI workflow

[`.github/workflows/ui-audit.yml`](../.github/workflows/ui-audit.yml)
runs two jobs:

- `audit` on `macos-latest` is the pixel-regression gate. It compares
  screenshots against `tests/ui-audit-baselines/` and uploads diff
  artifacts when the gate fails.
- `functional-linux` on `ubuntu-latest` runs the same module navigation
  suite under Xvfb, but does **not** pass `--baselines` to the driver.
  It gates only on functional signals from the report: the app boots,
  all 22 modules render, navigation reports success, the renderer
  console is clean, and no failed network requests are captured.

Linux pixel baselines remain a future follow-up. Do not generate,
commit, or compare Linux baselines until a separate hermetic Linux
seeding process has been reviewed.

On mac pixel-gate failure, the workflow uploads:

- `ui-audit-diffs` — the per-module diff PNGs.
- `ui-audit-report` — the driver's `report.json` with pixel counts,
  ratios, console/network deltas, and the Playwright trace reference.

On Linux functional failure, the workflow uploads:

- `ui-audit-linux-report` — the driver's `report.json`.
- `ui-audit-linux-screenshots` — screenshots and trace output from the
  functional run.

Both retain for 14 days.
