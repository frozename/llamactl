#!/usr/bin/env bash
# Clone + venv + editable install for jundot/omlx.
# Idempotent: re-running updates to the pinned commit and reinstalls deps.

set -euo pipefail

REPO_URL="https://github.com/jundot/omlx.git"
SRC_DIR="${OMLX_SRC:-/Volumes/WorkSSD/src/omlx}"
LOCK_FILE="$(cd "$(dirname "$0")" && pwd)/omlx.lock"

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "omlx.lock not found at $LOCK_FILE" >&2
  exit 1
fi

PINNED_COMMIT="$(awk -F= '/^commit=/ {print $2; exit}' "$LOCK_FILE")"
if [[ -z "$PINNED_COMMIT" ]]; then
  echo "omlx.lock missing 'commit=<sha>' line" >&2
  exit 1
fi
if [[ ! "$PINNED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "omlx.lock 'commit' must be a full 40-hex SHA; got: $PINNED_COMMIT" >&2
  echo "Symbolic refs (HEAD/main/tag-names) are rejected for reproducibility." >&2
  exit 1
fi

mkdir -p "$(dirname "$SRC_DIR")"

if [[ ! -d "$SRC_DIR/.git" ]]; then
  git clone "$REPO_URL" "$SRC_DIR"
fi

cd "$SRC_DIR"
git fetch --quiet
git checkout --quiet "$PINNED_COMMIT"
ACTUAL_SHA="$(git rev-parse HEAD)"
if [[ "$ACTUAL_SHA" != "$PINNED_COMMIT" ]]; then
  echo "post-checkout SHA mismatch: expected $PINNED_COMMIT, got $ACTUAL_SHA" >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR/.venv" ]]; then
  uv venv
fi
uv pip install -e . --quiet
# pinned for reproducibility; bump along with omlx.lock when verifying a new oMLX commit.
uv pip install xgrammar==0.2.1 --quiet

ENTRYPOINT="$SRC_DIR/.venv/bin/omlx"
if [[ ! -x "$ENTRYPOINT" ]]; then
  echo "expected omlx entrypoint at $ENTRYPOINT but file is not executable" >&2
  exit 1
fi

echo "omlx installed at $ENTRYPOINT (commit $PINNED_COMMIT)"
