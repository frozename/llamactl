#!/usr/bin/env python3
"""Fetch the HumanEval test split for the code-generation matrix workload."""
import json
import os
import sys
import urllib.parse
import urllib.request

ROWS_API = "https://datasets-server.huggingface.co/rows"
DATASET = "openai/openai_humaneval"
CONFIG = "openai_humaneval"
SPLIT = "test"
OUT = sys.argv[1] if len(sys.argv) > 1 else "packages/eval/corpora/code-humaneval/v0/test.jsonl"
FIELDS = ("task_id", "prompt", "canonical_solution", "test", "entry_point")


def fetch_rows():
    """Return every raw HumanEval row from datasets-server."""
    out = []
    offset = 0
    while True:
        q = urllib.parse.urlencode(
            {
                "dataset": DATASET,
                "config": CONFIG,
                "split": SPLIT,
                "offset": offset,
                "length": 100,
            }
        )
        req = urllib.request.Request(f"{ROWS_API}?{q}", headers={"User-Agent": "llamactl-eval"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read())
        batch = payload.get("rows", [])
        if not batch:
            break
        out.extend(r["row"] for r in batch)
        offset += len(batch)
        if len(batch) < 100:
            break
    return out


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    rows = fetch_rows()
    with open(OUT, "w") as fh:
        for row in rows:
            normalized = {field: row[field] for field in FIELDS}
            fh.write(json.dumps(normalized, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} rows -> {OUT}")


if __name__ == "__main__":
    main()
