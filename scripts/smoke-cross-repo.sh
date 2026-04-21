#!/usr/bin/env bash
# Cross-repo smoke harness. Runs the three sibling repos' unit/
# integration suites in the dependency order nova → sirius-gateway
# → embersynth → llamactl, plus llamactl's own cross-repo seam test
# (packages/remote/test/cross-repo-seam.test.ts) that pins the
# @nova/contracts shape.
#
# Exits non-zero at the first failing repo so the operator knows
# exactly which boundary broke. Each repo's test output streams to
# stdout unchanged.
#
# Usage:
#   scripts/smoke-cross-repo.sh
#
# Env (all optional — defaults assume the local layout at
# ~/DevStorage/repos/personal/<name>; CI sets them from the workspace):
#   NOVA_DIR         Path to the nova repo
#   SIRIUS_DIR       Path to the sirius-gateway repo
#   EMBERSYNTH_DIR   Path to the embersynth repo
#   SKIP_LLAMACTL    If set, skip the final llamactl suite (useful when
#                    already running under llamactl's own bun test)
#
# Exit codes:
#   0 — all four tiers green
#   1 — nova failed
#   2 — sirius-gateway failed
#   3 — embersynth failed
#   4 — llamactl (seam or full suite) failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

NOVA_DIR="${NOVA_DIR:-$HOME/DevStorage/repos/personal/nova}"
SIRIUS_DIR="${SIRIUS_DIR:-$HOME/DevStorage/repos/personal/sirius-gateway}"
EMBERSYNTH_DIR="${EMBERSYNTH_DIR:-$HOME/DevStorage/repos/personal/embersynth}"

banner() {
  printf '\n=============================================\n'
  printf '  %s\n' "$1"
  printf '=============================================\n'
}

run_tier() {
  local label="$1"
  local dir="$2"
  local code="$3"
  shift 3
  if [[ ! -d "$dir" ]]; then
    echo "ERROR: $label directory not found at $dir" >&2
    echo "  set ${label}_DIR or symlink it into place." >&2
    exit "$code"
  fi
  banner "$label — $*"
  if ! (cd "$dir" && "$@"); then
    echo "FAIL: $label failed in $dir" >&2
    exit "$code"
  fi
}

run_tier 'NOVA'       "$NOVA_DIR"       1 bun test
run_tier 'SIRIUS'     "$SIRIUS_DIR"     2 bun test
run_tier 'EMBERSYNTH' "$EMBERSYNTH_DIR" 3 bun test

if [[ -z "${SKIP_LLAMACTL:-}" ]]; then
  banner 'LLAMACTL — bun test (full suite, includes cross-repo seam)'
  if ! (cd "$REPO_ROOT" && bun test); then
    echo 'FAIL: llamactl test suite failed' >&2
    exit 4
  fi
fi

banner 'all four tiers green'
