#!/bin/bash
# Compile llamactl-agent as a single-file bun binary, stamped with the
# source commit, dirty flag and build time (#743), and stage it in the
# user's $HOME (TCC-friendly location). A dirty tree is refused unless
# --allow-dirty is passed. Optionally registers a nohup-spawned login
# item that survives reboots.
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

usage() {
  cat <<EOF
Usage: $0 [--allow-dirty] [-h|--help]

Compile and install a stamped llamactl-agent binary.

Options:
  --allow-dirty  build even when the source checkout has tracked changes
  -h, --help     print this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-dirty)
      ALLOW_DIRTY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${HOME}/.local/bin/llamactl-agent"

if ! COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"; then
  echo "[install-agent] error: this script stamps the binary with the source commit and must run from a git checkout" >&2
  exit 1
fi
if [[ ! "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[install-agent] error: this script stamps the binary with the source commit and must run from a git checkout" >&2
  exit 1
fi

PORCELAIN="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)"
DIRTY=false
if [ -n "$PORCELAIN" ]; then
  if [ -z "${ALLOW_DIRTY:-}" ]; then
    echo "[install-agent] error: refusing to build from a dirty tree; tracked changes:" >&2
    printf '%s\n' "$PORCELAIN" | sed -n '1,5p' >&2
    echo "[install-agent] hint: commit or stash these changes, or rerun with --allow-dirty" >&2
    exit 1
  fi
  DIRTY=true
fi

# Matches Date.toISOString(): UTC with millisecond precision.
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

mkdir -p "$(dirname "$OUT")"

PARTIAL="${OUT}.partial-$$"
trap 'rm -f "$PARTIAL"' EXIT

echo "[install-agent] compiling from $REPO_ROOT/packages/cli/src/bin.ts"
echo "[install-agent] output: $OUT"
echo "[install-agent] stamp: ${COMMIT:0:12} dirty=$DIRTY built_at=$BUILT_AT"

bun build --compile --target=bun-darwin-arm64 \
  --define "__BUILD_STAMP_COMMIT__=\"${COMMIT}\"" \
  --define "__BUILD_STAMP_DIRTY__=${DIRTY}" \
  --define "__BUILD_STAMP_BUILT_AT__=\"${BUILT_AT}\"" \
  "$REPO_ROOT/packages/cli/src/bin.ts" \
  --outfile "$PARTIAL"

if ! VERSION_OUTPUT="$("$PARTIAL" --version 2>&1)"; then
  echo "[install-agent] error: stamped binary --version failed; expected commit ${COMMIT:0:12}" >&2
  echo "[install-agent] actual --version output: ${VERSION_OUTPUT:-<no output>}" >&2
  exit 1
fi
case "$VERSION_OUTPUT" in
  *"${COMMIT:0:12}"*)
    ;;
  *)
    echo "[install-agent] error: stamped binary did not report expected commit ${COMMIT:0:12} in --version" >&2
    echo "[install-agent] actual --version output: $VERSION_OUTPUT" >&2
    exit 1
    ;;
esac

mv -f "$PARTIAL" "$OUT"
printf '[install-agent] stamped --version: %s\n' "$VERSION_OUTPUT"
ls -lh "$OUT"

cat <<EOF

[install-agent] NEXT STEPS (one-time):

  The binary is stamped with its source commit, dirty flag and build
  time (#743). Builds from a dirty tree are refused unless you pass
  --allow-dirty as an explicit escape hatch.

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

  4. Verify the running node's stamp either locally:

       $OUT --version

     or over the agent API — build.commit is in the JSON response:

       curl -H 'Accept: application/json' https://<node>:<port>/healthz

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
