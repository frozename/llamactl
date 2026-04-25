#!/usr/bin/env bash
# Tier A UI smoke. Builds the renderer, resolves electron-mcp, runs
# the module-loop harness + 6 shell smokes in sequence. Halts on
# first failure (set -e propagates the failing flow's exit code).
#
# Usage:
#   scripts/smoke-tier-a.sh                  # builds + runs everything
#   SKIP_BUILD=1 scripts/smoke-tier-a.sh     # reuses existing out/
#
# Env:
#   ELECTRON_MCP_DIR       Path to electron-mcp checkout (default:
#                          ~/DevStorage/repos/personal/electron-mcp).
#   LLAMACTL_TEST_PROFILE  Hermetic profile dir (default: a tmp dir).
#
# Exit codes:
#   0 — all smokes green
#   1 — build failed
#   2+ — first failing smoke's exit code
#
# See docs/superpowers/specs/2026-04-25-ui-e2e-smoke-design.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ELECTRON_MCP_DIR="${ELECTRON_MCP_DIR:-$HOME/DevStorage/repos/personal/electron-mcp}"
LLAMACTL_TEST_PROFILE="${LLAMACTL_TEST_PROFILE:-$(mktemp -d -t llamactl-tier-a)}"
export LLAMACTL_TEST_PROFILE
export ELECTRON_MCP_DIR

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "──── build ────"
  bun run --cwd packages/app build
fi

if [[ ! -d "$ELECTRON_MCP_DIR" ]]; then
  echo "ERROR: ELECTRON_MCP_DIR not found at $ELECTRON_MCP_DIR" >&2
  echo "Set ELECTRON_MCP_DIR to your electron-mcp checkout." >&2
  exit 1
fi

run() {
  echo
  echo "──── $1 ────"
  bun "$1"
}

run tests/ui-flows/tier-a-modules.ts
run tests/ui-flows/shell/theme-switch.ts
run tests/ui-flows/shell/command-palette.ts
run tests/ui-flows/shell/rail-views.ts
run tests/ui-flows/shell/tab-bar.ts
run tests/ui-flows/shell/dynamic-tabs.ts
run tests/ui-flows/shell/error-boundary.ts

echo
echo "Tier A: all green"
