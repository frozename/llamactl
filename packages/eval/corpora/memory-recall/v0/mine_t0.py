#!/usr/bin/env python3
"""Mine memory-recall corpus rows from penumbra t0_events memory_search calls.

For each distinct query an agent ran via `mcp__penumbra__memory_search`, this
script:
  1. Pulls up to 10 candidate t2 memories via FTS5 BM25 against `t2_fts`.
  2. Treats the BM25 top-1 hit as the weak-supervision gold (self-consistency
     labeling — the same ranking the agent saw).
  3. Randomizes the candidate order in the output row so the BM25 rank is not
     directly leaked to the evaluated model.
  4. Emits one JSONL row per query matching the seed.jsonl shape.

Weak supervision caveat: gold here is a BM25 self-label, NOT a human or
downstream-action-derived label. This is acceptable for an initial bench
signal but should be hand-spot-checked before any prod claim.

Usage:
  python3 mine_t0.py --db ~/.penumbra/db.sqlite --limit 50 \
    > mined.jsonl
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sqlite3
import sys
from pathlib import Path


FTS_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def normalize_query(raw: str) -> str:
    tokens = FTS_TOKEN_RE.findall(raw)
    seen, out = set(), []
    for t in tokens:
        t = t.lower()
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return " ".join(out)


def fetch_distinct_queries(conn: sqlite3.Connection, max_queries: int) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT trim(lower(json_extract(payload_json, '$.input.query'))) AS q
        FROM t0_events
        WHERE event_type = 'agent-tool-use'
          AND json_extract(payload_json, '$.tool') = 'mcp__penumbra__memory_search'
          AND q IS NOT NULL
          AND length(q) >= 6
        ORDER BY RANDOM()
        LIMIT ?
        """,
        (max_queries * 4,),
    ).fetchall()
    return [r[0] for r in rows]


def bm25_top_k(conn: sqlite3.Connection, query: str, k: int) -> list[tuple[str, str, str]]:
    norm = normalize_query(query)
    if not norm:
        return []
    # OR-search over normalized tokens: liberal so we still hit when the agent
    # used compound identifiers that FTS5 unicode61 tokenizes apart.
    fts_query = " OR ".join(norm.split())
    try:
        rows = conn.execute(
            """
            SELECT m.memory_id, m.title, m.body
            FROM t2_fts
            JOIN t2_memories m ON t2_fts.rowid = m.rowid
            WHERE t2_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, k),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [(r[0], r[1], r[2]) for r in rows]


def build_row(query: str, hits: list[tuple[str, str, str]]) -> dict | None:
    if len(hits) < 3:
        return None
    gold_memory_id = hits[0][0]
    candidates = [
        {"id": f"mem_{i:03d}", "text": f"{title}\n\n{body}".strip()}
        for i, (_, title, body) in enumerate(hits, start=1)
    ]
    id_for = {hits[i][0]: cand["id"] for i, cand in enumerate(candidates)}
    shuffled = list(candidates)
    random.shuffle(shuffled)
    return {
        "query": query,
        "context": "(mined from penumbra t0 agent-tool-use; weak-gold from BM25 self-label)",
        "candidates": shuffled,
        "gold_ids": [id_for[gold_memory_id]],
        "_provenance": {
            "weak_gold": True,
            "gold_memory_id": gold_memory_id,
        },
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=str(Path.home() / ".penumbra" / "db.sqlite"))
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--candidates", type=int, default=10)
    p.add_argument("--seed", type=int, default=2026_05_18)
    args = p.parse_args()

    random.seed(args.seed)

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = 1;")

    pool = fetch_distinct_queries(conn, args.limit)
    rows: list[dict] = []
    for raw_q in pool:
        if len(rows) >= args.limit:
            break
        hits = bm25_top_k(conn, raw_q, args.candidates)
        row = build_row(raw_q, hits)
        if row is None:
            continue
        rows.append(row)

    for r in rows:
        sys.stdout.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"# emitted {len(rows)} rows (asked for {args.limit})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
