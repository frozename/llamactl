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

# Hermetic workspace: fresh LLAMACTL_TEST_PROFILE prefix + a private
# Chromium userDataDir so parallel runs don't collide on the singleton
# lock.
PROFILE="$(mktemp -d -t llamactl-audit-profile.XXXXXX)"
USERDATA="$(mktemp -d -t llamactl-audit-userdata.XXXXXX)"

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
# pass; --modules=<json> supplies llamactl's 16-module activity bar
# (tests/ui-audit-modules.json) and --out-dir keeps the report landing
# at the llamactl-scoped path that docs/ui-audit.md + the CI workflow
# reference.
DRIVER_ARGS=(
  "--executable=$ELECTRON_BIN"
  "--args=$APP_DIR"
  "--env=LLAMACTL_TEST_PROFILE=$PROFILE"
  "--userDataDir=$USERDATA"
  "--modules=$MODULES_JSON"
  "--out-dir=$OUT_DIR"
  "--baselines=$BASELINES_DIR"
  "--diffDir=$DIFF_DIR"
  "--threshold=0.01"
  "--pixelThreshold=0"
)

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
