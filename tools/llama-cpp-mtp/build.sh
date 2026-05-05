#!/usr/bin/env bash
# Idempotent build of the MTP branch of llama.cpp into a side-by-side
# tree at $LLAMA_CPP_SRC_MTP. Vanilla LLAMA_CPP_SRC is never touched.
#
# Re-running this script after the pinned SHA changes will fetch and
# checkout the new SHA, then rebuild incrementally.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINNED_SHA="$(tr -d '[:space:]' < "$SCRIPT_DIR/PINNED_SHA")"
if [[ -z "$PINNED_SHA" ]]; then
  echo "tools/llama-cpp-mtp/PINNED_SHA is empty" >&2
  exit 1
fi

: "${DEV_STORAGE:?DEV_STORAGE must be set (run: eval \"$(llamactl env --eval)\")}"
LLAMA_CPP_SRC_MTP="${LLAMA_CPP_SRC_MTP:-$DEV_STORAGE/src/llama.cpp-mtp}"

if [[ ! -d "$LLAMA_CPP_SRC_MTP/.git" ]]; then
  echo "Cloning llama.cpp into $LLAMA_CPP_SRC_MTP"
  git clone https://github.com/ggml-org/llama.cpp "$LLAMA_CPP_SRC_MTP"
fi

cd "$LLAMA_CPP_SRC_MTP"
git fetch origin "+refs/pull/22673/head:refs/remotes/origin/pr-22673"
git checkout --detach "$PINNED_SHA"

cmake -B build \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_CURL=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --target llama-server llama-bench

echo "MTP build OK at: $LLAMA_CPP_SRC_MTP/build/bin/llama-server"
"$LLAMA_CPP_SRC_MTP/build/bin/llama-server" --version | head -1
