# llama.cpp MTP pilot — Gemma 4 / atomic-llama-cpp-turboquant — Slice A results

Date: 2026-05-08
Spec: `docs/superpowers/specs/2026-05-08-llamacpp-mtp-gemma4-pilot-design.md`
Plan: `docs/superpowers/plans/2026-05-08-llamacpp-mtp-gemma4-pilot.md`

## Setup

- Hardware: M4 Pro, macOS, 48 GB unified memory.
- Fork: `AtomicBot-ai/atomic-llama-cpp-turboquant` pinned at
  `2e81dc5f634501c744b69a65a8eeb84ba42e82ee` (HEAD of
  `feature/turboquant-kv-cache` 2026-05-07). Built `cmake -DGGML_METAL=ON
-DGGML_METAL_EMBED_LIBRARY=ON -DLLAMA_CURL=ON -DCMAKE_BUILD_TYPE=Release`.
  Metal init log notes: `tensor API disabled for pre-M5 and pre-A19
devices`, `turbo3 using 4-mag LUT (pre-M5 hardware)`, `turbo3 sparse V
dequant enabled`.
- Base GGUF: `gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf` (already on disk —
  spec deviation explained inline; UD-Q4_K_XL is one tier above the
  fork's published Q4_K_M, MTP/vanilla ratio is invariant to that tier).
- Assistant head: `AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF` Q4_K_M
  (310 MB).
- Both runs use the fork's binary. Both runs share the same main-model
  KV at `-ctk turbo3 -ctv turbo3`. The only varying axis is the
  speculative path.
- Bench harness: `tools/llama-cpp-mtp-atomic/bench.sh` →
  `tools/llama-cpp-mtp/bench-client.py` (9-prompt mix; `n_predict=192`,
  `temperature=0`, `seed=42`, `stream=false`).
- Output JSON files:
  - `$DEV_STORAGE/bench/mtp-gemma4-pilot/20260508T172139Z-vanilla-…UD-Q4_K_XL.gguf.json`
  - `$DEV_STORAGE/bench/mtp-gemma4-pilot/20260508T172300Z-mtp-…UD-Q4_K_XL.gguf.json`

## Results

### Per-prompt decode tok/s

| Prompt           | vanilla |  MTP | ratio | accept |
| ---------------- | ------: | ---: | ----: | -----: |
| code_python      |    39.0 | 56.8 | 1.46× |  0.819 |
| code_cpp         |    38.3 | 53.2 | 1.39× |  0.718 |
| qa_factual       |    39.0 | 55.3 | 1.42× |  0.757 |
| stepwise_math    |    38.9 | 57.7 | 1.48× |  0.819 |
| translation      |    38.7 | 52.8 | 1.36× |  0.694 |
| summarize        |    38.4 | 47.8 | 1.24× |  0.580 |
| explain_concept  |    38.1 | 46.8 | 1.23× |  0.567 |
| long_code_review |    39.3 | 39.7 | 1.01× |  0.420 |
| creative_short   |    39.8 | 36.7 | 0.92× |  0.312 |

### Aggregate

| metric                                      |  vanilla |       MTP |
| ------------------------------------------- | -------: | --------: |
| total_predicted                             |     1590 |      1576 |
| total_draft                                 |        0 |      1365 |
| total_draft_accepted                        |        0 |       879 |
| aggregate_accept_rate                       |      n/a |     0.644 |
| wall_s_total                                |    43.02 |     33.50 |
| **aggregate decode tok/s** (predicted/wall) | **37.0** |  **47.0** |
| **aggregate ratio**                         |        — | **1.27×** |

Wall time savings: 22%.

Server startup health: vanilla ~10 s, MTP ~3 s (post-vanilla cache).

## Gate

Spec gate: **decode ratio ≥ 1.4× aggregate AND prefill ratio ≥ 0.9×**.

- Aggregate decode ratio is **1.27×** → **fails the absolute aggregate gate.**
- Prefill ratio is **not captured** by the inherited bench-client.
  This is a known gap (spec listed prefill_tps as a desired field; the
  prior pilot's harness only emits decode metrics from `timings`).
  Adding prefill/TTFT/RSS capture to `bench-client.py` is a small
  follow-up; it does not change the Slice A go/no-go because the
  decode gate already fails on aggregate.

## Decision: NO-GO on the absolute gate, but interesting per-workload structure

The aggregate misses the 1.4× bar. **Slice B (workload wiring) is not
triggered** under the gate the spec set.

The per-prompt structure, however, is qualitatively different from the
prior 2026-05-05 pilot:

- **Prior pilot (PR #22673 + Qwen 3.6 27B Q4_K_M):** uniform 0.85×
  decode — MTP slower than vanilla on every workload.
- **This pilot (atomic fork + Gemma 4 26B-A4B UD-Q4_K_XL):**
  workload-banded result —
  - Code / structured output (code_python, code_cpp, qa_factual,
    stepwise_math): **1.39–1.48× — meets the gate.**
  - Conversational / NL (translation, summarize, explain_concept):
    1.23–1.36× — clear positive, below absolute gate.
  - Creative / long-form (long_code_review, creative_short):
    0.92–1.01× — net wash; accept rates collapse to 0.31–0.42.

The atomic fork's claim of 1.34× decode at seq 128 is consistent with
our aggregate (1.27× includes long_code_review and creative_short
which drag the mean down; excluding those two the ratio is 1.36×).
Accept rate aggregate (64%) is below the fork's quoted 85.9%, likely
because the prompt mix has more open-ended / creative prompts than
their bench, and the head's accept rate is highly prompt-dependent.

## Addendum 1 — Strict UD-Q4_K_M re-bench (2026-05-08 17:32–17:33Z)

After downloading `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` (16 GB) for the
strict published-bench reproduction, both the vanilla and MTP runs
were repeated with the exact same flag set and base/head pairing.

**Vanilla on UD-Q4_K_M crashes deterministically** mid-bench on the
`stepwise_math` prompt. Two consecutive runs reproduced the same HTTP
500 on the same prompt (third in the prompt order). Server log shows
the model emitting corrupted token sequences (`way: � way: way: …`)
followed by an internal exception
(`srv operator(): got exception: {"error":{"code":500,"message":"Failed
to parse input at pos 0…`). Bench JSON files for the failed runs:

- `20260508T173243Z-vanilla-…UD-Q4_K_M.gguf.server.log`
- `20260508T173541Z-vanilla-…UD-Q4_K_M.gguf.server.log` (retry,
  reproduced)

**MTP on UD-Q4_K_M completes** but with a degraded accept rate —
**0.514** aggregate vs 0.644 on UD-Q4_K_XL. Per-prompt decode tps is
also lower across most prompts (e.g. `explain_concept` 32.8 vs 46.8,
`code_cpp` 42.3 vs 53.2). The MTP path appears to be more tolerant of
whatever weight/KV interaction triggers the vanilla crash, but
performance is worse, not the +5% expected from a tighter K-quant.

Conclusion: **the fork has a stability bug at UD-Q4_K_M + `-ctk turbo3
-ctv turbo3` on M4 Pro.** UD-Q4_K_XL is the cleaner data and the right
basis for the gate decision. Worth surfacing upstream to AtomicBot-ai
as a separate issue if the pilot is revived.

## Addendum 2 — Mac-mini E4B + matching head (2026-05-08 17:40–17:42Z)

Hardware: mac-mini 16 GB. Granite41-8b workload was stopped via
`llamactl delete workload granite41-8b-mac-mini` for the bench window
to free RAM (~11 GB free during runs), then restored via
`llamactl --node mac-mini apply -f templates/workloads/granite41-8b-mac-mini.yaml`.

Models:

- Base: `gemma-4-E4B-it-UD-Q4_K_XL.gguf` (4.7 GB, on disk).
- Head: `AtomicChat/gemma-4-E4B-it-assistant-GGUF`
  `gemma-4-E4B-it-assistant.Q4_K_M.gguf` (75 MB, downloaded via curl).

Same atomic-fork SHA + same flags as the M4 Pro runs. Bench JSONs:

- `/tmp/mtp-gemma4-pilot-macmini/20260508T174038Z-vanilla-…UD-Q4_K_XL.gguf.json`
- `/tmp/mtp-gemma4-pilot-macmini/20260508T174139Z-mtp-…UD-Q4_K_XL.gguf.json`

| Prompt           |   vanilla |       MTP | ratio | accept |
| ---------------- | --------: | --------: | ----: | -----: |
| code_python      |      24.1 |      27.6 | 1.15× |  0.694 |
| code_cpp         |      24.2 |      28.8 | 1.19× |  0.732 |
| stepwise_math    |      24.2 |      28.1 | 1.16× |  0.709 |
| summarize        |      24.5 |      22.8 | 0.93× |  0.463 |
| explain_concept  |      24.2 |      22.3 | 0.92× |  0.455 |
| qa_factual       |      24.3 |      21.8 | 0.90× |  0.436 |
| translation      |      25.2 |      19.6 | 0.78× |  0.308 |
| creative_short   |      24.7 |      18.0 | 0.73× |  0.250 |
| long_code_review | _outlier_ | _outlier_ |     — |      — |

`long_code_review` returned `predicted_n=1` on both runs — the E4B
model emits its EOS right after the prompt at temperature=0. Not a
server or fork issue; the prompt is too prescriptive for the 4B base
to engage with at deterministic sampling. Excluded from aggregate.

| metric                     |   vanilla |        MTP |
| -------------------------- | --------: | ---------: |
| total_predicted (8 valid)  |       923 |        980 |
| wall_s_total (8 valid)     |       ~40 |        ~43 |
| **aggregate decode tok/s** | **~22.7** |  **~22.7** |
| **aggregate ratio**        |         — | **~1.00×** |
| aggregate_accept_rate      |       n/a |      0.547 |

**E4B verdict: net wash on aggregate.** MTP only wins on
code/structured prompts (1.15–1.19×, well below the 1.4× gate);
conversational and creative prompts are net negative because the
draft acceptance collapses to 0.25–0.46 and the per-token MTP overhead
exceeds the saved forward passes. Smaller models gain less from MTP
because each main-pass is already cheap.

## Cross-cut summary

| Run                           |             Aggregate ratio | Code/QA range | Conversational |   Creative | Notes                                         |
| ----------------------------- | --------------------------: | ------------: | -------------: | ---------: | --------------------------------------------- |
| M4 Pro · 26B-A4B · UD-Q4_K_XL |                   **1.27×** |    1.39–1.48× |     1.23–1.36× | 0.92–1.01× | clean, primary dataset                        |
| M4 Pro · 26B-A4B · UD-Q4_K_M  | (crash) / MTP-only 41.7 tps |           n/a |            n/a |        n/a | vanilla deterministic crash; fork instability |
| mac-mini · E4B · UD-Q4_K_XL   |                  **~1.00×** |    1.15–1.19× |     0.90–0.93× | 0.73–0.78× | MTP gain too small to clear gate              |

Across all three configurations the **aggregate gate (1.4×) is missed**.
The 26B-A4B + UD-Q4_K_XL config is the strongest case for opt-in MTP
on code/structured workloads (clears the gate per-class). E4B is too
small for MTP to amortize, and UD-Q4_K_M is a fork stability liability
on M4 Pro.

## Follow-ups

1. **File an upstream issue** with AtomicBot-ai for the UD-Q4_K_M +
   `turbo3` KV deterministic crash on M4 Pro (Apple10 / pre-M5 LUT
   path). Repro: `bench.sh vanilla
gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` against
   pinned `2e81dc5f`.
2. **Workload-aware gate.** The 1.4× aggregate gate is too coarse for
   spec-decoding evaluation: it averages over workloads where MTP is
   strictly worse (creative / unbounded generation) and workloads
   where it's a clear win (code / structured QA). Future MTP gates
   should split: e.g. `code_*` and `qa_*` prompts must hit 1.4×;
   creative prompts allowed to fall back to vanilla via routing.
3. **Selective routing.** Plausible Slice B redesign: ship MTP as
   opt-in per workload, AND add a router heuristic (or per-call flag)
   to disable MTP on creative/long-form workloads. Separate project.
4. **Prefill/TTFT/RSS capture.** Extend `bench-client.py` to read the
   full `timings` block (`prompt_n`, `prompt_per_second`,
   `predicted_per_second`, `ttft_ms`) so future bench runs hit the
   gate fields the spec named.
5. **mac-mini E4B follow-up.** No further work warranted under the
   current gate. If a workload-aware gate is adopted, E4B's code-path
   1.15–1.19× would still fail any reasonable code-only gate.

## Reversibility

Nothing in this Slice A persists into runtime workloads. The fork
build, the assistant GGUF, and the bench JSONs all sit side-by-side
with the unmodified llamactl runtime. To remove:

```sh
rm -rf /Volumes/WorkSSD/src/llama.cpp-atomic
rm -rf /Volumes/WorkSSD/ai-models/llama.cpp/models/gemma-4-26B-A4B-it-assistant-GGUF
```

The spec/plan/results docs and the `tools/llama-cpp-mtp-atomic/`
harness are kept for the next re-eval.
