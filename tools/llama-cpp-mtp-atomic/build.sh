#!/usr/bin/env bash
# Idempotent build of the AtomicBot-ai/atomic-llama-cpp-turboquant fork
# into a side-by-side tree at $LLAMA_CPP_SRC_ATOMIC. Vanilla LLAMA_CPP_SRC
# is never touched.
#
# Re-running this script after the pinned SHA changes will fetch and
# checkout the new SHA, then rebuild incrementally.
#
# Spec: docs/superpowers/specs/2026-05-08-llamacpp-mtp-gemma4-pilot-design.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINNED_SHA="$(tr -d '[:space:]' < "$SCRIPT_DIR/PINNED_SHA")"
if [[ -z "$PINNED_SHA" ]]; then
  echo "tools/llama-cpp-mtp-atomic/PINNED_SHA is empty" >&2
  exit 1
fi

: "${DEV_STORAGE:?DEV_STORAGE must be set (run: eval \"$(llamactl env --eval)\")}"
LLAMA_CPP_SRC_ATOMIC="${LLAMA_CPP_SRC_ATOMIC:-$DEV_STORAGE/src/llama.cpp-atomic}"
ATOMIC_REMOTE="https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant"
ATOMIC_DEFAULT_BRANCH="feature/turboquant-kv-cache"

if [[ ! -d "$LLAMA_CPP_SRC_ATOMIC/.git" ]]; then
  echo "Cloning $ATOMIC_REMOTE into $LLAMA_CPP_SRC_ATOMIC"
  git clone --branch "$ATOMIC_DEFAULT_BRANCH" "$ATOMIC_REMOTE" "$LLAMA_CPP_SRC_ATOMIC"
fi

cd "$LLAMA_CPP_SRC_ATOMIC"
# Make sure the remote is correct (in case the dir was preseeded).
git remote set-url origin "$ATOMIC_REMOTE"
git fetch origin "+refs/heads/$ATOMIC_DEFAULT_BRANCH:refs/remotes/origin/$ATOMIC_DEFAULT_BRANCH"
git checkout --detach "$PINNED_SHA"

cmake -B build \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_CURL=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --target llama-server llama-bench llama-quantize

echo "Atomic build OK at: $LLAMA_CPP_SRC_ATOMIC/build/bin/llama-server"
"$LLAMA_CPP_SRC_ATOMIC/build/bin/llama-server" --version | head -1
