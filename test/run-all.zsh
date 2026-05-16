#!/usr/bin/env zsh
# Top-level test runner. Walks every test tier in order from fastest to
# slowest; stops at the first tier that reports a failure so the next
# sessions don't burn time on downstream effects of a broken upstream.

setopt no_nomatch pipe_fail err_exit

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

print "\n=========================================="
print "  llamactl test suite"
print "=========================================="

print "\n[1/4] core unit + integration"
(cd packages/core && bun test)

print "\n[2/4] train static syntax"
(cd packages/train && bash scripts/check-syntax.sh)

print "\n[3/4] cli e2e"
(cd packages/cli && bun test)

print "\n[4/4] shell smoke (against live \$DEV_STORAGE)"
zsh "$ROOT/test/shell-smoke.zsh"

print "\n[5/5] multi-workload smoke"
zsh "$ROOT/test/multi-workload.zsh"

print "\n=========================================="
print "  all green"
print "=========================================="
