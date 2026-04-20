# UI regression gate

Pixel-diff gate for the Electron UI. Every PR and every push to `main`
renders the 16 top-level modules under a hermetic test profile, compares
each screenshot against the committed baselines at
`tests/ui-audit-baselines/`, and fails the build if any module drifts.

## What it checks

The driver (`ui-audit-driver-v2.ts` in
[electron-mcp-server](https://github.com/frozename/electron-mcp)) is
library-generic — it reads the module list from
[`tests/ui-audit-modules.json`](../tests/ui-audit-modules.json) (passed
via `--modules=<path>` from `scripts/audit.sh`) and walks each entry in
order. That file is the single source of truth for which modules the
audit covers — today, the 16 top-level activity-bar modules:

```
dashboard  nodes      chat       plan       ops-chat   cost
pipelines  workloads  models     presets    pulls      bench
server     logs       lmstudio   settings
```

Add a new module to the registry + this JSON file (and capture a
baseline PNG) in the same PR that introduces the feature.

Each screenshot is diffed against `tests/ui-audit-baselines/<module>.png`
via the `screenshot_diff` MCP tool. A module fails when:

- Any pixel differs by more than `pixelThreshold=0` (exact-match per-pixel), **AND**
- The ratio of differing pixels exceeds `threshold=0.01` (1% of the frame).

Both thresholds apply together — one stray pixel won't trip the gate,
but ~2% of the frame drifting will.

## Running locally

```sh
bun run audit          # diff against committed baselines; non-zero exit on breach
bun run audit:update   # reseed baselines from the current built UI
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

- `LLAMACTL_TEST_PROFILE=<tmpdir>` reroots every model path, runtime
  dir, and cache under one scratch prefix, and pins `LLAMA_CPP_PORT` to
  the sentinel `65534` so Logs/Server always show "offline" the same
  way. See [`AGENTS.md`](../AGENTS.md#test-profiles-for-hermetic-audits)
  for the full env table.
- A per-run `userDataDir` for Chromium so no extension, history, or
  saved window state leaks between runs.
- The electron-mcp-server driver is pinned to a specific commit SHA in
  [`.github/workflows/ui-audit.yml`](../.github/workflows/ui-audit.yml) —
  bump that pin explicitly when the driver changes.

Never seed baselines from a non-hermetic run. They'd bake whatever was
in your real storage into the repo forever.

## CI workflow

[`.github/workflows/ui-audit.yml`](../.github/workflows/ui-audit.yml)
runs mac-only today. Linux is tracked as a follow-up — viable with
Xvfb, but mac mirrors the primary operator's day-to-day and is the
sharpest signal right now.

On failure, the workflow uploads two artifacts:

- `ui-audit-diffs` — the per-module diff PNGs.
- `ui-audit-report` — the driver's `report.json` with pixel counts,
  ratios, console/network deltas, and the Playwright trace reference.

Both retain for 14 days.
