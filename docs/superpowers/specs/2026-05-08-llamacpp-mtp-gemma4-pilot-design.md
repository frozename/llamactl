# llama.cpp MTP pilot — Gemma 4 via atomic-llama-cpp-turboquant

Date: 2026-05-08
Status: draft, awaiting review

## Background

The prior MTP pilot (2026-05-05) closed at **0.85× decode** on Apple Silicon
Metal with PR #22673 + Qwen 3.6 27B Q4_K_M, well below the 1.4× gate. That
pilot's memory explicitly flagged Gemma 4 as needing a different runtime
(KV-share + centroid embedder) not yet present in upstream llama.cpp.

`AtomicBot-ai/atomic-llama-cpp-turboquant` is a llama.cpp fork that adds:

- **TurboQuant** — Walsh–Hadamard rotated quantization for KV cache and weights
  (e.g. `-ctk turbo3 -ctv turbo3`).
- **Gemma 4 MTP** via an in-context assistant head architecture
  (`gemma4_assistant`), packaged separately from the base GGUF and consumed
  through a `--mtp-head <file>` flag.

The fork's README claims **109.5 vs 81.5 tps decode at seq 128 on Metal for
Gemma 4 26B (≈1.34×)** with 85.9% accept rate — close enough to the prior
pilot's 1.4× gate to justify a real bench on this hardware before deciding.

The fork is actively developed; the `feature/turboquant-kv-cache` default
branch is 454 commits ahead of the most recent macOS-arm64 release tag
(`turboquant-macos-arm64-f57a573`, 2026-04-04). For this pilot we pin to
HEAD-of-default at the time of writing — `2e81dc5f` (2026-05-07).

## Goal

Bench Gemma 4 26B-A4B vanilla vs MTP on the M4 Pro control plane (`local`)
using the atomic fork. Apply the same 1.4× decode gate as the prior pilot.
On pass, wire an opt-in `decoding: mtp` workload variant for Gemma 4 on
`local`. On fail, document and stop.

## Non-goals

- No upstream llama.cpp contribution (the fork is the upstream we care about).
- No conversion harness — both base and assistant are pulled pre-quantized
  from Hugging Face.
- No mac-mini 16G coverage in Slice A. Gemma 4 E2B/E4B + assistant on the
  mac-mini is a follow-up if Slice A passes for the M4 Pro.
- No default-on routing. MTP stays explicit per workload.
- TurboQuant weight quantization (3–4 bit WHT-rotated weights) is out of
  scope; we benchmark the upstream-style Q4_K_M base. Only the KV-cache
  TurboQuant flags (`-ctk turbo3 -ctv turbo3`) are exercised, because the
  fork's recommended Gemma 4 MTP invocation includes them.

## Hardware fit

| Node    | Profile                  | Models in scope                                                                                                                      | Sizing                                                                           |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `local` | macbook-pro-48g (M4 Pro) | `gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf` (base, ~17 GB, on disk) + `AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF` Q4_K_M (head, ~310 MB) | Comfortable headroom — 26B-A4B is MoE with 4B active; KV at turbo3 stays compact |

26B-A4B is selected over 31B dense because the fork's published bench
datapoint (1.34×) is on this exact size class, and 31B dense is borderline
for 48 GB once context + KV are accounted for.

### Quant-tier deviation from the published bench

The fork's reported 1.34× datapoint is on Q4*K_M-class. The closest
unsloth file on disk is `gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf`
(unsloth-dynamic, slightly higher quality / ~1 GB larger than the
equivalent UD-Q4_K_M). Decision: reuse the on-disk file and avoid a
~16 GB download. The MTP-vs-vanilla ratio we are gating on is invariant
to the precise main-model quant tier within Q4_K*\*, since both legs of
the bench load the same base. The deviation will be called out in the
results doc, and `download.sh --base` is available to pull
`gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` if a strict reproduction is needed.

## Architecture

Side-by-side fork build, side-by-side model storage, parallel env vars:

- Vanilla path remains unchanged (`LLAMA_CPP_BIN`, upstream llama.cpp on
  `main`).
- Atomic fork path uses parallel binary (`LLAMA_CPP_BIN_ATOMIC`) under
  `$DEV_STORAGE/src/llama.cpp-atomic`.
- Both vanilla baseline AND MTP runs use the **fork's binary** so any
  perf delta is attributable to MTP only — not to fork-vs-upstream
  build differences. Upstream `LLAMA_CPP_BIN` is not used in this pilot.
- Models pulled via `tools/llama-cpp-mtp-atomic/download.sh`:
  - Base: `unsloth/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf`
  - Head: `AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF/gemma-4-26B-A4B-it-assistant.Q4_K_M.gguf`
- The prior pilot tree under `tools/llama-cpp-mtp/` is preserved unchanged
  for reproducibility.

## Recommended invocation (from upstream)

Captured verbatim from the AtomicChat README so we can confirm flag
parity in our harness:

```
llama-server \
  -m         <base>.Q4_K_M.gguf \
  --mtp-head <assistant>.Q4_K_M.gguf \
  --spec-type mtp \
  --draft-block-size 3 --draft-max 8 --draft-min 0 \
  -ngl 99 -ngld 99 \
  -ctk turbo3 -ctv turbo3 -ctkd turbo3 -ctvd turbo3 \
  -fa on -c 16384
```

The vanilla baseline run uses the same binary with **no** `--mtp-head` /
`--spec-type` / `-ngld` / `-ctkd` / `-ctvd` flags. KV cache for the vanilla
run uses `-ctk turbo3 -ctv turbo3` to keep the comparison apples-to-apples
with the MTP run's main-model KV; the only varying axis is the speculative
decoding path.

## Two slices

| Slice | Deliverable                                                                                       | Gate to next                                                                       |
| ----- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A     | Atomic fork build + Gemma 4 26B-A4B base + assistant head + bench vs vanilla on `local`           | Decode speedup ≥ **1.4×** for short-chat AND no prefill regression worse than 0.9× |
| B     | Opt-in `decoding: mtp` workload wiring for Gemma 4 on `local` + `chat-mtp-gemma4-local` composite | —                                                                                  |

### Slice A — validation and benchmark

Deliverables:

1. Side-by-side fork tree at `$DEV_STORAGE/src/llama.cpp-atomic` built with
   Metal, `gemma4_assistant` arch enabled.
2. Idempotent download harness (`download.sh`) that pulls base + assistant
   into `$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF/` and
   `$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-assistant-GGUF/`.
3. Bench harness (`bench.sh`) parametric on `vanilla|mtp`, threading
   `--mtp-head` and TurboQuant KV flags through.
4. Two bench runs (vanilla + MTP) with results emitted as JSON under
   `$DEV_STORAGE/bench/mtp-gemma4-pilot/`.
5. Slice-A results doc with go/no-go recommendation.

Bench profiles (carry over from prior pilot):

- Short-chat (decode-focused, ctx 8192, n_predict 256)
- Long-prompt (prefill sensitivity, 4 KB prompt, n_predict 64)

Captured per run: decode tps, prefill tps, TTFT, RSS, draft accept rate
(MTP only).

### Slice B — opt-in workload flag

Triggered only if Slice A passes.

Schema and routing:

- Workload gains optional `mtpHead: string` (rel under `LLAMA_CPP_MODELS`).
- Workload keeps `decoding: mtp | vanilla` (default `vanilla`).
- Catalog gains `gemma4-26b-a4b-q4m` with:
  - `rel = unsloth/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf`
  - `mtpHeadRel = AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF/gemma-4-26B-A4B-it-assistant.Q4_K_M.gguf`
- Spawn path on `decoding: mtp` appends:
  - `--mtp-head <models>/<mtpHeadRel>`
  - `--spec-type mtp`
  - `--draft-block-size 3 --draft-max 8 --draft-min 0`
  - `-ngld 99 -ctkd turbo3 -ctvd turbo3` (draft engine flags)
  - `-ctk turbo3 -ctv turbo3` (main KV)
- The runtime env for MTP-flagged workloads sets `LLAMA_SERVER_BIN` to
  `LLAMA_CPP_BIN_ATOMIC`. Vanilla workloads keep upstream binary unchanged.

Composite target: `chat-mtp-gemma4-local` (M4 Pro).

## Cross-repo impact

- `llamactl` only.
- No required source changes in `sirius-gateway` or `embersynth` for
  Slice A. Slice B may surface a new model in the leaderboard, which is
  consumed via existing routing, no client changes required.

## Reversibility

Fully reversible:

- Remove `LLAMA_CPP_SRC_ATOMIC` / `LLAMA_CPP_BIN_ATOMIC`.
- Remove downloaded base + assistant GGUF directories.
- Flip any `decoding: mtp` workloads back to `vanilla`.
- Catalog rollback is a single entry removal.

## Open questions

- The fork's macOS arm64 binary release tag is over a month behind
  default. If the HEAD-pinned build fails to compile on the user's
  toolchain (Xcode SDK / cmake / Metal SDK), fall back to the
  `turboquant-macos-arm64-f57a573` release tag (still has the
  `gemma4_assistant` arch per the README, just older).
- TurboQuant's `-ctk turbo3` value is documented in the fork's docs but
  the exact KV memory savings vs `q8_0` aren't published. Capture peak
  RSS in the bench output to characterize this empirically.
- The upstream report of 1.34× is at seq 128; long-context behavior on
  M4 Pro is unknown. If short-chat passes the gate but long-prompt does
  not, the workload variant should still ship for short-chat regimes.
