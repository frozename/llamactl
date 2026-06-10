# Memory-recall head-to-head — 2026-05-18 PM

## Setup

- Corpus: `packages/eval/corpora/memory-recall/v0/test.jsonl` (n=105 — 5 hand-built seed + 50 mined weak-gold + 50 synth strong-gold labeled by granite-4.1-8b).
- Workload: `memory-recall`, primary metric `mean_ndcg5`.
- Machine: M4 Pro MacBook (Alexandres-MacBook-Pro). Granite-4.1-8b judge paused via `llamactl disable` for the duration so Metal compute wasn't shared.
- Results db: `2026-05-18-memory-recall-n105-head-to-head.db` (sibling of this file).

## Results

| Model                                            |     NDCG@5 |       tps | latency p50 / p95 |   wall |
| ------------------------------------------------ | ---------: | --------: | ----------------: | -----: |
| gemma4-26b-a4b-mtp (atomic fork)                 | **0.8079** | **32.63** |   2.29 s / 2.97 s |  4 min |
| qwen3.5-9b-mtp-UDQ4KXL (atomic-qwen fork, NextN) |     0.6622 |      8.59 |  8.03 s / 10.55 s | 14 min |

Both runs: `n_parse_error = 0`, `errors = 0`.

## Reads

- **Gemma4-26b-a4b-mtp wins on both axes** — +14.6 pp NDCG@5 and 3.8× throughput, despite having ~2.6× more total parameters. The MoE active-param advantage (4B active vs Qwen's 9B dense) shows up at runtime.
- **NextN draft acceptance was good** (~0.58 on the smoke test) but couldn't close the gap because the per-token compute baseline is higher.
- **Contention check:** identical NDCG@5 was observed in a contention re-run (granite-8b judge still up). Contention only cost ~2-3% throughput, never quality. Scoring is deterministic.

## Caveats

- The synth half of the corpus was labeled by granite-4.1-8b-Q4_K_M. Some of Qwen's NDCG@5 deficit may reflect labeler-style bias (question openers concentrate on "What..." per `corpora/memory-recall/v0/README.md`). The right control is a Qwen-relabeled corpus diff.
- Gold quality is mixed: 5 hand-built (strong), 50 BM25-top-1 weak gold, 50 BM25-confirmed seed-id strong gold. Per-row breakdowns by tier not yet persisted.
- Only two models compared. The wider fleet bench (granite-8b, qwen3-8b, qwen3.6-35b-A3B, gemma4-e4b) is still pending and will produce a real ranking.
