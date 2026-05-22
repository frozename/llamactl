#!/bin/bash
# Compile llamactl-agent as a single-file bun binary and stage it in
# the user's $HOME (TCC-friendly location). Optionally registers a
# nohup-spawned login item that survives reboots.
#
# Why this script exists
# ======================
# macOS TCC blocks launchd-context processes from reading external
# APFS volumes (e.g. /Volumes/AI-DATA, /Volumes/AI-MODELS) until the
# user grants Full Disk Access via System Settings. A launchd-spawned
# `bun packages/cli/src/bin.ts agent serve` from /Volumes/AI-DATA
# hangs at `openat$NOCANCEL` during module loading, the agent never
# binds its TCP port, and applies time out at 180s.
#
# Compiling to a single-file binary in $HOME bypasses the import-time
# /Volumes traversal — but the agent still needs /Volumes access at
# runtime when its env points DEV_STORAGE / LLAMA_CPP_MODELS at
# /Volumes/*. So the canonical fix on a mac mini with external-volume
# storage is:
#
# 1. Compile this binary (this script).
# 2. Grant Full Disk Access to the compiled binary via:
#    System Settings → Privacy & Security → Full Disk Access → + →
#    add /Users/<you>/.local/bin/llamactl-agent → toggle ON.
# 3. Restart the agent via launchd (kickstart) — it'll start cleanly.
#
# If step 2 isn't possible (CI / headless / no UI access), this script
# also supports a nohup-spawned fallback that inherits the user's Aqua
# session TCC: `--nohup` will spawn the compiled binary detached, with
# the full env. Persistence across reboots is the user's problem in
# that case (Login Item or manual re-run after boot).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${HOME}/.local/bin/llamactl-agent"

mkdir -p "$(dirname "$OUT")"

echo "[install-agent] compiling from $REPO_ROOT/packages/cli/src/bin.ts"
echo "[install-agent] output: $OUT"

bun build --compile --target=bun-darwin-arm64 \
  "$REPO_ROOT/packages/cli/src/bin.ts" \
  --outfile "$OUT"

echo "[install-agent] built. Size:"
ls -lh "$OUT"

cat <<EOF

[install-agent] NEXT STEPS (one-time):

  1. Grant Full Disk Access to the compiled binary so launchd can
     access /Volumes/* at runtime:

       System Settings → Privacy & Security → Full Disk Access →
       click + → navigate to:
       $OUT
       → toggle ON.

  2. Update your com.llamactl.agent.plist to invoke the compiled
     binary instead of running bun against the .ts source. Replace
     ProgramArguments with:

       <key>ProgramArguments</key>
       <array>
         <string>$OUT</string>
         <string>agent</string>
         <string>serve</string>
         <string>--dir=$HOME/.llamactl-agent</string>
       </array>

  3. Reload the LaunchAgent:

       launchctl bootout gui/\$(id -u)/com.llamactl.agent || true
       launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.llamactl.agent.plist

If you can't grant Full Disk Access (CI/headless), spawn via nohup
from a user-session shell instead:

  nohup $OUT agent serve --dir=$HOME/.llamactl-agent \\
    > $HOME/.llamactl-launchd-logs/stdout.log \\
    2> $HOME/.llamactl-launchd-logs/stderr.log \\
    < /dev/null &
  disown

The nohup'd binary inherits your Aqua session TCC and works without
Full Disk Access on the launchd domain, but doesn't persist across
reboots unless you wire it into a LoginItem.
EOF
