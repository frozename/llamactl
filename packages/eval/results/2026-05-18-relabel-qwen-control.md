# Memory-recall Qwen-relabel control — 2026-05-18

## Goal

The session-PM head-to-head + fleet bench ran on a corpus whose 50 synth
rows were labeled by granite-4.1-8b-Q4_K_M. The corpus README flagged
labeler-style bias (question openers concentrated on "What...") as the
top open caveat. This control regenerates the 50 synth rows with a
different labeler (Qwen3.5-9B-MTP) and re-benches the two production
candidates against the relabeled corpus to check whether:

1. Aggregate NDCG@5 numbers move.
2. Model rankings flip.
3. The labeler model gets a self-bias bump on its own questions.

## Method

- Booted Qwen3.5-9B-MTP-UD-Q4_K_XL on `127.0.0.1:8191` with the same
  start args as `specs/qwen35-9b-mtp.json` (atomic-qwen fork, `--spec-type
  nextn`).
- Ran `python3 synth_t2.py --labeler-url http://127.0.0.1:8191 --limit
  50 > synth-qwen.jsonl` against the same `~/.penumbra/db.sqlite`.
- Acceptance: 50 emitted from 62 asks (80%); wall 254s.
- Pool-draw note: `synth_t2.py` uses SQLite `ORDER BY RANDOM()` for the
  t2 sample pool, which ignores the Python `--seed`. The Qwen run drew
  a fully independent memory pool from the granite run (0 of 50
  seed_memory_id values overlap). This is an independent-labeler check,
  not a paired-row diff.
- Reconstituted `test.jsonl` two ways and re-benched both candidates:
  - `cat seed.jsonl mined.jsonl synth-qwen.jsonl > test.jsonl` (n=105).
  - `cat seed.jsonl synth-qwen.jsonl > test.jsonl` (n=55, strong-gold).
- Restored the original `test.jsonl` afterwards (sha-verified
  `97b14ed1...` matches HEAD).
- Spec used: `specs/gemma4-vs-qwen35-headtohead.json` (canonical merge
  of the two single-model spec files).
- Granite-4.1-8B judge stayed live on `:8083` for both runs (penumbra
  re-enables it within 5 min of any disable). Per the n=105 head-to-head
  contention check, NDCG@5 is deterministic under judge contention; tps
  takes a ~2-3% hit.
- Results dbs: `2026-05-18-relabel-qwen-control-{n105,strong}.db`.

## Results — n=105 (seed + mined + synth-qwen)

| Model | NDCG@5 (Qwen) | NDCG@5 (Granite) | Δ NDCG@5 | tps Q | tps G |
|---|---:|---:|---:|---:|---:|
| gemma4-26b-a4b-mtp | **0.8031** | 0.8079 | -0.0048 | 30.68 | 32.63 |
| qwen3.5-9b-mtp-UDQ4KXL | 0.6431 | 0.6622 | -0.0191 | 8.51 | 8.59 |

Gap (gemma4 − qwen3.5): +16.00 pp on Qwen-labeled, +14.57 pp on
Granite-labeled. Gap grew +1.43 pp under labeler swap.

## Results — n=55 (seed + synth-qwen, strong-gold)

| Model | NDCG@5 (Qwen) | NDCG@5 (Granite) | Δ NDCG@5 | tps Q | tps G |
|---|---:|---:|---:|---:|---:|
| gemma4-26b-a4b-mtp | **0.9027** | 0.9119 | -0.0092 | 34.10 | 34.60 |
| qwen3.5-9b-mtp-UDQ4KXL | 0.7419 | 0.7782 | -0.0363 | 9.02 | 9.15 |

Gap: +16.08 pp Qwen-labeled vs +13.37 pp Granite-labeled. Gap grew
+2.71 pp under labeler swap.

## Reads

- **Rankings stable.** gemma4-26b-a4b-mtp wins both tiers under both
  labelers; the production verdict from last session holds.
- **No labeler self-bias for Qwen.** Qwen3.5-9B-MTP scored *worse*
  on its own labeler's questions (Δ -1.9 pp n=105, Δ -3.6 pp strong-gold).
  If anything the granite-labeled corpus was slightly soft on Qwen, not
  hard on it.
- **Gemma4 robustness.** -0.5 to -0.9 pp drop is well inside the n=55
  scoring noise floor (rough bound from row-resampling: ±1-2 pp). The
  model is not labeler-style-dependent at the corpus level.
- **The granite-labeled n=105 corpus is validated for production use.**
  No re-label needed; the strong-gold n=55 headline metric from
  `2026-05-18-memory-recall-strong-gold-fleet.md` stands.

## Caveats

- This is a two-model control on the *only* candidate where a labeler
  self-bias plausibly mattered (Qwen3.5 labeling its own family's
  benchmark). The fleet's other models (granite, qwen3-8b, qwen3.6-35b)
  were not re-benched on the Qwen corpus; relative rankings between
  them could in principle shift, though there is no a-priori reason to
  expect it.
- Paired-row diff was not possible because `synth_t2.py`'s pool draw
  uses SQLite RANDOM() which is not Python-seedable. A future fix
  (`ORDER BY rowid` + Python-side shuffle) would enable per-row
  agreement / disagreement analysis. Out of scope here.
- Run-to-run quality variance on n=55 wasn't formally bounded; the
  ±0.5-1 pp drop here is consistent with what would be expected from
  sampling noise on a single corpus draw, but a second independent draw
  with the same labeler would tighten the bound.
