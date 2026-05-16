# Memory-efficacy 4-way LoRA re-eval on expanded test set (M.4)

`git log -1 --oneline`: `5d1bf03 fix(train): restore kill_port arg + wait_port_bindable in eval scripts`

Test set: `packages/train/corpora/memory-efficacy/4way-chat/test.jsonl` — n=60, with ≥4 rows in each minority class (`missed_registration`, `recall_miss`, `memory_ignored` = 4 each; `not_memory_related` = 48).

Base + adapter GGUFs: `packages/train/.spike-work/memory-efficacy-4way-qwen3-8b-chat/gguf/{base,adapter}.gguf` (adapter mtime 2026-05-16 01:46, trained pre-expansion).

Eval: `WRAP_CHAT_TEMPLATE=1`, `FRAMING=4way`, `temperature=0`, `n_predict=250`. Parse rate 1.00 on both runs.

## Prior baseline (n=49, pre-expansion)

| | macro-F1 | missed_registration F1 | recall_miss F1 | memory_ignored F1 | not_memory_related F1 |
|---|---|---|---|---|---|
| adapter | 0.4918 | 0.0000 | 1.0000 | 0.0000 | 0.9778 |

Minority floor was statistically dead — n=1-2 per class made F1 a coin flip.

## New run (n=60, post-expansion)

|        | accuracy | macro-F1 | parse rate |
|--------|----------|----------|------------|
| base   | 0.8833 | 0.6868 | 1.0000 |
| adapter| 0.8833 | 0.6683 | 1.0000 |
| delta (adapter − base) | 0.0000 | -0.0185 | 0.0000 |

### Per-class (precision / recall / F1)

| class | base P/R/F1 | adapter P/R/F1 |
|-------|-------------|----------------|
| missed_registration | 0.7500 / 0.7500 / **0.7500** | 0.6000 / 0.7500 / **0.6667** |
| recall_miss         | 1.0000 / 0.5000 / **0.6667** | 1.0000 / 0.5000 / **0.6667** |
| memory_ignored      | 1.0000 / 0.2500 / **0.4000** | 1.0000 / 0.2500 / **0.4000** |
| not_memory_related  | 0.8868 / 0.9792 / **0.9307** | 0.9038 / 0.9792 / **0.9400** |

## Deltas

- **Adapter vs base on n=60:** macro-F1 -0.0185. The adapter regresses on `missed_registration` (-0.0833) and is at parity on the other three classes. The minority signal is identical between base and adapter (same R, same P, same F1 on `recall_miss` and `memory_ignored`).
- **New adapter vs prior adapter (n=49 → n=60):** macro-F1 0.4918 → 0.6683 (+0.1765). The lift is from the corpus expansion making per-class F1 measurable, not from the adapter learning anything new.
- **Sample disagreement (first row where adapter ≠ base):** row 8, gold `recall_miss`, base predicted `not_memory_related`, adapter predicted `missed_registration` — both wrong; adapter picks a different minority class but doesn't recover the right one.

## Verdict

The corpus expansion (M.1+M.2+M.3) was the right move — macro-F1 is now measurable and not pinned by a 1-2-row minority. But the LoRA adapter trained on the pre-expansion corpus does not add value over `Qwen3-8B-Base + chat-template wrap`. The base is already at the ceiling this corpus + framing supports; the adapter's marginal noise on `missed_registration` actively hurts.

Implications for next moves:
- **M.5 (downsample `not_memory_related`)** is still worth running — the 88% majority class lets the model coast on the dominant prediction. A more balanced test set would expose whether minority recall is recoverable at all.
- **Retraining the adapter on the expanded corpus** is a separate thread (call it M.7) — the current adapter has never seen the +91 minority rows. Until that's trained and re-evaluated, "adapter does not help" is specifically about the pre-expansion adapter, not LoRA as a technique.

## Operational note

The dispatched codex-acp-fast worker could not bind `127.0.0.1:18099` in its sandboxed exec context — `llama-server` exited with `start: couldn't bind HTTP server socket` on both server cycles even after `kill_port` + `wait_port_bindable` ran cleanly. The same eval ran end-to-end in ~3 minutes from a maestro shell. Future eval dispatches should either be hand-run from the maestro shell or use an agent whose worker context can open listening sockets.
