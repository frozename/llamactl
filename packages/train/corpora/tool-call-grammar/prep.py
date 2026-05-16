#!/usr/bin/env python3
from __future__ import annotations

import json
import hashlib
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "gold-corpus.jsonl"
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


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def _assistant_turn(row: dict[str, object]) -> dict[str, object]:
    expected_tool_calls = row.get("expected_tool_calls")
    expected_content = row.get("expected_content")
    content = expected_content if isinstance(expected_content, str) else ""
    if expected_tool_calls:
        if not isinstance(expected_tool_calls, list):
            raise TypeError(f"expected_tool_calls must be a list or null for {row.get('id')}")
        tool_calls: list[dict[str, object]] = []
        for call_index, tool_call in enumerate(expected_tool_calls):
            if not isinstance(tool_call, dict):
                raise TypeError(f"expected_tool_calls entry must be an object for {row.get('id')}")
            function = tool_call.get("function")
            if not isinstance(function, dict):
                raise TypeError(f"expected_tool_calls.function must be an object for {row.get('id')}")
            name = function.get("name")
            arguments = function.get("arguments")
            if not isinstance(name, str) or not isinstance(arguments, str):
                raise TypeError(f"expected_tool_calls.function missing name/arguments for {row.get('id')}")
            tool_calls.append(
                {
                    "type": "function",
                    "id": f"call_{call_index}",
                    "function": {
                        "name": name,
                        "arguments": arguments,
                    },
                }
            )
        assistant: dict[str, object] = {"role": "assistant", "content": content, "tool_calls": tool_calls}
        return assistant

    return {"role": "assistant", "content": content}


def bucket(fid: str) -> int:
    return int(hashlib.md5(fid.encode()).hexdigest()[:8], 16) % 10


def _split_name(bucket_value: int) -> str:
    bucket = bucket_value
    if bucket < 8:
        return "train"
    if bucket == 8:
        return "valid"
    return "test"


def main() -> None:
    rows = sorted(_read_jsonl(SOURCE), key=lambda row: str(row.get("id", "")))
    split_rows: dict[str, list[dict[str, object]]] = {split: [] for split in SPLITS}
    split_counts: Counter[str] = Counter()
    class_counts: dict[str, Counter[str]] = {split: Counter() for split in SPLITS}
    negative_rows: list[tuple[int, dict[str, object], dict[str, object]]] = []

    for row in rows:
        row_id = str(row.get("id", ""))
        split = _split_name(bucket(row_id))
        messages = row.get("messages")
        tools = row.get("tools")
        tool_choice = row.get("tool_choice")
        if not isinstance(messages, list) or len(messages) < 2:
            raise TypeError(f"Row {row.get('id')} is missing the expected input messages")

        prepared = {
            "messages": [*messages, _assistant_turn(row)],
            "tools": tools,
            "tool_choice": tool_choice,
        }
        split_rows[split].append(prepared)
        split_counts[split] += 1
        is_positive = bool(row.get("expected_tool_calls"))
        class_counts[split]["positive" if is_positive else "negative"] += 1
        if not is_positive:
            negative_rows.append((bucket(row_id), row, prepared))

    # Keep at least one negative example in valid/test even when hash bucketing
    # sends the tiny negative set to train.
    for target_split, rank in (("test", 1), ("valid", 2)):
        if class_counts[target_split]["negative"] > 0:
            continue
        if len(negative_rows) < rank:
            continue
        chosen_bucket, source_row, prepared = sorted(negative_rows, key=lambda item: item[0], reverse=True)[rank - 1]
        for split in SPLITS:
            if prepared in split_rows[split]:
                split_rows[split].remove(prepared)
                split_counts[split] -= 1
                class_counts[split]["negative"] -= 1
                break
        split_rows[target_split].append(prepared)
        split_counts[target_split] += 1
        class_counts[target_split]["negative"] += 1

    for split in SPLITS:
        _write_jsonl(ROOT / f"{split}.jsonl", split_rows[split])

    print(f"Wrote chat corpus to: {ROOT}")
    for split in SPLITS:
        counts = class_counts[split]
        print(
            f"{split}: {split_counts[split]} rows "
            f"(positive={counts['positive']}, negative={counts['negative']})"
        )


if __name__ == "__main__":
    main()
