#!/usr/bin/env python3
"""Synthesize memory-recall corpus rows by labeling random t2 memories.

For each sampled t2 memory, prompts a local llama-server (granite-4.1-8b
by default) to invent a question the memory would answer. The hit
question is BM25-searched against t2_fts; if the seed memory lands in
the top-10, the row is emitted with strong-gold = seed memory_id.

Usage:
  python3 synth_t2.py --db ~/.penumbra/db.sqlite \
    --labeler-url http://127.0.0.1:8083 --limit 50 \
    > synth.jsonl
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


FTS_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")
JSON_OBJ_RE = re.compile(r"\{.*\}", re.S)


def normalize_query(raw: str) -> str:
    toks = FTS_TOKEN_RE.findall(raw)
    seen, out = set(), []
    for t in toks:
        t = t.lower()
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return " ".join(out)


def fetch_t2_pool(conn: sqlite3.Connection, n: int) -> list[tuple[str, str, str]]:
    rows = conn.execute(
        """
        SELECT memory_id, title, body FROM t2_memories
        WHERE length(body) >= 80
        ORDER BY RANDOM() LIMIT ?
        """,
        (n,),
    ).fetchall()
    return [(r[0], r[1], r[2]) for r in rows]


def bm25_top_k(conn: sqlite3.Connection, query: str, k: int) -> list[tuple[str, str, str]]:
    norm = normalize_query(query)
    if not norm:
        return []
    fts_query = " OR ".join(norm.split())
    try:
        rows = conn.execute(
            """
            SELECT m.memory_id, m.title, m.body
            FROM t2_fts JOIN t2_memories m ON t2_fts.rowid = m.rowid
            WHERE t2_fts MATCH ?
            ORDER BY rank LIMIT ?
            """,
            (fts_query, k),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [(r[0], r[1], r[2]) for r in rows]


LABEL_PROMPT = """You are labeling a memory for a retrieval-eval corpus.

The memory below is a single t2 memory record from an agent's persistent
store. Write one specific question that THIS memory would correctly
answer (not too broad, not too narrow), then three plausible NEAR-MISS
questions — questions that look topically related but would NOT be
correctly answered by this memory alone.

Return STRICTLY JSON, no preamble, no markdown:
{{"hit_question": "...", "near_miss_questions": ["...", "...", "..."]}}

Memory title: {title}
Memory body: {body}
"""


def call_labeler(url: str, title: str, body: str, timeout: int = 60) -> dict | None:
    prompt = LABEL_PROMPT.format(title=title, body=body)
    payload = {
        "model": "local",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "max_tokens": 400,
        "stream": False,
    }
    req = urllib.request.Request(
        url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"# labeler error: {e}", file=sys.stderr)
        return None
    text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    m = JSON_OBJ_RE.search(text)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    hq = obj.get("hit_question")
    nmq = obj.get("near_miss_questions")
    if not isinstance(hq, str) or not isinstance(nmq, list):
        return None
    if not all(isinstance(q, str) for q in nmq):
        return None
    return {"hit_question": hq, "near_miss_questions": nmq[:3]}


def build_row(
    query: str, seed_memory_id: str, hits: list[tuple[str, str, str]]
) -> dict | None:
    if len(hits) < 3:
        return None
    id_index = {h[0]: i for i, h in enumerate(hits)}
    if seed_memory_id not in id_index:
        return None
    candidates = [
        {"id": f"mem_{i:03d}", "text": f"{title}\n\n{body}".strip()}
        for i, (_, title, body) in enumerate(hits, start=1)
    ]
    seed_local_id = candidates[id_index[seed_memory_id]]["id"]
    shuffled = list(candidates)
    random.shuffle(shuffled)
    return {
        "query": query,
        "context": "(synthetic; labeler-generated question + BM25 candidates; strong-gold=seed)",
        "candidates": shuffled,
        "gold_ids": [seed_local_id],
        "_provenance": {
            "synthetic": True,
            "seed_memory_id": seed_memory_id,
        },
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=str(Path.home() / ".penumbra" / "db.sqlite"))
    p.add_argument("--labeler-url", default="http://127.0.0.1:8083")
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--candidates", type=int, default=10)
    p.add_argument("--seed", type=int, default=2026_05_18)
    p.add_argument("--oversample", type=float, default=2.5, help="pool size = limit*oversample")
    args = p.parse_args()

    random.seed(args.seed)

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = 1;")

    pool_size = int(args.limit * args.oversample)
    pool = fetch_t2_pool(conn, pool_size)
    rows: list[dict] = []
    asked = 0
    started = time.time()
    for mid, title, body in pool:
        if len(rows) >= args.limit:
            break
        asked += 1
        labeled = call_labeler(args.labeler_url, title, body)
        if labeled is None:
            continue
        hq = labeled["hit_question"].strip()
        if not hq:
            continue
        hits = bm25_top_k(conn, hq, args.candidates)
        row = build_row(hq, mid, hits)
        if row is None:
            continue
        rows.append(row)

    for r in rows:
        sys.stdout.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(
        f"# emitted {len(rows)} rows; asked labeler {asked}; wall_s={time.time() - started:.1f}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
