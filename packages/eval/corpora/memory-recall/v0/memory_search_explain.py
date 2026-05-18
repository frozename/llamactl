#!/usr/bin/env python3
"""Llamactl-side pilot of penumbra "ask #4" — expose the FTS query
rewriter as a callable function and return the BM25-ranked candidates
plus their scores, so miners can validate how their rewriting diverges
from the live `memory_search` MCP tool.

Wraps the same tokenization the corpus miners (`mine_t0.py`,
`synth_t2.py`) already do. The goal is to prove the API-surface value
before asking penumbra to land an authoritative
`memory_search_explain(query) → {fts_query, candidates, scores}` MCP
endpoint.

Usage:
  python3 memory_search_explain.py \
    --db ~/.penumbra/db.sqlite \
    --query 'chain_start dispatching parallel agents' \
    --k 5

Emits JSON to stdout:
  {
    "raw_query": "chain_start dispatching parallel agents",
    "fts_query": "chain OR start OR dispatching OR parallel OR agents",
    "candidates": [
      {"rank": 1, "memory_id": "...", "title": "...", "bm25_score": ..., "snippet": "..."},
      ...
    ]
  }

The `bm25_score` here is sqlite's `bm25(t2_fts)` lower-is-better
score, so candidates are ordered ascending. To match the live
`memory_search` MCP ranking, an external validator can call the MCP
tool on the same `raw_query` and diff the resulting id ordering
against this script's output.

This script is intentionally read-only against the penumbra db. If a
caller wants to compare against the live MCP ranking, do that
separately and feed both into a diff.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path


FTS_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def rewrite_for_fts5(query: str) -> str:
    """Token-extract + lowercase + dedupe + OR-fanout.

    Mirrors the rewriting used by `mine_t0.py` / `synth_t2.py`. This is
    a best-effort approximation of penumbra's `search()` rewriter; the
    point of this pilot is to surface the gap so penumbra can land an
    authoritative version that supersedes this.
    """
    toks = FTS_TOKEN_RE.findall(query)
    seen: set[str] = set()
    out: list[str] = []
    for t in toks:
        t = t.lower()
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return " OR ".join(out)


def fts_candidates(
    conn: sqlite3.Connection, fts_query: str, k: int
) -> list[dict[str, object]]:
    if not fts_query:
        return []
    try:
        rows = conn.execute(
            """
            SELECT m.memory_id,
                   m.title,
                   bm25(t2_fts) AS score,
                   snippet(t2_fts, 0, '«', '»', '…', 10) AS snip
            FROM t2_fts
            JOIN t2_memories m ON t2_fts.rowid = m.rowid
            WHERE t2_fts MATCH ?
            ORDER BY score
            LIMIT ?
            """,
            (fts_query, k),
        ).fetchall()
    except sqlite3.OperationalError as e:
        print(f"# fts error: {e}", file=sys.stderr)
        return []
    return [
        {"rank": i + 1, "memory_id": r[0], "title": r[1], "bm25_score": r[2], "snippet": r[3]}
        for i, r in enumerate(rows)
    ]


def explain(db_path: Path, query: str, k: int) -> dict[str, object]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = 1;")
    try:
        fts_query = rewrite_for_fts5(query)
        candidates = fts_candidates(conn, fts_query, k)
        return {
            "raw_query": query,
            "fts_query": fts_query,
            "candidates": candidates,
        }
    finally:
        conn.close()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=str(Path.home() / ".penumbra" / "db.sqlite"))
    p.add_argument("--query", required=True)
    p.add_argument("--k", type=int, default=5)
    args = p.parse_args()

    result = explain(Path(args.db), args.query, args.k)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
