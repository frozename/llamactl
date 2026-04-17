#!/usr/bin/env zsh
# Shell smoke test for llamactl.
#
# Runs against the user's real $DEV_STORAGE + shell shims, not a hermetic
# temp dir — the purpose is to catch integration regressions between the
# zsh helpers and the TypeScript CLI they delegate to.
#
# Idempotent: restores any catalog / overrides it touches.
#
# Expected invariants:
#   - LLAMACTL_HOME points at the local llamactl checkout
#   - bun is on $PATH
#   - The user's shell has sourced shell/llamactl.zsh (via their dotfiles
#     or the equivalent snippet from llamactl's README)
#
# Exit 0 on green, 1 on the first unexpected failure. No `set -e` so we
# can batch many assertions and report a summary at the end.

setopt no_nomatch pipe_fail

PASS=0
FAIL=0
FAILURES=()

note() { print "\n--- $* ---"; }

pass() {
  PASS=$((PASS + 1))
  print "PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  print "FAIL: $1"
  [ -n "$2" ] && print "$2" | sed 's/^/    /'
}

expect_rc0() {
  local label="$1"; shift
  local out rc
  out="$("$@" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] && pass "$label" || fail "$label (rc=$rc)" "$out"
}

expect_rc_nonzero() {
  local label="$1"; shift
  local rc
  "$@" >/dev/null 2>&1
  rc=$?
  [ "$rc" -ne 0 ] && pass "$label (rc=$rc)" || fail "$label (expected non-zero, got 0)"
}

expect_contains() {
  local label="$1" needle="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label (rc=$rc, missing '$needle')" "$out"
  fi
}

# -------------------------------------------------------------------------
# Resolve LLAMACTL_HOME relative to this script so the suite can run
# standalone (CI, `bun run test:shell`, cron) without the caller having
# already sourced shell/env.zsh. If DEV_STORAGE isn't set, fall back to
# $HOME/.llamactl so the env module still produces sensible paths.
if [ -z "$LLAMACTL_HOME" ]; then
  export LLAMACTL_HOME="$(cd "$(dirname "$0")/.." && pwd)"
fi
if [ -z "$DEV_STORAGE" ]; then
  export DEV_STORAGE="${HOME}/.llamactl"
fi

# Source llamactl's own shell modules — this is what a real user's
# dotfiles would do via the snippet in the project README.
if [ -f "$LLAMACTL_HOME/shell/env.zsh" ]; then
  source "$LLAMACTL_HOME/shell/env.zsh"
fi
if [ -f "$LLAMACTL_HOME/shell/llamactl.zsh" ]; then
  source "$LLAMACTL_HOME/shell/llamactl.zsh"
fi

CLI="$LLAMACTL_HOME/packages/cli/src/bin.ts"
if [ ! -f "$CLI" ]; then
  print "llamactl CLI not found at $CLI" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  print "bun not on PATH — install bun or skip this suite" >&2
  exit 1
fi

# -------------------------------------------------------------------------
note "env"
expect_contains "env --eval exports LLAMA_CPP_MACHINE_PROFILE" \
  "export LLAMA_CPP_MACHINE_PROFILE" bun "$CLI" env --eval
expect_contains "env --json has OPENAI_BASE_URL" \
  "OPENAI_BASE_URL" bun "$CLI" env --json

# -------------------------------------------------------------------------
note "catalog reads"
expect_rc0 "catalog list default" bun "$CLI" catalog list
expect_contains "catalog list builtin has qwen36-q4m" \
  "qwen36-q4m" bun "$CLI" catalog list builtin
expect_contains "catalog list --json yields JSON" \
  '"rel":' bun "$CLI" catalog list --json
expect_rc_nonzero "catalog list bogus-scope" bun "$CLI" catalog list bogus-scope
expect_contains "catalog status builtin rel" \
  "class_source=catalog" bun "$CLI" catalog status \
  "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
expect_contains "catalog status fake rel -> pattern" \
  "class_source=pattern" bun "$CLI" catalog status "Fake-Model-GGUF/nothing.gguf"

# -------------------------------------------------------------------------
note "bench reads"
expect_rc0 "bench show current" bun "$CLI" bench show current
expect_rc_nonzero "bench show bogus target" bun "$CLI" bench show bogus-target
expect_rc0 "bench history all" bun "$CLI" bench history all
expect_rc0 "bench compare all all" bun "$CLI" bench compare all all

# -------------------------------------------------------------------------
note "recommendations"
expect_contains "recommendations current" "profile=" bun "$CLI" recommendations current
expect_contains "recommendations all has balanced" "profile=balanced" \
  bun "$CLI" recommendations all

# -------------------------------------------------------------------------
note "write round-trip (uses temp rel + cleans up)"
SMOKE_REPO="unsloth/smoke-$$-GGUF"
SMOKE_REL_BASE="smoke-$$-GGUF"
SMOKE_REL="$SMOKE_REL_BASE/smoke-$$-Q4.gguf"

expect_rc0 "smoke: catalog add" bun "$CLI" catalog add "$SMOKE_REPO" "smoke-$$-Q4.gguf" \
  "Smoke Test" custom general candidate
expect_rc_nonzero "smoke: duplicate catalog add fails" bun "$CLI" catalog add \
  "$SMOKE_REPO" "smoke-$$-Q4.gguf" "Smoke" custom general candidate
expect_contains "smoke: catalog status sees custom row" \
  "catalog=custom" bun "$CLI" catalog status "$SMOKE_REL"
expect_rc0 "smoke: promote on the fresh rel" bun "$CLI" catalog promote \
  balanced fast "$SMOKE_REL"
expect_contains "smoke: promotions list contains the rel" \
  "$SMOKE_REL" bun "$CLI" catalog promotions
expect_rc0 "smoke: uninstall --force removes everything" \
  bun "$CLI" uninstall "$SMOKE_REL" --force
expect_contains "smoke: catalog status after uninstall is 'none'" \
  "catalog=none" bun "$CLI" catalog status "$SMOKE_REL"

# -------------------------------------------------------------------------
note "shim fallback when bun is missing"
(
  PATH_BACKUP="$PATH"
  export PATH="$(print "$PATH" | tr ':' '\n' | grep -v bun | paste -sd: -)"
  out="$(llama-bench-show current 2>&1)"
  rc=$?
  export PATH="$PATH_BACKUP"
  if [ "$rc" -ne 0 ] && [[ "$out" == *"llamactl CLI not available"* ]]; then
    pass "missing-bun fallback"
  else
    fail "missing-bun fallback (rc=$rc)" "$out"
  fi
)

# -------------------------------------------------------------------------
note "summary"
print "pass=$PASS fail=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  print "\nfailures:"
  for f in "${FAILURES[@]}"; do print "  - $f"; done
  exit 1
fi
