# llama.cpp MTP pilot — implementation plan

> For agentic workers: use subagent-driven execution with verification gates per task.

**Goal:** run a Qwen-only, single-node MTP pilot on M4 Pro, then wire `decoding: mtp`
as an opt-in workload mode if Slice A passes.

**Spec:** `docs/superpowers/specs/2026-05-05-llamacpp-mtp-pilot-design.md`

**Architecture summary:** keep vanilla path unchanged, use side-by-side MTP binary
(`LLAMA_CPP_BIN_MTP`), and consume pre-built MTP GGUF via `download.sh`.

---

## File structure

**Create:**
- `tools/llama-cpp-mtp/download.sh` — idempotent pre-built MTP GGUF fetch.

**Modify (Slice B if gated-in):**
- `packages/core/src/types.ts`
- `packages/core/src/env.ts`
- `packages/core/src/schemas.ts`
- `packages/core/src/server.ts`
- `packages/core/src/nodeFacts.ts`
- `packages/remote/src/workload/schema.ts`
- `packages/remote/src/workload/apply.ts`
- `packages/cli/src/commands/composite.ts` (or equivalent)

---

## Slice A — validation and benchmark

### Task A1: MTP build tree (unchanged)

- [ ] Keep pinned PR SHA in `tools/llama-cpp-mtp/PINNED_SHA`.
- [ ] Build side-by-side tree with `tools/llama-cpp-mtp/build.sh`.
- [ ] Verify MTP flags exist in `llama-server --help`.

Env bootstrap command (corrected):

```bash
eval "$(bun packages/cli/src/bin.ts env --eval)"
```

### Task A2: Pre-built MTP GGUF download harness

**File:** `tools/llama-cpp-mtp/download.sh`

- [ ] Implement idempotent download by catalog id.
- [ ] Initial supported id: `qwen36-mtp`.
- [ ] Resolve available `.gguf` entries from
      `am17an/Qwen3.6-35BA3B-MTP-GGUF`.
- [ ] Quant selection order: `Q4_K_M`, `Q4_K_S`, `Q5_K_M`, `Q4_0`, `Q8_0`.
- [ ] If no preferred quant tag matches, fall back to the smallest available
      `.gguf` by size.
- [ ] Download via `hf download` into
      `$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-MTP-GGUF/`.

Run:

```bash
eval "$(bun packages/cli/src/bin.ts env --eval)"
bash tools/llama-cpp-mtp/download.sh qwen36-mtp
```

### Task A3: Removed

- [ ] Removed from scope. Multi-model conversion batch is no longer part of
      this pilot.

### Task A4: Bench smoke on single in-scope pair

- [ ] Reuse existing bench harness structure.
- [ ] Run one pair only: `local` x downloaded Qwen MTP GGUF.
- [ ] `mtp` invocation appends `--spec-type mtp --spec-draft-n-max 3`.
- [ ] Do not pass `--model-draft` for Qwen embedded-head MTP.
- [ ] Capture decode t/s, prefill t/s, TTFT, peak RSS.

### Task A5: Results matrix (collapsed)

- [ ] Publish one-row matrix in the Slice A results doc:
  - Node: `local`
  - Model: downloaded `qwen36-mtp`
  - Vanilla vs MTP metrics
  - Go/no-go recommendation

Gate to Slice B:
- [ ] Short-chat decode >= 1.4x vs vanilla
- [ ] Long-prompt wall-clock <= 1.1x vs vanilla
- [ ] Memory fits M4 Pro envelope

---

## Slice B — workload wiring (only if Slice A passes)

### Task B1: Catalog schema + data

- [ ] Add optional `mtpRel` and `mtpDrafterRel` fields to catalog schema.
- [ ] Add one data mapping only: `qwen36-q4m` (or its active catalog id)
      gets `mtpRel` pointing at the downloaded MTP artifact.
- [ ] Do not require `mtpDrafterRel` for this Qwen entry.
- [ ] Update schema tests for optional fields and Qwen-only `mtpRel` case.

### Task B2: Workload schema

- [ ] Add `decoding: mtp | vanilla` (default `vanilla`) to workload run spec.
- [ ] Keep backward compatibility for existing workloads.

### Task B3: `resolveSpawnPlan` / spawn args

- [ ] `decoding: vanilla` => unchanged path (`LLAMA_CPP_BIN`).
- [ ] `decoding: mtp` => MTP binary path (`LLAMA_CPP_BIN_MTP`) and append:
  - `--spec-type mtp`
  - `--spec-draft-n-max 3`
- [ ] Remove unconditional `--model-draft` append behavior.
- [ ] Append `--model-draft` only if a non-empty drafter rel/path exists.
- [ ] Update spawn-path tests accordingly.

### Task B4: Node status/facts surface

- [ ] Keep/extend capability reporting so operators can tell if MTP binary is
      present and which decoding mode is live.

### Task B5: Apply-time validation

- [ ] `decoding: mtp` requires `mtpRel` to be present for the selected model.
- [ ] `mtpDrafterRel` remains optional.
- [ ] Emit clear validation errors for missing `mtpRel`.

### Task B6: Composite apply behavior

- [ ] Mirror B5 semantics in composite apply path.
- [ ] Preserve vanilla behavior for all existing composites.

### Task B7: Composite config rename

- [ ] Use `chat-mtp-local` (M4 Pro, Qwen).
- [ ] Remove `chat-mtp-mac-mini` references.
- [ ] Remove Gemma-specific MTP composite references.

### Task B8: Operator docs update

- [ ] Update docs and examples to Qwen-only single-node scope.
- [ ] Document that Gemma 4 and mac-mini legs are deferred as of 2026-05-05.

---

## Verification checklist

- [ ] `rg -n "convert.sh|gemma4-e4b-q4|chat-mtp-mac-mini|mtpDrafterRel required|src/index.ts env --eval" docs/superpowers/specs docs/superpowers/plans`
      shows no stale references.
- [ ] Downloaded MTP GGUF exists and is non-zero.
- [ ] Commit scripts/tooling and docs as separate logical commits.

## Commit plan

1. `tools(llama-cpp-mtp): add download.sh for pre-built MTP GGUFs`
2. `docs(mtp-pilot): pivot scope to Qwen-only single-node`
