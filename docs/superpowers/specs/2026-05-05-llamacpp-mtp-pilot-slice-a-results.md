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

## Update — 2026-05-06: re-bench under optimal Apple Silicon flags

The original Slice A bench did not pin `-ngl 999 --flash-attn on -ub 512`,
which the broader agentic-eval framework now treats as the canonical Apple
Silicon defaults. Re-ran vanilla and MTP under those flags on the same
(model, node) pair to check whether the verdict held.

| Metric | Vanilla (re-bench) | MTP (re-bench) | Ratio |
|---|---:|---:|---:|
| Mean decode tok/s | 11.7 | ~10.0 | **0.85x** |
| Aggregate wall (s) | 142.65 | 150.30 | 1.054x |
| Aggregate draft accept rate | n/a | 0.699 | — |

Numbers are within <1% of the original run. The verdict holds: MTP under
PR #22673 on M4 Pro Metal at Q4_K_M is ~15% slower than vanilla, with no
sensitivity to the tuning flags. Either Apple Silicon defaults already
cover those settings or the MTP per-step overhead dominates regardless.

Slice B stays abandoned. Re-evaluation triggers above remain the path forward.

## Update — 2026-05-10: re-pilot at PR head + froggeric recipe

Triggered by [r/LocalLLaMA post](https://www.reddit.com/r/LocalLLaMA/comments/1t57xuu/25x_faster_inference_with_qwen_36_27b_using_mtp/)
where `froggeric` reports **2.5×** decode on M2 Max 96 GB with Qwen 3.6 27B
+ PR #22673. Their recipe differs from this pilot in three observable ways:

1. PR head pinned to `5d5f1b46e4f56885801c86363d4677a5f72f83af` (2026-05-07)
   — five commits past our prior pin, including `86d9f15e` "fix double
   free" and `5d5f1b46` "fix: use rs for only MTP" — both targeting MTP
   memory issues.
2. Their MTP-converted GGUFs at `froggeric/Qwen3.6-27B-MTP-GGUF`
   (Q4_K_M / Q5_K_M / Q8_0 variants), claimed to differ from RDson's by
   the inclusion of 7 jinja chat-template fixes plus a different conversion
   pass.
3. Server flags: `--cache-type-k q8_0 --cache-type-v q8_0`, no
   `--flash-attn`, no `-ub 512` (defaults), `--temp 0.7 --top-k 20`.

Repro on this M4 Pro 48 GB box used:

- New PR head rebuild via `tools/llama-cpp-mtp/build.sh` after bumping
  `PINNED_SHA` to `5d5f1b46e4f56885801c86363d4677a5f72f83af`.
- New harness `tools/llama-cpp-mtp/bench-froggeric.sh` with the OP's flag
  set (q8_0 KV, no flash-attn, no `-ub` override). Bench client
  unchanged — `temperature=0` in the JSON request body, which overrides
  the server-side `--temp 0.7`. Decode tok/s should be temperature-insensitive
  for this comparison, so the override is acceptable.
- Models: pulled `Qwen3.6-27B-Q5_K_M-mtp.gguf` (20 GB) and
  `Qwen3.6-27B-Q8_0-mtp.gguf` (29 GB) from `froggeric/Qwen3.6-27B-MTP-GGUF`;
  reused the prior pilot's RDson `Qwen3.6-27B-MTP-Q4_K_M.gguf` (16 GB) on
  disk.

### Memory wall — Q5 / Q8 OOM on M4 Pro

Both Q5_K_M-mtp and Q8_0-mtp MTP runs deterministically OOM the Metal
working set on M4 Pro mid-decode. Server log memory breakdown:

```
MTL0 (Apple M4 Pro) | 38338 = ... + (29056 = 27690 + 870 + 495) + 28213
                                          model    ctx   compute   unaccounted
```

`unaccounted ≈ model size` is the smoking gun — PR #22673's MTP draft
path on Metal allocates an extra ~model-sized buffer on top of the
formally-tracked allocation. For Q4_K_M (16 GB) the doubled footprint
(32 GB) fits in the M4 Pro 38 GB Metal cap. For Q5_K_M (20 GB) it just
barely OOMs. For Q8_0 (29 GB) it can't possibly fit. Tested with
`-ub 512` on/off and `--flash-attn on`/off — neither moves the
breakdown numbers, the doubled allocation is structural to the MTP
path. The OP's M2 Max 96 GB has ~85 GB working set, which absorbs the
double easily.

### Q4_K_M still slower than vanilla (the verdict held)

| Metric | Vanilla | MTP (froggeric harness) | Ratio |
|---|---:|---:|---:|
| Aggregate decode tok/s | 11.9 | 10.0 | **0.84×** |
| Aggregate wall (s) | 127.34 | 149.97 | 1.18× |
| Aggregate draft accept rate | n/a | 0.701 | — |

Same shape, same magnitude as the 2026-05-05 and 2026-05-06 re-bench:
~15% slower than vanilla at 70% accept rate. The `-ctk q8_0 -ctv q8_0`
flag, the new PR head with the memory fixes, and froggeric's MTP-converted
GGUF do not change the M4 Pro outcome at the size that fits.

### Build flag check

Build flags match the OP's `cmake -B build -DGGML_METAL=ON
-DCMAKE_BUILD_TYPE=Release`, plus our two extras: `GGML_METAL_EMBED_LIBRARY=ON`
(embeds shader source, runtime-equivalent) and `LLAMA_CURL=ON` (URL fetch
in `llama-server`, no inference effect). CMake cache confirmed.

### Conclusion

The OP's 2.5× is **M2 Max-specific**:
- Apple9 GPU family, 38 cores, ~400 GB/s memory bandwidth (M2 Max)
  vs Apple10, 20 cores, ~273 GB/s (M4 Pro). The MTP overhead per
  decoded token is fixed cost; the speculative win is bandwidth-amortized.
  M4 Pro doesn't have the bandwidth headroom to make the trade
  positive.
- M2 Max 96 GB also tolerates the doubled-model allocation that OOMs
  M4 Pro 48 GB at Q5+.

PR #22673 is **not** a viable MTP path on M4 Pro 48 GB, regardless of
GGUF source / quant tier / flag set. The atomic-fork pilot
(`docs/superpowers/specs/2026-05-08-llamacpp-mtp-gemma4-pilot-design.md`)
remains the live thread for opt-in MTP on this hardware — its 1.27×
aggregate (1.39–1.48× on code prompts) on Gemma 4 26B-A4B at UD-Q4_K_XL
is the only positive M4 Pro result so far.

### Bench artifacts

- `$DEV_STORAGE/bench/mtp-froggeric/20260510T03*-{vanilla,mtp}-Qwen3.6-27B-MTP-GGUF_*.{json,server.log}`
  (Q4_K_M, Q5_K_M, Q8_0 × {vanilla, mtp, ub-on, flash-on permutations})

### Re-evaluation triggers (updated)

- A subsequent llama.cpp PR fixes the doubled-allocation behavior of
  MTP draft on Apple Metal pre-M5 GPUs, OR
- Tested on M2/M3 Max-class hardware where the bandwidth ratio favors
  the OP's reported numbers, OR
- A different MTP runtime ships (the atomic fork is one such
  candidate, already piloted).

## Update — 2026-05-11: root-cause and one-line fix

Pulled the source for PR #22673 at our pinned SHA `5d5f1b46` and
traced the doubled-allocation symptom in code. Final answer in 4
numbers from the server log:

```
load_tensors:  MTL0_Mapped model buffer size = 18760.13 MiB   # main model
load_tensors:  MTL0_Mapped model buffer size = 18760.13 MiB   # MTP "head", full duplicate
```

### Mechanism

1. The MTP head is loaded by reopening the same GGUF with
   `override_arch = qwen35_mtp[_moe]`
   (`tools/server/server-context.cpp:837`).
2. The MTP arch (`src/models/qwen35_mtp.cpp::load_arch_tensors`)
   registers tensors near both the start of the file (`tok_embd`) and
   the end (`output`, `nextn.*`, last transformer block).
3. With the default mmap-backed buffer path
   (`src/llama-model.cpp:1463-1483`), the backend allocates a single
   buffer spanning `[first_tensor_offset, last_tensor_offset)` of the
   GGUF — which for Qwen 3.6 27B covers nearly the entire file.
4. Apple Metal's `ggml_backend_dev_buffer_from_host_ptr` then uploads
   that entire range to a Metal-resident buffer, allocating a Metal
   duplicate of the main model.
5. The duplicate doesn't roll up into the target context's `self` in
   `common_memory_breakdown_print`
   (`common/fit.cpp:858-859`) because the MTP context lives in a
   sibling `llama_context`. It shows up as `unaccounted ≈ model_size`.

The mapping-range comment in `llama-model.cpp:1467-1469` even
documents the assumption — *"only the mmap region containing the
tensors in the model is mapped to the backend buffer"* — but for the
MTP arch's sparse-at-both-ends tensor selection, that region is the
entire file.

### Fix

One line in `tools/server/server-context.cpp` next to the MTP load:

```cpp
mparams_mtp.use_mmap = false;
```

This routes the MTP load through the non-mmap allocator path
(`llama-model.cpp:1492`, `ggml_backend_alloc_ctx_tensors_from_buft`),
which sizes the backend buffer to the **registered tensors** instead
of the mmap range. Patch saved at
`tools/llama-cpp-mtp/0001-mtp-mmap-fix.patch`. Filed upstream as
an inline suggestion on PR #22673 at
[server-context.cpp:835](https://github.com/ggml-org/llama.cpp/pull/22673#discussion_r3218133274)
(the separate PR #22941 was closed by a maintainer with the note that
single-line fixes should be discussed on the source PR — agreed and
re-posted accordingly).

### Numbers post-fix (M4 Pro 48 GB, atomic-llama-cpp-turboquant
unaffected since this fix is for PR #22673 only)

| Quant | Metal MTP buf pre-fix | Metal MTP buf post-fix | Reduction |
|---|---:|---:|---:|
| Q5_K_M-mtp (19 GB file) | 18 760 MiB | 1 425 MiB | **13.2×** |
| Q8_0-mtp   (29 GB file) | 28 213 MiB | 1 719 MiB | **16.4×** |

Aggregate decode tok/s with the OP's recipe
(`--cache-type-k q8_0 --cache-type-v q8_0`, no flash-attn,
default `ub`), 9-prompt suite, `temperature=0 seed=42 n_predict=192`:

| Quant | Vanilla | MTP (post-fix) | Ratio | Accept |
|---|---:|---:|---:|---:|
| Q4_K_M | 11.9 | 10.0 | 0.85× | 0.701 |
| Q5_K_M |  9.5 |  8.6 | 0.91× | 0.713 |
| Q8_0   |  7.4 | 11.1 | **1.49×** | **0.725** |

Q4_K_M unchanged from the pre-fix bench — no regression on the case
that already fit. Q5 and Q8 are new datapoints since both OOM'd
pre-fix. **Q8_0 clears the 1.4× gate** on M4 Pro — first positive PR
#22673 result on Apple10 hardware. Per-prompt range on Q8 is
1.26×–1.82× (code/math 1.6×–1.8×, translation/creative 1.3×).

### Verdict update

PR #22673 + the one-line fix is **viable on M4 Pro 48 GB for Q8_0
specifically** — the largest quant that fits inflicts the heaviest
main-pass cost, which is what the speculative path saves. Q4/Q5 still
fall below the gate (per-token MTP overhead exceeds the saved passes
on M4 Pro at smaller quants).

Re-trigger fully cleared if PR #22941 lands in #22673 or if a
follow-up reduces the speculative per-token overhead enough for
Q4/Q5 to also clear the gate.
