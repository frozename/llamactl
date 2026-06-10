#!/usr/bin/env bash
# Hermetic UI-regression gate runner.
#
# MODE=diff  (default) — compare each module's screenshot against the
#                        committed baseline at tests/ui-audit-baselines/
#                        and exit non-zero if any breaches the threshold.
# MODE=update           — reseed the committed baselines from the current
#                        built UI. Use after intentional UI changes.
#
# Usage:
#   scripts/audit.sh [diff|update]
#
# Env:
#   ELECTRON_MCP_DIR   Path to the electron-mcp-server checkout (the
#                      driver + MCP server live there). Defaults to
#                      ../electron-mcp-server relative to the repo root.
#                      In CI the workflow clones the repo and sets this.
#
# Exit codes (from tests/ui-audit-driver-v2.ts):
#   0 — all modules match (diff mode) OR baselines reseeded (update mode)
#   1 — at least one module breached the pixel threshold
#   2 — driver/setup error

set -euo pipefail

MODE="${1:-diff}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINES_DIR="$REPO_ROOT/tests/ui-audit-baselines"
MODULES_JSON="$REPO_ROOT/tests/ui-audit-modules.json"
DIFF_DIR="$REPO_ROOT/.audit-diffs"
# Preserved path so docs/ui-audit.md references and the CI workflow's
# artifact pickup (/tmp/llamactl-ui-audit-v2/report.json) stay valid.
OUT_DIR="/tmp/llamactl-ui-audit-v2"

# Hermetic workspace: a FIXED LLAMACTL_TEST_PROFILE prefix + a private
# Chromium userDataDir. Fixed (not mktemp) because the Settings module
# renders the resolved paths verbatim — a random profile path bakes a
# different string into every run and the baseline can never match CI.
# /tmp resolves identically on macOS dev machines and CI runners.
# Trade-off: concurrent audit runs on one machine would collide; the CI
# workflow's concurrency group and single-operator local use make that
# acceptable.
PROFILE="/tmp/llamactl-audit-profile"
USERDATA="/tmp/llamactl-audit-userdata"
rm -rf "$PROFILE" "$USERDATA"
mkdir -p "$PROFILE" "$USERDATA"

rm -rf "$DIFF_DIR"
mkdir -p "$DIFF_DIR"

# ---- Build the Electron app ------------------------------------------------
# `bun install` at the repo root already installed the workspace deps;
# build emits to packages/app/out (main/index.cjs + preload + renderer).
cd "$REPO_ROOT/packages/app"
bun run build

ELECTRON_BIN="$REPO_ROOT/packages/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron binary not found at $ELECTRON_BIN" >&2
  echo "Run \`bun install\` at the repo root first." >&2
  exit 2
fi

# Electron resolves the app from the dir that holds the `package.json`
# with the `"main"` entry ("./out/main/index.cjs"), not the build output
# dir directly. Pointing it at `out/` loads Electron's default_app.
APP_DIR="$REPO_ROOT/packages/app"
if [ ! -f "$APP_DIR/out/main/index.cjs" ]; then
  echo "Built Electron main not found at $APP_DIR/out/main/index.cjs" >&2
  echo "Build step produced unexpected output." >&2
  exit 2
fi

# ---- Locate the driver -----------------------------------------------------
DRIVER_DIR="${ELECTRON_MCP_DIR:-$REPO_ROOT/../electron-mcp-server}"
if [ ! -d "$DRIVER_DIR" ]; then
  echo "electron-mcp-server not found at $DRIVER_DIR" >&2
  echo "Set ELECTRON_MCP_DIR or place a checkout alongside the llamactl repo." >&2
  exit 2
fi

cd "$DRIVER_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
# The driver spawns the MCP server from ../dist/server/index.js, so a
# fresh checkout needs a build.
if [ ! -f "$DRIVER_DIR/dist/server/index.js" ]; then
  bun run build
fi

# ---- Invoke the driver -----------------------------------------------------
# Threshold: 1% pixel ratio, 0 per-pixel delta. Tight. If false positives
# cascade, loosen here before reseeding.
#
# The driver is library-generic as of the electron-mcp genericization
# pass; --modules=<json> supplies llamactl's 22 registry modules
# (tests/ui-audit-modules.json, regenerated from APP_MODULES — the drift
# test in packages/app keeps it honest) and --out-dir keeps the report
# landing at the llamactl-scoped path that docs/ui-audit.md + the CI
# workflow reference.
#
# --force-device-scale-factor=1 pins Chromium to 1× so screenshots have
# identical geometry on Retina dev machines and CI runners — without it
# baselines seeded locally are 2× the size CI produces and every diff
# fails on dimensions alone.
#
# Navigation: the shell has no per-module aria-label buttons (rail +
# tabs), so --nav-script opens each module via the test-only
# window.useTabStore handle (same primitive as tier-a-modules.ts) and
# --setup-script dismisses the FirstRunTip overlay that a fresh hermetic
# userDataDir always shows.
# LLAMACTL_WINDOW_SIZE pins the BrowserWindow to 1024x640 — small enough
# to fit the CI runner's virtual display (~1024x681 usable; macOS clamps
# larger windows, failing every baseline on dimensions) while satisfying
# the app's 920x600 minimum.
# DEV_STORAGE must be pinned explicitly: the resolver's priority is
# individual env var > test-profile default, so a dev shell's exported
# DEV_STORAGE (real cluster config, catalog, workloads) would otherwise
# leak into the launched app and bake live fleet state into baselines —
# state CI doesn't have.
#
# The same leak applies to EVERY ResolvedEnv key: a dev shell that ran
# `eval "$(llamactl env --eval)"` exports them all individually, and
# each one beats the test-profile default. Blank them for the launched
# app (resolveEnv treats empty as unset) so the hermetic profile
# decides every rendered path/value — Settings, Catalog `installed`
# flags, Server/Logs endpoints all derive from these.
# LLAMA_CPP_MACHINE_PROFILE is PINNED rather than blanked: its fallback
# sniffs hardware memory, and a 48 GiB dev machine vs a CI runner would
# render different profile names + ctx defaults in Settings.
HERMETIC_BLANK_VARS=(
  HF_HOME HUGGINGFACE_HUB_CACHE OLLAMA_MODELS
  LLAMA_CPP_SRC LLAMA_CPP_BIN LLAMA_CPP_ROOT LLAMA_CPP_MODELS
  LLAMA_CPP_CACHE LLAMA_CPP_LOGS LLAMA_CPP_HOST LLAMA_CPP_PORT
  LLAMA_CPP_ADVERTISED_HOST LLAMA_CPP_GEMMA_CTX_SIZE
  LLAMA_CPP_QWEN_CTX_SIZE LLAMA_CPP_DEFAULT_MODEL
  LLAMA_CPP_SERVER_ALIAS LLAMA_CACHE
  LLAMA_CPP_KEEP_ALIVE_INTERVAL LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF
  LLAMA_CPP_AUTO_TUNE_ON_PULL LLAMA_CPP_AUTO_BENCH_VISION
  LOCAL_AI_LMSTUDIO_HOST LOCAL_AI_LMSTUDIO_PORT
  LOCAL_AI_LMSTUDIO_BASE_URL LOCAL_AI_LLAMA_CPP_BASE_URL
  LOCAL_AI_RUNTIME_DIR LOCAL_AI_ENABLE_THINKING
  LOCAL_AI_PRESERVE_THINKING LOCAL_AI_RECOMMENDATIONS_SOURCE
  LOCAL_AI_HF_CACHE_TTL_SECONDS LOCAL_AI_DISCOVERY_AUTHOR
  LOCAL_AI_DISCOVERY_LIMIT LOCAL_AI_DISCOVERY_SEARCH
  LOCAL_AI_CUSTOM_CATALOG_FILE LOCAL_AI_PRESET_OVERRIDES_FILE
  LOCAL_AI_BENCH_IMAGE LOCAL_AI_SOURCE_MODEL LOCAL_AI_PROVIDER
  LOCAL_AI_CONTEXT_LENGTH LOCAL_AI_PROVIDER_URL LOCAL_AI_API_KEY
  LOCAL_AI_MODEL OPENAI_BASE_URL OPENAI_API_KEY
  DEV_STORAGE_FALLBACK DEV_STORAGE_MODE DEV_STORAGE_REPAIR_BACKUP
  LLAMACTL_CONFIG
)
DRIVER_ARGS=(
  "--executable=$ELECTRON_BIN"
  "--args=$APP_DIR --force-device-scale-factor=1 --force-color-profile=srgb"
  "--env=LLAMACTL_TEST_PROFILE=$PROFILE"
  "--env=DEV_STORAGE=$PROFILE"
  "--env=LLAMACTL_WINDOW_SIZE=1024x640"
  "--env=LLAMA_CPP_MACHINE_PROFILE=balanced"
  "--userDataDir=$USERDATA"
  "--modules=$MODULES_JSON"
  "--nav-script=$REPO_ROOT/tests/ui-audit-nav.js.tpl"
  "--setup-script=$REPO_ROOT/tests/ui-audit-setup.js"
  "--out-dir=$OUT_DIR"
  "--baselines=$BASELINES_DIR"
  "--diffDir=$DIFF_DIR"
  "--threshold=0.01"
  "--pixelThreshold=0"
)
for var in "${HERMETIC_BLANK_VARS[@]}"; do
  DRIVER_ARGS+=("--env=$var=")
done

case "$MODE" in
  diff)
    bun run tests/ui-audit-driver-v2.ts "${DRIVER_ARGS[@]}"
    ;;
  update)
    bun run tests/ui-audit-driver-v2.ts "${DRIVER_ARGS[@]}" --updateBaselines
    ;;
  *)
    echo "Usage: $0 [diff|update]" >&2
    exit 2
    ;;
esac
