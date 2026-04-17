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

print "\n[1/3] core unit + integration"
(cd packages/core && bun test)

print "\n[2/3] cli e2e"
(cd packages/cli && bun test)

print "\n[3/3] shell smoke (against live \$DEV_STORAGE)"
zsh "$ROOT/test/shell-smoke.zsh"

print "\n=========================================="
print "  all green"
print "=========================================="
