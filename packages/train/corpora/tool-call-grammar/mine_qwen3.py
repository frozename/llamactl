#!/usr/bin/env python3
"""Replay seed prompts through a Qwen3-style llama-server with --jinja and capture
the gold-standard tool_calls JSON. Output goes to gold-corpus.jsonl.

Each output line is one record:
  {
    "id": "<seed id>",
    "messages": [<original messages>],
    "tools": [<original tools schema>],
    "tool_choice": "<original>",
    "expected_tool_calls": <list or null — the model's response.choices[0].message.tool_calls>,
    "expected_content": <string — the model's response.choices[0].message.content>,
  }

For "negative" seeds (where the model should NOT call a tool) the expected_tool_calls
is null and expected_content carries the textual reply.

Usage:
  python3 mine_qwen3.py --seeds seeds.json --port 19099 --out gold-corpus.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def post_chat(port: int, body: dict) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def mine(seeds_path: Path, port: int, out_path: Path) -> tuple[int, int]:
    payload = json.loads(seeds_path.read_text(encoding="utf-8"))
    seeds = payload["seeds"]
    written = 0
    failed = 0
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for seed in seeds:
            body = {
                "model": "qwen3-8b",
                "messages": seed["messages"],
                "tools": seed["tools"],
                "tool_choice": seed.get("tool_choice", "auto"),
                "max_tokens": 256,
                "temperature": 0.0,
                "chat_template_kwargs": {"enable_thinking": False},
            }
            try:
                resp = post_chat(port, body)
                msg = resp["choices"][0]["message"]
                rec = {
                    "id": seed["id"],
                    "messages": seed["messages"],
                    "tools": seed["tools"],
                    "tool_choice": seed.get("tool_choice", "auto"),
                    "expected_tool_calls": msg.get("tool_calls"),
                    "expected_content": msg.get("content", ""),
                }
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                written += 1
                tc_count = len(msg.get("tool_calls") or [])
                tc_summary = (
                    f"{tc_count} tool_call(s): "
                    + ", ".join(tc.get("function", {}).get("name", "?") for tc in (msg.get("tool_calls") or []))
                    if tc_count > 0
                    else f"text ({len(msg.get('content', ''))} chars)"
                )
                print(f"  {seed['id']}: {tc_summary}", file=sys.stderr)
            except urllib.error.URLError as e:
                failed += 1
                print(f"  {seed['id']}: FAILED {e}", file=sys.stderr)
                continue
            except (KeyError, IndexError) as e:
                failed += 1
                print(f"  {seed['id']}: bad response shape {e}", file=sys.stderr)
                continue
            time.sleep(0.05)
    return written, failed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", required=True, type=Path)
    ap.add_argument("--port", type=int, default=19099)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    written, failed = mine(args.seeds, args.port, args.out)
    print(f"\nWrote {written} rows to {args.out} (failed: {failed})", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
