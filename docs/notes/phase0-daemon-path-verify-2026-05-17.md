# Phase 0 — production-state verification — 2026-05-17

**Status:** complete
**Source plan:** `docs/notes/fleet-eval-extension-plan-2026-05-17.md` Phase 0

## Result

Granite-4.1-3B Q8_0 via the production daemon-path wire reproduces the offline benchmark macro-F1 **byte-identically**.

| Metric | Offline (eval-base-only.sh) | Daemon-path (live :8085) |
|---|---|---|
| macro-F1 | 0.9235 | **0.9235** |
| memory_ignored F1 | 0.857 | 0.857 |
| missed_registration F1 | 1.000 | 1.000 |
| recall_miss F1 | 0.857 | 0.857 |
| not_memory_related F1 | 0.980 | 0.980 |
| Parse failures | 0 / 60 | 0 / 60 |

Chat-template handling on the production binary matches what the offline harness saw. No latent drift between `eval-base-only.sh`'s direct `:18099` probe-server and the live `:8085` judge.

## Throughput

| Surface | tok/s decode | Note |
|---|---|---|
| Local `:8085` granite-3b-Q8 | 57.6 | M4 Pro Metal |
| Mac-mini `:7843` gateway → granite-3b-Q8 | 27.7 | M-series mini |

Daemon path wall throughput: 1.4 req/s on the 60-row 4-way corpus (~30-50 output tokens per row). Equivalent to ~50 prompt+completion tok/s end-to-end including HTTP roundtrip.

The prior Qwen3-8B Q4_K_M production-judge wall throughput on the same harness was ~30-40 tok/s (per earlier session notes). Granite-3B Q8_0 is now both higher-quality (+3.04 pp macro-F1) and faster (~1.5× wall).

## What this unblocks

Pre-conditions (i) and (ii) from `attention-thesis-cross-family-eval-2026-05-16-night.md` ship-criteria are satisfied. Phases 1, 2, 3, 4 in the fleet eval extension plan can proceed without waiting on more granite-3b verification.

## Method

Inline Python POST against `127.0.0.1:8085` with model alias `local`, max_tokens=250, temperature=0.0. Same chat-format `messages[:-1]` corpus rows as `eval-base-only.sh`. Per-class precision/recall/F1 over the 4 gold classes. Granite `@@metadata` strip guard included (per `reference_granite_metadata_tag_trap`) — none observed in this run, but kept as defensive scaffold for future evals.

Corpus: `packages/train/corpora/memory-efficacy/4way-chat-fewshot/test.jsonl` (n=60).
Report: `/tmp/phase0-daemon-path/report.txt`.
