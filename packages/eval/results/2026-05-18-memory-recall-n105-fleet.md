# Memory-recall fleet bench — 2026-05-18 PM

## Setup

- Corpus: `packages/eval/corpora/memory-recall/v0/test.jsonl` (n=105 — 5 seed + 50 mined + 50 synth labeled by granite-4.1-8b).
- Workload: `memory-recall`, primary metric `mean_ndcg5`.
- Machine: M4 Pro MacBook (Alexandres-MacBook-Pro).
- Top 2 (gemma4 + qwen3.5-9b-mtp): quiet machine — granite long-lived disabled (see `2026-05-18-memory-recall-n105-head-to-head.md`).
- Bottom 4: penumbra auto-respawned granite-8b judge ~6 min after disable, so these ran with granite-on-:8083 contention. Prior contention/quiet replays showed NDCG@5 is deterministic under contention; only tps takes a ~3% hit.
- Results db: `2026-05-18-memory-recall-n105-fleet.db`.

## Results

| Rank | Model                       |     NDCG@5 |       tps | p50 (ms) | p95 (ms) |    wall |
| ---: | --------------------------- | ---------: | --------: | -------: | -------: | ------: |
|    1 | gemma4-26b-a4b-mtp          | **0.8079** | **32.63** |     2351 |     3034 |   4 min |
|    2 | qwen3.6-35b-A3B-MTP-UDQ4KXL |     0.7003 |     18.02 |     5494 |     6692 | ~10 min |
|    3 | qwen3.6-35b-A3B-UDQ4KXL     |     0.6667 |     26.78 |     3360 |     3834 |   6 min |
|    4 | qwen3.5-9b-mtp-UDQ4KXL      |     0.6622 |      8.59 |     8025 |    10553 |  14 min |
|    5 | granite-8b-Q4               |     0.4743 |     27.31 |     8377 |     9508 |  12 min |
|    6 | qwen3-8b-Q4                 |     0.3608 |     20.06 |     3320 |     4065 |  ~6 min |

All: 0 parse errors, 0 errors.

## Reads

### Production pick is unchanged

Gemma4-26b-a4b-mtp wins both axes by clear margins: +10.7 pp NDCG@5 over 2nd place, 32.63 tps fastest. MTP on the atomic fork, MoE 4B active, runtime-light despite the param count.

### Workload-specific qualifier to the "A3B beats dense+MTP" rule

The memory `project_a3b_beats_mtp_dense_2026-05-18.md` claimed "for A3B/MoE families, plain MoE beats dense+MTP." That was on classification workloads. On memory-recall ranking, MTP on 35B-A3B delivers +3.4 pp over plain A3B (0.7003 vs 0.6667) at a 33% throughput cost (18.02 vs 26.78 tps). The MTP-first rule needs a per-workload qualifier:

- Classification (mem-eff-4way/binary, tool-call-grammar): A3B plain >= A3B+MTP.
- Ranking / generative (memory-recall, refiner-rubric): A3B+MTP > A3B plain by a small but real margin.

### Qwen generational jump is huge

Qwen3.5-9B-MTP (0.6622) beats Qwen3-8B (0.3608) by 30.1 pp. The 3.5 family is a fundamentally better base model on this task, independent of MTP. The Qwen3-8B currently in `qwen3-8b-local` workload is the worst memory-recall ranker tested today.

### Corpus is not a labeler-style game

Granite-8b labeled the synth half of the corpus. If labeler-style matching dominated, granite-8b would top the leaderboard. It ranks 5th (0.4743). The corpus is measuring genuine semantic ranking ability, not "do you write like granite."

## Caveats

- Top-2 ran on a truly quiet machine; ranks 3-6 ran with granite-on-:8083 contention. Per the earlier head-to-head replay, NDCG@5 was deterministic across contention/quiet, so per-rank quality numbers are valid. Throughput numbers for ranks 3-6 are ~2-3% conservative vs a true-quiet run.
- Penumbra auto-respawns `granite41-8b-long-lived-local` because the t2-judge config depends on it. `llamactl disable` doesn't stick for more than ~5 min. A truly quiet fleet bench needs a daemon-level pause or judge-config swap first.
- Synth half (50 of 105 rows) is granite-labeled. The "Qwen-relabel" control is still the right next step to isolate any residual labeler bias.
- Gold quality is mixed: 5 strong + 50 weak (BM25-top-1) + 50 strong-by-confirmation. Per-row breakdown by tier not yet persisted.
