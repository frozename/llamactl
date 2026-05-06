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
Qwen 3.6 35B-A3B only, and decide whether to keep an opt-in MTP path based on
bench evidence.

## Non-goals

- No Gemma 4 MTP conversion path in this pilot.
- No mac-mini 16G MTP coverage in this pilot.
- No default-on routing. MTP stays explicit per workload.
- No upstream llama.cpp contributions.

## Hardware fit

| Node | Profile | Model in scope | Fit |
|---|---|---|---|
| `local` | macbook-pro-48g (M4 Pro) | `qwen36-mtp` | In scope for pilot |

## Architecture

Side-by-side binary, side-by-side model storage:

- Vanilla path remains unchanged (`LLAMA_CPP_BIN`).
- MTP path uses parallel binary (`LLAMA_CPP_BIN_MTP`) from the pinned PR tree.
- Model acquisition uses `tools/llama-cpp-mtp/download.sh`, which pulls a
  pre-built MTP GGUF from `am17an/Qwen3.6-35BA3B-MTP-GGUF` into
  `LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-MTP-GGUF/`.

No conversion harness is part of this pilot.

## Two slices

| Slice | Deliverable | Gate to next |
|---|---|---|
| A | MTP build + one downloaded Qwen MTP GGUF + bench vs vanilla on `local` | Decode speedup >= 1.4x for short-chat and acceptable long-prompt wall-clock |
| B | Opt-in `decoding: mtp` workload wiring for Qwen on `local` | — |

### Slice A — validation and benchmark

Deliverables:
1. Build side-by-side MTP binary tree from pinned PR SHA.
2. Download harness (`download.sh`) for pre-built MTP GGUFs.
3. Acquire one model: `qwen36-mtp`.
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
- Catalog stores `mtpRel` for `qwen36-q4m` (or successor id mapped to the
  downloaded MTP artifact).
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
