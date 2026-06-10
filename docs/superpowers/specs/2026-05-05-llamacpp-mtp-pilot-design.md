# llama.cpp MTP pilot — design

Date: 2026-05-05
Status: draft, awaiting review

## Background

llama.cpp PR #22673 adds Multi-Token Prediction (MTP) for the Qwen pattern
where MTP heads are embedded in the same GGUF as the target model. The pinned
PR SHA for this pilot is `17df5830e72b82841ba6d6c9570fcb31c14da327`.

During validation, two blockers were confirmed for Gemma 4 in this PR line:

- `convert_hf_to_gguf.py` does not register `Gemma4AssistantForCausalLM`.
- Runtime support for `gemma4_assistant` is absent in the PR tree.

The PR comment thread also calls out that Gemma 4 MTP needs a different runtime
shape (shared KV cache + centroid-style embedder), so Gemma 4 support requires
additional upstream work beyond #22673.

## Goal

Run a single-node MTP pilot on the M4 Pro control plane (`local`) using
Qwen 3.6 27B dense only, and decide whether to keep an opt-in MTP path based on
bench evidence.

## Non-goals

- No Gemma 4 MTP conversion path in this pilot.
- No mac-mini 16G MTP coverage in this pilot.
- No default-on routing. MTP stays explicit per workload.
- No upstream llama.cpp contributions.

## Hardware fit

| Node    | Profile                  | Models in scope                                                     | Fit                  |
| ------- | ------------------------ | ------------------------------------------------------------------- | -------------------- |
| `local` | macbook-pro-48g (M4 Pro) | `qwen36-27b-q4m` (vanilla, ~17 GB) + `qwen36-27b-mtp` (MTP, ~17 GB) | Comfortable headroom |

### Why 27B dense and not 35B-A3B?

The MoE 35B-A3B MTP repo (`am17an/Qwen3.6-35BA3B-MTP-GGUF`) only ships a
37.8 GB BF16 file with no quantised variants. That's tight to bench on a 48 GB
node once KV cache and OS overhead are accounted for, and self-quantising
doubles turnaround (download 37.8 GB → quantise → discard). The 27B dense
lineage has a Q4_K_M MTP build (16.5 GB) from `RDson`, validated by their
sibling `RDson/Qwen3.6-27B-MTP-IQ4_KS-GGUF` repo (~20k downloads). The
existing catalog entry `qwen36-q4m` (35B-A3B MoE, unsloth Q4_K_M) stays
untouched — no MTP variant exists upstream for it as of 2026-05-05.

## Architecture

Side-by-side binary, side-by-side model storage:

- Vanilla path remains unchanged (`LLAMA_CPP_BIN`).
- MTP path uses parallel binary (`LLAMA_CPP_BIN_MTP`) from the pinned PR tree.
- Model acquisition uses `tools/llama-cpp-mtp/download.sh`, which pulls the
  vanilla baseline (`unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q4_K_M.gguf`) and
  the MTP variant (`RDson/Qwen3.6-27B-MTP-Q4_K_M-GGUF/Qwen3.6-27B-MTP-Q4_K_M.gguf`)
  into `LLAMA_CPP_MODELS/Qwen3.6-27B-GGUF/` and
  `LLAMA_CPP_MODELS/Qwen3.6-27B-MTP-GGUF/` respectively.

No conversion harness is part of this pilot.

## Two slices

| Slice | Deliverable                                                            | Gate to next                                                                |
| ----- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A     | MTP build + one downloaded Qwen MTP GGUF + bench vs vanilla on `local` | Decode speedup >= 1.4x for short-chat and acceptable long-prompt wall-clock |
| B     | Opt-in `decoding: mtp` workload wiring for Qwen on `local`             | —                                                                           |

### Slice A — validation and benchmark

Deliverables:

1. Build side-by-side MTP binary tree from pinned PR SHA.
2. Download harness (`download.sh`) for pre-built MTP GGUFs.
3. Acquire two models: `qwen36-27b-q4m` (vanilla baseline) and `qwen36-27b-mtp` (MTP variant).
4. Bench harness runs vanilla vs MTP on one `(node, model)` pair only.
5. Results doc with go/no-go recommendation.

Bench structure is unchanged from the original pilot design:

- Short-chat profile (decode-focused)
- Long-prompt profile (prefill sensitivity)
- Capture decode throughput, prefill throughput, TTFT, and RSS

### Slice B — opt-in workload flag

Triggered only if Slice A passes for the single in-scope pair.

Schema and routing shape:

- Workload keeps `decoding: mtp | vanilla` (default `vanilla`).
- Catalog gains a new entry `qwen36-27b-q4m` with `rel` pointing at the vanilla
  baseline and `mtpRel` pointing at the MTP variant. Existing `qwen36-q4m`
  (35B-A3B MoE) remains MTP-less.
- `mtpDrafterRel` is optional and not required for Qwen embedded-head MTP.
- Spawn path on `decoding: mtp` appends:
  - `--spec-type mtp`
  - `--spec-draft-n-max 3`
- `--model-draft` is appended only when a non-empty drafter path exists.

Composite target for this pilot is `chat-mtp-local` (M4 Pro).

## Deferred from this pilot

As of 2026-05-05, this pivot intentionally defers:

- Gemma 4 MTP: blocked on upstream runtime/conversion work not present in
  llama.cpp PR #22673.
- mac-mini 16G MTP: no compatible smaller MTP-capable Qwen model is available
  upstream, and current Qwen 3.6 MTP artifacts exceed that node class.

Revisit when either of the following ships upstream:

- Gemma 4 KV-share MTP runtime path in llama.cpp.
- A smaller Qwen MTP-capable model artifact suitable for 16G class nodes.

## Cross-repo impact

- `llamactl` only.
- No required source changes in `sirius-gateway` or `embersynth` for Slice A.

## Reversibility

Fully reversible:

- Remove `LLAMA_CPP_SRC_MTP` / `LLAMA_CPP_BIN_MTP`.
- Remove downloaded MTP GGUF(s).
- Flip any `decoding: mtp` workloads back to `vanilla`.

## Open questions

None. Prior open questions are closed by the Qwen-only single-node pivot.
