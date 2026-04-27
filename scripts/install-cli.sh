#!/bin/sh
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${LLAMACTL_INSTALL_TO:-$HOME/.local/bin/llamactl}"
TARGET_DIR="$(dirname "$TARGET")"

mkdir -p "$TARGET_DIR"

cat <<EOF > "$TARGET"
#!/bin/sh
set -eu
REPO_ROOT="\${LLAMACTL_HOME:-$REPO_ROOT}"
exec bun "\$REPO_ROOT/packages/cli/src/bin.ts" "\$@"
EOF

chmod +x "$TARGET"

echo "llamactl installed to: $TARGET"