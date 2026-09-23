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
# The bench reads below were written assuming a live $DEV_STORAGE with
# tuned records on disk; a hermetic LLAMACTL_TEST_PROFILE boots with an
# empty runtime dir and is the one environment where they fail. Seed
# through the core write path first — the fixture script refuses to
# touch anything whose resolved runtime dir sits outside the profile,
# so live runs are unaffected.
seed_out="$(bun "$LLAMACTL_HOME/test/fixtures/seed-bench-profile.ts" 2>&1)"
seed_rc=$?
if [ "$seed_rc" -ne 0 ]; then
  fail "bench fixture seed (rc=$seed_rc)" "$seed_out"
fi
first_seeded="$(print "$seed_out" | sed -n 's/^SEEDED_REL=//p' | head -1)"
show_rel="$(print "$seed_out" | sed -n 's/^SHOW_REL=//p' | head -1)"
compare_rel="$(print "$seed_out" | sed -n 's/^COMPARE_REL=//p' | head -1)"
compare_profile="$(print "$seed_out" | sed -n 's/^COMPARE_PROFILE=//p' | head -1)"
seed_skip="$(print "$seed_out" | sed -n 's/^SKIP //p' | head -1)"

if [ "$seed_rc" -eq 0 ] && [ -n "$LLAMACTL_TEST_PROFILE" ] && [ -z "$seed_skip" ]; then
  # Inside a hermetic profile the fixture must either emit all four
  # markers or an explicit SKIP line — a silent no-op would drop every
  # content assertion below while the tier still reports fail=0. The
  # only deliberate skip reachable here is "runtime dir resolved outside
  # the profile" (a developer shell exporting LOCAL_AI_RUNTIME_DIR); the
  # marker guards below then skip the content assertions while the bare
  # bench rc0 checks keep exercising that real runtime dir.
  [ -n "$first_seeded" ] || fail "bench fixture seed: missing SEEDED_REL" "$seed_out"
  [ -n "$show_rel" ] || fail "bench fixture seed: missing SHOW_REL" "$seed_out"
  [ -n "$compare_rel" ] || fail "bench fixture seed: missing COMPARE_REL" "$seed_out"
  [ -n "$compare_profile" ] || fail "bench fixture seed: missing COMPARE_PROFILE" "$seed_out"
fi

expect_rc0 "bench show current" bun "$CLI" bench show current
expect_rc_nonzero "bench show bogus target" bun "$CLI" bench show bogus-target
expect_rc0 "bench history all" bun "$CLI" bench history all
expect_rc0 "bench compare all all" bun "$CLI" bench compare all all

if [ -n "$show_rel" ]; then
  expect_contains "bench show current prints the seeded rel" \
    "model=$show_rel" bun "$CLI" bench show current
fi
if [ -n "$first_seeded" ]; then
  expect_contains "bench history all lists the seeded rel" \
    "model=$first_seeded" bun "$CLI" bench history all
fi
if [ -n "$compare_rel" ]; then
  expect_contains "bench compare all all lists the seeded rel" \
    "model=$compare_rel" bun "$CLI" bench compare all all
  expect_contains "bench compare all all shows tuned profile" \
    "tuned=$compare_profile" bun "$CLI" bench compare all all
fi

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
# Deliberately NOT wrapped in a `( ... )` subshell — pass/fail increment
# PASS/FAIL, and a subshell would discard them, printing FAIL while the
# suite still exits 0. Restore PATH before asserting so later checks always
# inherit the caller's environment, including when the fallback probe fails.
path_before_missing_bun="$PATH"
export PATH="$(print "$PATH" | tr ':' '\n' | grep -v bun | paste -sd: -)"
out="$(llama-bench-show current 2>&1)"
rc=$?
export PATH="$path_before_missing_bun"
if [ "$rc" -ne 0 ] && [[ "$out" == *"llamactl CLI not available"* ]]; then
  pass "missing-bun fallback"
else
  fail "missing-bun fallback (rc=$rc)" "$out"
fi

# -------------------------------------------------------------------------
note "ctx envelope parity: _llama_ctx_for_model vs TypeScript ctxForModel"
# `ctx` is a component of a bench record's primary key, so a rel that routes
# to a different envelope in the shell path than in the TS path writes bench
# records under a key the other path never matches. Asserting the two agree
# (rather than asserting absolute sizes, which move with the env) keeps the
# parity claim in packages/core/src/ctx.ts self-auditing: adding a model
# family to one implementation and not the other fails here.
#
# Deliberately NOT wrapped in a `( ... )` subshell — pass/fail increment
# PASS/FAIL, and a subshell would discard them, printing FAIL while the
# suite still exits 0.
ctx_rels=(
  "Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf"
  "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"
  "Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf"
  "Qwen4-80B-A6B-GGUF/Qwen4-80B-A6B-UD-Q4_K_XL.gguf"
  "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
  "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
  # Fail-closed negatives: `Qwen` is not the LEADING segment, and the
  # on-disk dirs are capital-Q, so both must keep the Gemma envelope.
  "mlx-community/Qwen3-8B-MLX-4bit"
  "qwen3.8-27B-GGUF/qwen3.8-27B-Q4_K_M.gguf"
  "foo/bar-UD-Q4_K_XL.gguf"
)

ts_out="$(CTX_MOD="$LLAMACTL_HOME/packages/core/src/ctx.ts" \
  CTX_RELS="$(printf '%s\n' "${ctx_rels[@]}")" \
  bun -e 'const { ctxForModel } = await import(process.env.CTX_MOD);
    for (const r of process.env.CTX_RELS.split("\n").filter(Boolean)) console.log(ctxForModel(r));' 2>&1)"
ts_lines=("${(@f)ts_out}")

if [ "${#ts_lines[@]}" -ne "${#ctx_rels[@]}" ]; then
  fail "ctx parity: TypeScript side did not emit one ctx per rel" "$ts_out"
else
  for i in {1..${#ctx_rels[@]}}; do
    rel="${ctx_rels[$i]}"
    want="${ts_lines[$i]}"
    got="$(_llama_ctx_for_model "$rel")"
    if [ "$got" = "$want" ]; then
      pass "ctx parity: $rel -> $got"
    else
      fail "ctx parity: $rel (zsh=$got ts=$want)"
    fi
  done
fi

# -------------------------------------------------------------------------
note "summary"
print "pass=$PASS fail=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  print "\nfailures:"
  for f in "${FAILURES[@]}"; do print "  - $f"; done
  exit 1
fi
