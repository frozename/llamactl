# mtp-bench

Throughput bench for **MTP draft-speculative decoding** on Gemma 4 QAT models:
baseline (target alone) vs MTP (target + an `assistant-MTP` draft via
`--spec-type draft-mtp`). Records gen tok/s + draft acceptance per size.

## Why

A r/LocalLLaMA post reported 1.2–1.8× speedups from Gemma 4 QAT + MTP on an
RTX 3090. This harness reproduces that exact config to check whether it holds on
other hardware. **On M4 Pro/Metal it does not** — 12B is flat (0.99×), 26B-A4B is
marginal (1.10×), and the 31B regresses 41% (0.59×) because Metal serializes the
draft+target passes. Full analysis:
`docs/notes/2026-06-08-gemma4-qat-family-eval-and-mtp-metal.md`.

## Prereqs

- A `llama-server` with Gemma4 MTP merged (`llama : add Gemma4 MTP (#23398)`) — it
  must accept `--spec-type draft-mtp` and `--spec-draft-n-max`.
- The GGUFs, laid out as `$MODELS/gemma-4-<sz>-it-qat-GGUF/gemma-4-<sz>-it-qat-UD-Q4_K_XL.gguf`
  (mains) and `$MODELS/gemma-4-<sz>-it-qat-assistant-MTP-Q8_0-GGUF/…-assistant-MTP-Q8_0.gguf`
  (drafts):
  ```
  hf download unsloth/gemma-4-<sz>-it-qat-GGUF gemma-4-<sz>-it-qat-UD-Q4_K_XL.gguf \
    --local-dir $MODELS/gemma-4-<sz>-it-qat-GGUF
  hf download Janvitos/gemma-4-<sz>-it-qat-assistant-MTP-Q8_0-GGUF \
    gemma-4-<sz>-it-qat-assistant-MTP-Q8_0.gguf \
    --local-dir $MODELS/gemma-4-<sz>-it-qat-assistant-MTP-Q8_0-GGUF
  ```

## Run

```
BIN=/path/to/llama-server MODELS=/path/to/models SIZES="12B 26B-A4B 31B" \
  zsh tools/mtp-bench/bench-mtp.sh
```

Results go to `$OUT` (default `/tmp/mtp-bench-results.tsv`):
`model, mode, tok_s, draft_n, draft_acc, accept_rate`. Speedup = mtp tok_s ÷
baseline tok_s.

Notes: serial, single-GPU (one server at a time on `$PORT`); quick bench
(1 prompt, best-of-2, batch 1) matching the source post's "quick numbers". Under
the Claude Code harness it must run with the sandbox disabled (llama-server exec).
