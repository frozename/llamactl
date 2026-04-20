#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

for target in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  echo "=== Building llamactl-agent for $target ==="
  bun run "$REPO_ROOT/packages/cli/src/bin.ts" artifacts build-agent --target="$target"
done

echo ""
echo "=== Done. Binaries under \$LLAMACTL_ARTIFACTS_DIR or \$DEV_STORAGE/artifacts or ~/.llamactl/artifacts /agent/<platform>/llamactl-agent ==="
bun run "$REPO_ROOT/packages/cli/src/bin.ts" artifacts list
