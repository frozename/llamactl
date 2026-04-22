#!/usr/bin/env bash
# UI-flows smoke runner. Builds the llamactl Electron bundle, resolves
# the electron-mcp-server entrypoint + Electron binary, and runs every
# script under tests/ui-flows/ that carries the Pipelines suite we
# shipped in R3 + the aliveness plan. Exits non-zero at the first
# failing flow so the operator knows exactly which one broke.
#
# Usage:
#   scripts/smoke-ui-flows.sh                 # builds + runs all flows
#   SKIP_BUILD=1 scripts/smoke-ui-flows.sh    # reuses existing out/ bundle
#   FLOWS='pipelines-tab-flow,pipelines-wizard-flow' scripts/smoke-ui-flows.sh
#       # comma-separated list of flow basenames (no suffix). Handy for
#       # iterating on a single flow.
#
# Env:
#   ELECTRON_MCP_DIR   Path to the electron-mcp-server checkout.
#                      Defaults to ~/DevStorage/repos/personal/electron-mcp-server.
#                      The workflow mirrors ui-audit.yml's conventions.
#   ELECTRON_BIN       Override the Electron binary path (default:
#                      packages/app/node_modules/electron/dist/Electron.app/…).
#   APP_DIR            Override the app dir passed as the Electron argv
#                      (default: packages/app).
#   FLOWS              Comma-separated subset of flow basenames.
#                      Default runs the full R3 + aliveness sweep.
#
# Exit codes:
#   0 — every selected flow passed its assertions
#   1 — build failed
#   2 — one or more flows failed (first failing flow's exit code is
#       propagated via `set -e`; downstream flows are skipped)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ELECTRON_MCP_DIR="${ELECTRON_MCP_DIR:-$HOME/DevStorage/repos/personal/electron-mcp-server}"
ELECTRON_BIN="${ELECTRON_BIN:-$REPO_ROOT/packages/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron}"
APP_DIR="${APP_DIR:-$REPO_ROOT/packages/app}"
# Full sweep. Intentionally ordered cheapest → most invasive so an
# early failure signals breakage before later flows mutate state.
DEFAULT_FLOWS=(
  pipelines-tab-flow
  pipelines-wizard-flow
  pipelines-apply-run-flow
  quality-tab-flow
  projects-tab-flow
  ops-chat-flow
  ops-chat-refusal-flow
  multi-node-flow
)

banner() {
  printf '\n=============================================\n'
  printf '  %s\n' "$1"
  printf '=============================================\n'
}

# Preflight.
if [[ ! -d "$ELECTRON_MCP_DIR" ]]; then
  echo "ERROR: ELECTRON_MCP_DIR not found at $ELECTRON_MCP_DIR" >&2
  echo "  set ELECTRON_MCP_DIR, or symlink an electron-mcp-server checkout there." >&2
  exit 1
fi
if [[ ! -f "$ELECTRON_MCP_DIR/dist/server/index.js" ]]; then
  echo "ERROR: electron-mcp-server is not built at $ELECTRON_MCP_DIR/dist/" >&2
  echo "  cd $ELECTRON_MCP_DIR && bun install && bun run build" >&2
  exit 1
fi
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "ERROR: Electron binary missing at $ELECTRON_BIN" >&2
  echo "  cd $APP_DIR && bun install   (installs the electron dev dep)" >&2
  exit 1
fi

# Build unless SKIP_BUILD.
if [[ -z "${SKIP_BUILD:-}" ]]; then
  banner 'llamactl Electron bundle — build'
  bun run --cwd "$APP_DIR" build
fi

# Resolve flow list.
if [[ -n "${FLOWS:-}" ]]; then
  # shellcheck disable=SC2207
  SELECTED=($(printf '%s' "$FLOWS" | tr ',' '\n' | sed '/^$/d'))
else
  SELECTED=("${DEFAULT_FLOWS[@]}")
fi

# Run each flow. ELECTRON_MCP_DIR is exported so each flow's
# resolveServerScript() picks it up without an explicit --env.
export ELECTRON_MCP_DIR

for flow in "${SELECTED[@]}"; do
  script="$REPO_ROOT/tests/ui-flows/${flow}.ts"
  if [[ ! -f "$script" ]]; then
    echo "ERROR: flow '$flow' not found at $script" >&2
    exit 2
  fi
  banner "flow — $flow"
  # Each flow uses its own process.exitCode for PASS/FAIL reporting;
  # bun propagates that as the shell exit status. `set -e` above
  # bails on the first non-zero.
  bun run "$script" \
    --executable="$ELECTRON_BIN" \
    --args="$APP_DIR"
done

banner 'all UI flows green'
