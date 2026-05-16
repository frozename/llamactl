#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPLITS = ("train", "valid", "test")


def _read_jsonl(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise TypeError(f"Expected an object in {path}")
            rows.append(row)
    return rows


def _convert_row(row: dict[str, object]) -> dict[str, object]:
    prompt = row.get("prompt")
    completion = row.get("completion")
    if not isinstance(prompt, str):
        raise TypeError("Row is missing string prompt")
    if not isinstance(completion, str):
        raise TypeError("Row is missing string completion")

    return {
        "messages": [
            {"role": "user", "content": prompt.rstrip()},
            {"role": "assistant", "content": completion.lstrip(" ")},
        ]
    }


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--framing", choices=("binary", "4way"), default="binary")
    args = parser.parse_args()

    input_dir = ROOT / args.framing
    output_dir = ROOT / f"{args.framing}-chat"

    total_counts: dict[str, int] = {}
    for split in SPLITS:
        input_path = input_dir / f"{split}.jsonl"
        output_path = output_dir / f"{split}.jsonl"
        input_rows = _read_jsonl(input_path)
        output_rows = [_convert_row(row) for row in input_rows]
        _write_jsonl(output_path, output_rows)
        total_counts[split] = len(output_rows)

    print(f"Wrote chat corpus to: {output_dir}")
    for split in SPLITS:
        print(f"{split}: {total_counts[split]} rows")


if __name__ == "__main__":
    main()
