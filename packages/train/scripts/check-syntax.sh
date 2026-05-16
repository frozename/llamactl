#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for script in "$ROOT_DIR"/scripts/*.sh; do
  bash -n "$script"
done

python3 - "$ROOT_DIR" <<'PY'
import ast
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
for path in list(root.joinpath("corpora").rglob("*.py")) + list(root.joinpath("src").rglob("*.py")):
    ast.parse(path.read_text())
PY
