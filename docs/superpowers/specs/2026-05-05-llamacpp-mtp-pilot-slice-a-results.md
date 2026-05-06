# llama.cpp MTP pilot — Slice A results

Date: 2026-05-05
PINNED_SHA: `17df5830e72b82841ba6d6c9570fcb31c14da327` (PR #22673 head)
Hardware: M4 Pro 48 GB (control plane `local`), Metal backend
Model: Qwen 3.6 27B dense, Q4_K_M
- Vanilla baseline: `unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q4_K_M.gguf` (16 GB)
- MTP variant: `RDson/Qwen3.6-27B-MTP-Q4_K_M-GGUF/Qwen3.6-27B-MTP-Q4_K_M.gguf` (15 GB)

## Method

- `tools/llama-cpp-mtp/bench.sh` spawns `llama-server` (vanilla or MTP
  binary) with `--ctx-size 8192 --no-warmup -np 1`, waits for `/health`,
  then runs `tools/llama-cpp-mtp/bench-client.py` against `/completion`.
- Bench client: 9 prompts (mixed code/explanation/translation/QA/long
  review), `n_predict=192`, `temperature=0`, `seed=42`, `cache_prompt=false`,
  non-streaming. Captures `predicted_per_second` and `draft_n` /
  `draft_n_accepted` from server timings.
- MTP-mode args: `--spec-type mtp --spec-draft-n-max 3`. No `--model-draft`
  — MTP heads are embedded in the same GGUF (Qwen pattern).
- Each (vanilla, MTP) pair benched twice back-to-back to verify
  reproducibility. Numbers below are from the second pair; first pair was
  within <1% on every prompt.
- All bench JSON artifacts under `$DEV_STORAGE/bench/mtp-pilot/`.

## Results

| Metric | Vanilla | MTP | Ratio |
|---|---:|---:|---:|
| Mean decode tok/s | 11.78 | 10.03 | **0.85x** |
| Aggregate wall (s) | 142.09 | 149.68 | 1.053x |
| Total predicted tokens | 1582 | 1421 | — |
| Total draft tokens | 0 | 1365 | — |
| Aggregate draft accept rate | n/a | 0.699 | — |

Per-prompt vanilla vs MTP decode tok/s:

| Prompt | Vanilla tps | MTP tps | MTP/Vanilla | MTP accept rate |
|---|---:|---:|---:|---:|
| code_python | 11.64 | 10.77 | 0.93x | 0.76 |
| code_cpp | 11.64 | 10.35 | 0.89x | 0.72 |
| explain_concept | 11.64 | 9.46 | 0.81x | 0.63 |
| summarize | 11.91 | 10.33 | 0.87x | 0.73 |
| qa_factual | 11.85 | 10.19 | 0.86x | 0.72 |
| translation | 11.84 | 8.97 | 0.76x | 0.54 |
| creative_short | 11.84 | 9.00 | 0.76x | 0.59 |
| stepwise_math | 11.85 | 10.71 | 0.90x | 0.76 |
| long_code_review | 11.84 | 10.48 | 0.89x | 0.75 |

## Gate evaluation

For the single pair `local × qwen36-27b-q4m`:

| Spec criterion | Threshold | Measured | Verdict |
|---|---|---|---|
| Short-chat decode | >= 1.4x vanilla | 0.85x vanilla | **FAIL** |
| Long-prompt wall-clock | <= 1.1x vanilla | 1.053x vanilla | pass |
| Peak RSS within node budget | <= 48 GB | ~16 GB model + KV | pass |

**Pair decision:** drop. Decode-throughput criterion fails by a wide margin
(MTP is ~15% slower than vanilla, not 40% faster).

## Slice B scope

Pairs to wire into Slice B: none.
Catalog entries gaining `mtpRel`: none.

**Slice B is abandoned per the spec's "abandon Slice B entirely if zero
pairs pass" rule.** No catalog, schema, server, nodeFacts, workload, apply,
or composite changes are made for MTP at this time.

## Why MTP underperformed here

Acceptance rate is healthy (~70% mean, peaking at 76%), so the MTP heads
are predicting accurately. The shortfall is per-forward-pass cost: the
MTP-aware llama-server pays a meaningful overhead per draft generation +
verify cycle that overwhelms the speculative-decoding benefit on this
hardware/quant combination.

Reference comparison: PR #22673's author benched on a DGX Spark (NVIDIA
GPU) at Q8_0 and reported >2x speedup at similar acceptance rates. Our
result on M4 Pro Metal at Q4_K_M is the inverse. Plausible contributors:

- Metal MTP path is less optimised than the CUDA path. The PR's earliest
  revisions targeted CUDA; Metal support landed late and may not have the
  same kernel coverage.
- Q4_K_M-specific Metal kernels for the MTP head ops may not exist; the
  runtime may fall back to slower paths for those tensors.
- Apple Silicon's unified memory model amortises MTP overhead differently
  than discrete-GPU systems where draft-token verification benefits from
  parallel KV-cache reads off-device.

## Reversibility

Slice A produced no committed code that affects production paths. The
side-by-side MTP build tree, downloaded GGUFs, and bench JSONs are local
artifacts. To remove fully:

```
rm -rf "$LLAMA_CPP_SRC_MTP" \
       "$LLAMA_CPP_MODELS/Qwen3.6-27B-MTP-GGUF" \
       "$DEV_STORAGE/bench/mtp-pilot"
```

The committed scripts (`tools/llama-cpp-mtp/{build,download,bench,bench-client.py}.sh`)
and PINNED_SHA can stay — they're cheap to keep and form the basis for a
future re-evaluation.

## Re-evaluation triggers

Re-run this pilot when any of the following lands upstream:

- llama.cpp master merges PR #22673 (or successor) with optimised Metal
  kernels for MTP head ops at K-quants.
- A different speculative-decoding scheme (EAGLE3, FastMTP, etc.) ships
  for Metal with a published Apple Silicon benchmark showing >=1.4x decode.
- A KV-share Gemma 4 MTP runtime path lands and we want to re-evaluate
  with the official Google drafters (which would unblock smaller-model
  coverage on mac-mini class nodes).

Until then, MTP stays out of the fleet.
