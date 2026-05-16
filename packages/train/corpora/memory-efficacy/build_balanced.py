#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
SOURCE_DIR = ROOT / "4way-chat"
OUTPUT_DIR = ROOT / "4way-chat-balanced"
SPLITS = ("train", "valid", "test")
CLASS_ORDER = (
    "missed_registration",
    "recall_miss",
    "memory_ignored",
    "not_memory_related",
)

TARGET_NOT_MEMORY_RELATED = {
    "train": 84,
    "valid": 15,
    "test": 12,
}


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
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


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def _classification(row: dict[str, Any]) -> str:
    messages = row.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        raise TypeError("Expected two chat messages per row")
    assistant = messages[1]
    if not isinstance(assistant, dict):
        raise TypeError("Expected assistant message object")
    content = assistant.get("content")
    if not isinstance(content, str):
        raise TypeError("Expected assistant content string")
    payload = json.loads(content)
    if not isinstance(payload, dict):
        raise TypeError("Expected assistant JSON object")
    classification = payload.get("classification")
    if not isinstance(classification, str):
        raise TypeError("Expected classification string")
    return classification


def _user_prompt(row: dict[str, Any]) -> str:
    messages = row.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        raise TypeError("Expected two chat messages per row")
    user = messages[0]
    if not isinstance(user, dict):
        raise TypeError("Expected user message object")
    content = user.get("content")
    if not isinstance(content, str):
        raise TypeError("Expected user content string")
    return content


def _sha1_key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _balanced_split(rows: list[dict[str, Any]], split: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    by_class: dict[str, list[dict[str, Any]]] = {cls: [] for cls in CLASS_ORDER}
    for row in rows:
        classification = _classification(row)
        if classification not in by_class:
            raise ValueError(f"Unexpected classification {classification!r}")
        by_class[classification].append(row)

    minority_rows: list[dict[str, Any]] = []
    for cls in CLASS_ORDER[:-1]:
        minority_rows.extend(by_class[cls])

    majority_rows = sorted(
        by_class["not_memory_related"],
        key=lambda row: (_sha1_key(_user_prompt(row)), _user_prompt(row)),
    )
    selected_majority = majority_rows[: TARGET_NOT_MEMORY_RELATED[split]]

    output_rows = minority_rows + selected_majority
    counts = {cls: len(by_class[cls]) for cls in CLASS_ORDER[:-1]}
    counts["not_memory_related"] = len(selected_majority)
    return output_rows, counts


def main() -> None:
    counts_by_split: dict[str, dict[str, int]] = {}
    for split in SPLITS:
        input_path = SOURCE_DIR / f"{split}.jsonl"
        output_path = OUTPUT_DIR / f"{split}.jsonl"
        rows = _read_jsonl(input_path)
        output_rows, counts = _balanced_split(rows, split)
        _write_jsonl(output_path, output_rows)
        counts_by_split[split] = counts

    print(f"Wrote balanced corpus to: {OUTPUT_DIR}")
    for split in SPLITS:
        counts = counts_by_split[split]
        print(
            f"{split}: "
            + ", ".join(f"{cls}={counts[cls]}" for cls in CLASS_ORDER)
        )


if __name__ == "__main__":
    main()
