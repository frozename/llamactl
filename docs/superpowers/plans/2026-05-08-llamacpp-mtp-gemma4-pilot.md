# llama.cpp MTP pilot — Gemma 4 via atomic-llama-cpp-turboquant — plan

Date: 2026-05-08
Spec: `docs/superpowers/specs/2026-05-08-llamacpp-mtp-gemma4-pilot-design.md`
Status: phased, TDD-style; each phase has an acceptance check that must
pass before moving on.

## Phase 1 — Side-by-side atomic fork build

**Deliverables:**

- `tools/llama-cpp-mtp-atomic/PINNED_SHA` containing
  `2e81dc5f634501c744b69a65a8eeb84ba42e82ee`
  (HEAD of `feature/turboquant-kv-cache` at draft time).
- `tools/llama-cpp-mtp-atomic/build.sh` — idempotent clone of
  `https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant` into
  `${LLAMA_CPP_SRC_ATOMIC:-$DEV_STORAGE/src/llama.cpp-atomic}`,
  detached checkout at the pinned SHA, `cmake -DGGML_METAL=ON
-DGGML_METAL_EMBED_LIBRARY=ON -DLLAMA_CURL=ON
-DCMAKE_BUILD_TYPE=Release` then build `llama-server`,
  `llama-bench`, `llama-quantize`.

**Acceptance:**

1. `tools/llama-cpp-mtp-atomic/build.sh` exits 0.
2. `$LLAMA_CPP_BIN_ATOMIC/llama-server --version` prints a non-empty
   line.
3. `$LLAMA_CPP_BIN_ATOMIC/llama-server --help 2>&1 | grep -E '\\-\\-mtp-head|\\-\\-spec-type|turbo3'` matches at least one of the
   atomic-specific flags. (Catches the case where a wrong remote was
   cloned or the SHA pre-dates the feature.)

**Failure handling:**

- If cmake fails on Xcode SDK or Metal: fall back to checking out the
  release tag `turboquant-macos-arm64-f57a573` and rerun. Update
  `PINNED_SHA` accordingly and add a `FALLBACK` note.
- Do not modify `tools/llama-cpp-mtp/` (the prior pilot tree).

## Phase 2 — Model acquisition

**Deliverables:**

- `tools/llama-cpp-mtp-atomic/download.sh` — idempotent (`hf download
--include` + skip-if-present), pulls:
  - `unsloth/gemma-4-26B-A4B-it-GGUF` `*Q4_K_M*.gguf` →
    `$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF/`
  - `AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF`
    `*assistant.Q4_K_M.gguf` →
    `$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-assistant-GGUF/`
- Disk budget (estimate): base ≈16 GB + head ≈310 MB. Confirm
  `$LLAMA_CPP_MODELS` volume has ≥20 GB free before starting.

**Acceptance:**

1. Both target files exist and are non-empty after `download.sh`.
2. `file <base>` and `file <head>` both report `data` (not text/HTML —
   guards against gated-repo HTML responses being saved).
3. Re-running `download.sh` is a no-op (skip messages).

**Failure handling:**

- If the unsloth GGUF is missing the expected Q4_K_M file (naming
  drift), pin to the specific filename printed by `hf-tree` and update
  `download.sh`.
- If gating is hit (Gemma license), surface the gate URL and stop —
  pilot cannot proceed without user accepting Gemma terms.

## Phase 3 — Vanilla baseline bench (atomic binary, no MTP flags)

**Deliverables:**

- `tools/llama-cpp-mtp-atomic/bench.sh` — parametric `vanilla|mtp`,
  takes `<base-rel>` plus optional `<head-rel>`, threads atomic flags
  through. Reuses `bench-client.py` from `tools/llama-cpp-mtp/`.
- One invocation: `bench.sh vanilla
gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf`.
- Output JSON under `$DEV_STORAGE/bench/mtp-gemma4-pilot/`.

**Bench harness invariants (the "tests"):**

- Server health probe must pass within 120 s; otherwise capture
  `server.log` tail and exit non-zero.
- Output JSON must contain `decode_tps`, `prefill_tps`, `ttft_ms`,
  `rss_mb_peak`. (For vanilla, `accept_rate` is null/absent.)
- `port=18181` (matches prior pilot, avoids collision with
  `granite41-8b-local` on 8080 and mac-mini :8090).
- Server flags: `-ngl 99 -fa on -ctk turbo3 -ctv turbo3 -c 8192
--no-warmup -np 1 -ub 512`.

**Acceptance:**

1. Server health 200 within 120 s.
2. JSON output exists and parses, with all four required fields.
3. `decode_tps` is plausible (>3 tps, <300 tps — sanity bounds for
   M4 Pro / 26B-A4B Q4_K_M).

## Phase 4 — MTP bench (atomic binary, full atomic flag set)

**Deliverables:**

- One invocation: `bench.sh mtp
gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf
gemma-4-26B-A4B-it-assistant-GGUF/gemma-4-26B-A4B-it-assistant.Q4_K_M.gguf`.
- Server flags: vanilla flags + `--mtp-head <head> --spec-type mtp
--draft-block-size 3 --draft-max 8 --draft-min 0 -ngld 99 -ctkd
turbo3 -ctvd turbo3`.

**Acceptance:**

1. Server health 200 within 180 s (head load may be slower than
   vanilla — extend timeout from Phase 3's 120 s).
2. JSON output includes a non-null `accept_rate`.
3. `decode_tps` is positive and the run completed all bench profiles
   without server crash.

**Failure handling:**

- If server logs `unsupported architecture: gemma4_assistant`, the
  fork SHA does not yet have the assistant runtime. Bisect — newer
  branch tip might have it; older release tag may also. Update
  `PINNED_SHA` and re-run Phase 1.
- If MTP run completes but `accept_rate` is < 30%, the head pairing
  may be wrong (e.g., quantization mismatch). Verify both files
  belong to the same `gemma-4-26B-A4B-it` repo family.

## Phase 5 — Compare and gate

**Deliverables:**

- `docs/superpowers/specs/2026-05-08-llamacpp-mtp-gemma4-pilot-slice-a-results.md`
  with table comparing vanilla vs MTP on:
  - `decode_tps` (and ratio MTP/vanilla)
  - `prefill_tps` (and ratio)
  - `ttft_ms`
  - `rss_mb_peak`
  - `accept_rate` (MTP)
- Explicit go/no-go decision against the gate:
  - **Decode ratio ≥ 1.4×** AND
  - **Prefill ratio ≥ 0.9×** (no severe prefill regression)

**Acceptance:**

1. Results doc exists and references both bench JSON files by path.
2. Decision is explicit ("go" or "no-go") with a one-paragraph
   rationale.
3. Memory observation written:
   - `project_mtp_pilot_2026-05-08.md` summarizing outcome.
   - Update `MEMORY.md` index with the new entry, mark
     `project_mtp_pilot_2026-05-05.md` as superseded for Gemma 4
     specifically.

**Stop-gate:** if no-go, end here. Slice B does not run.

## Phase 6 — Slice B (contingent on Phase 5 go)

**Deliverables (if and only if Phase 5 says go):**

- Workload schema in `packages/core/src/types/workload.ts` (or
  wherever the canonical type lives — locate first):
  - `mtpHead?: string` field added.
- Catalog entry `gemma4-26b-a4b-q4m` in
  `packages/core/data/catalog.json` (or equivalent) pointing at
  the unsloth GGUF + the AtomicChat assistant.
- Spawn path in the agent runtime — wherever the existing `decoding:
mtp` flag is honored — extended to:
  - Pick the atomic binary (`LLAMA_CPP_BIN_ATOMIC`) when MTP enabled.
  - Append `--mtp-head` resolved against `LLAMA_CPP_MODELS` +
    `mtpHeadRel`.
  - Append the rest of the MTP flag set (`--spec-type mtp`,
    `--draft-block-size`, `--draft-max`, `--draft-min`, `-ngld`,
    `-ctkd turbo3`, `-ctvd turbo3`).
- Composite target `chat-mtp-gemma4-local` matching the existing
  `chat-mtp-local` shape but bound to the new catalog entry.
- Tests:
  - Unit test for the spawn-arg builder confirming the full flag set
    is emitted when `decoding: mtp` AND `mtpHeadRel` is present.
  - Unit test confirming the upstream binary is selected when
    `decoding: vanilla` (regression guard).
  - Smoke test: composite-apply against `chat-mtp-gemma4-local`,
    confirm endpoint is healthy and one request returns tokens.

**Acceptance:**

1. `bun test` clean.
2. Composite-apply succeeds and `/health` returns 200.
3. End-to-end one-shot completion via the gateway returns >0 tokens.

## Out-of-band

After all phases (whether Slice A passed or failed):

- Strip downloaded models if Slice A failed.
- Update auto-memory with the outcome and any retraps observed
  (binary signing, fork breakage, etc.).
- If Slice A passed: open a follow-up issue/note for mac-mini E4B +
  assistant evaluation.
