#!/usr/bin/env python3
"""Fetch a small, deterministic reasoning corpus for the MoQ-vs-UD A/B.

Pulls the first N rows of each suite's test split via the HF datasets-server
/rows JSON API (no `datasets` lib, no parquet parsing, stdlib only) and writes
a unified JSONL the `reasoning-mc` matrix workload consumes.

Unified row shape:
  { "id", "suite", "kind": "mc"|"numeric", "question",
    "options": [..]   # mc only, index 0 == "A"
    "answer": "C"      # mc: letter; numeric: canonical number string
  }

Suites (all open, deterministic, no RNG / no gated access):
  - mmlu_pro       TIGER-Lab/MMLU-Pro   (hard 10-way MC, reasoning-heavy)
  - gsm8k          openai/gsm8k         (grade-school math word problems)
  - arc_challenge  allenai/ai2_arc      (science MC, 4-way)
GPQA is intentionally skipped: it is gated AND would require shuffling
distractor options (RNG), which we avoid for reproducibility.
"""
import json
import sys
import urllib.parse
import urllib.request

ROWS_API = "https://datasets-server.huggingface.co/rows"
PER_SUITE = int(sys.argv[1]) if len(sys.argv) > 1 else 150
OUT = sys.argv[2] if len(sys.argv) > 2 else "packages/eval/corpora/reasoning-mc/v0/test.jsonl"
LETTERS = [chr(ord("A") + i) for i in range(26)]


def fetch_rows(dataset, config, split, n):
    """Return the first n raw row dicts from datasets-server (paginated, max 100/call)."""
    out = []
    offset = 0
    while len(out) < n:
        length = min(100, n - len(out))
        q = urllib.parse.urlencode(
            {"dataset": dataset, "config": config, "split": split, "offset": offset, "length": length}
        )
        req = urllib.request.Request(f"{ROWS_API}?{q}", headers={"User-Agent": "llamactl-eval"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read())
        batch = payload.get("rows", [])
        if not batch:
            break
        out.extend(r["row"] for r in batch)
        offset += length
    return out[:n]


def norm_mmlu_pro(r):
    opts = r["options"]
    # answer may be a letter ("A") or fall back to answer_index
    ans = r.get("answer")
    if not (isinstance(ans, str) and ans in LETTERS[: len(opts)]):
        ans = LETTERS[int(r["answer_index"])]
    return {"kind": "mc", "question": r["question"], "options": opts, "answer": ans}


def norm_gsm8k(r):
    # gold solution ends with "#### <number>"
    raw = r["answer"].split("####")[-1].strip()
    num = raw.replace(",", "").replace("$", "").strip()
    return {"kind": "numeric", "question": r["question"], "answer": num}


def norm_arc(r):
    ch = r["choices"]
    texts, labels = ch["text"], ch["label"]
    key = str(r["answerKey"]).strip()
    # ARC labels are sometimes "1".."4" and sometimes "A".."D"; map to position -> letter
    if key in labels:
        idx = labels.index(key)
    else:
        idx = LETTERS.index(key)
    return {"kind": "mc", "question": r["question"], "options": texts, "answer": LETTERS[idx]}


SUITES = [
    ("mmlu_pro", "TIGER-Lab/MMLU-Pro", "default", "test", norm_mmlu_pro),
    ("gsm8k", "openai/gsm8k", "main", "test", norm_gsm8k),
    ("arc_challenge", "allenai/ai2_arc", "ARC-Challenge", "test", norm_arc),
]


def main():
    import os

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    written = {}
    with open(OUT, "w") as fh:
        for suite, dataset, config, split, norm in SUITES:
            try:
                raw = fetch_rows(dataset, config, split, PER_SUITE)
            except Exception as e:  # noqa: BLE001
                print(f"  !! {suite}: fetch failed: {e}", file=sys.stderr)
                continue
            count = 0
            for i, r in enumerate(raw):
                try:
                    row = norm(r)
                except Exception as e:  # noqa: BLE001
                    print(f"  .. {suite}[{i}] skipped: {e}", file=sys.stderr)
                    continue
                row = {"id": f"{suite}-{i}", "suite": suite, **row}
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                count += 1
            written[suite] = count
            print(f"  {suite}: {count} rows")
    print(f"wrote {sum(written.values())} rows -> {OUT}")


if __name__ == "__main__":
    main()
