#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[4]
CORPUS_DIR = ROOT / "tools" / "memory-efficacy-bench" / "corpus"

CLASS_ORDER = [
    "missed_registration",
    "recall_miss",
    "memory_ignored",
    "not_memory_related",
]
BINARY_ORDER = ["memory_related", "not_memory_related"]
SPLITS = ("train", "valid", "test")

CLASS_PROMPT = (
    "Classify the following finding into one of: missed_registration, recall_miss, memory_ignored, not_memory_related.\n\n"
    "missed_registration: would have been prevented by a memory that was never written.\n"
    "recall_miss: a relevant memory existed but autoRecallForDispatch returned 0 hits.\n"
    "memory_ignored: a relevant memory was recalled but disregarded.\n"
    "not_memory_related: not about memory efficacy.\n\n"
    "Return JSON only: {\"classification\": \"...\", \"reason\": \"...\"}\n\n"
)
BINARY_PROMPT = (
    "Is the following finding about memory efficacy (a missed registration, recall miss, or ignored memory)?\n\n"
    "Return JSON only: {\"memory_related\": true|false, \"reason\": \"...\"}\n\n"
)


def _load_json(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise TypeError(f"Expected an array in {path}")
    return data


def _split_name(index: int) -> str:
    mod = index % 10
    if mod <= 7:
        return "train"
    if mod == 8:
        return "valid"
    return "test"


def _append_prefix(severity: Any, text: str) -> str:
    if severity is None:
        return f"Finding: {text}"
    return f"Finding: [{severity}] {text}"


def _build_record(
    prompt_prefix: str,
    text: str,
    severity: Any,
    completion_obj: dict[str, Any],
) -> dict[str, str]:
    return {
        "prompt": prompt_prefix + _append_prefix(severity, text),
        "completion": " " + json.dumps(completion_obj, ensure_ascii=False, separators=(",", ":")),
    }


def _build_splits(
    rows_by_class: dict[str, list[dict[str, Any]]],
    prompt_prefix: str,
    completion_key: str,
) -> tuple[dict[str, list[dict[str, str]]], dict[str, dict[str, int]]]:
    splits: dict[str, list[dict[str, str]]] = {split: [] for split in SPLITS}
    counts: dict[str, dict[str, int]] = {
        split: {cls: 0 for cls in (BINARY_ORDER if completion_key == "memory_related" else CLASS_ORDER)}
        for split in SPLITS
    }

    for source_class in CLASS_ORDER:
        rows = sorted(rows_by_class.get(source_class, []), key=lambda row: row["findingId"])
        for idx, row in enumerate(rows):
            split = _split_name(idx)
            if completion_key == "memory_related":
                completion_obj = {
                    "memory_related": source_class != "not_memory_related",
                    "reason": row.get("reason", ""),
                }
                count_key = "memory_related" if source_class != "not_memory_related" else "not_memory_related"
            else:
                completion_obj = {
                    "classification": source_class,
                    "reason": row.get("reason", ""),
                }
                count_key = source_class

            splits[split].append(
                _build_record(
                    prompt_prefix=prompt_prefix,
                    text=row.get("text", ""),
                    severity=row.get("severity"),
                    completion_obj=completion_obj,
                )
            )
            counts[split][count_key] += 1

    return splits, counts


def _write_jsonl(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def _format_counts(title: str, counts: dict[str, dict[str, int]], order: list[str]) -> str:
    lines = [title]
    for split in SPLITS:
        bits = ", ".join(f"{cls}={counts[split][cls]}" for cls in order)
        lines.append(f"{split}: {bits}")
    return "\n".join(lines)


def main() -> None:
    findings = _load_json(CORPUS_DIR / "findings.json")
    labels = _load_json(CORPUS_DIR / "gold-labels.json")

    labels_by_id = {label["findingId"]: label for label in labels if "findingId" in label}
    rows_by_class: dict[str, list[dict[str, Any]]] = {cls: [] for cls in CLASS_ORDER}

    skipped = 0
    for finding in findings:
        finding_id = finding.get("findingId")
        if finding_id is None:
            skipped += 1
            continue
        label = labels_by_id.get(finding_id)
        if label is None:
            skipped += 1
            continue
        classification = label.get("classification")
        if classification not in rows_by_class:
            continue
        rows_by_class[classification].append(
            {
                "findingId": finding_id,
                "severity": finding.get("severity"),
                "text": finding.get("text", ""),
                "reason": label.get("reason", ""),
            }
        )

    if skipped:
        print(f"Skipped {skipped} findings without labels")

    fourway_splits, fourway_counts = _build_splits(
        rows_by_class=rows_by_class,
        prompt_prefix=CLASS_PROMPT,
        completion_key="classification",
    )
    binary_rows_by_class = {
        "missed_registration": rows_by_class["missed_registration"],
        "recall_miss": rows_by_class["recall_miss"],
        "memory_ignored": rows_by_class["memory_ignored"],
        "not_memory_related": rows_by_class["not_memory_related"],
    }
    binary_splits, binary_counts = _build_splits(
        rows_by_class=binary_rows_by_class,
        prompt_prefix=BINARY_PROMPT,
        completion_key="memory_related",
    )

    for split in SPLITS:
        _write_jsonl(ROOT / "packages" / "train" / "corpora" / "memory-efficacy" / "4way" / f"{split}.jsonl", fourway_splits[split])
        _write_jsonl(ROOT / "packages" / "train" / "corpora" / "memory-efficacy" / "binary" / f"{split}.jsonl", binary_splits[split])

    print(_format_counts("4-way split table:", fourway_counts, CLASS_ORDER))
    print(_format_counts("Binary split table:", binary_counts, BINARY_ORDER))


if __name__ == "__main__":
    main()
