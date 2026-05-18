# Granite/Hybrid State & EOS Audit (2026-05-14)

## 1) TL;DR
- **Q-A (Hybrid state cross-contamination with `-np 2`)**: **Likely safe / per-sequence-isolated** for recurrent state, not a global shared-state bug. **Confidence: high**.
- **Q-B (Silent EOS / EOT)**: No Granite-only sampler branch was found; truncation is consistent with generic EOS/EOG handling plus Granite chat template behavior (`<|end_of_text|>`), not a separate Granite-specific stop-rule bug. **Confidence: medium**.

## 2) Question A findings
- Recurrent memory is sequence-indexed, with per-cell ownership metadata and per-seq tails:
  - `src/llama-memory-recurrent.h:24-25, 78-85, 90-95`
    > `const uint32_t n_seq_max = 1;`
    > `std::set<llama_seq_id> seq_id;`
    > `int32_t   tail = -1;`
  - `src/llama-memory-recurrent.cpp:20-21`
    > `... n_seq_max(n_seq_max)`
    > `size = mem_size; used = 0;`
- `find_slot()` enforces per-seq ownership (`seq_id` and `tail`) and only assigns cells as contiguous ranges for each active sequence in the batched set:
  - `src/llama-memory-recurrent.cpp:463-511`
    > `const uint32_t n_seq_tokens = ubatch.n_seq_tokens;` / `const uint32_t n_seqs = ubatch.n_seqs;`
    > `auto & seq_meta = cells[seq_id];` / `seq_meta.tail = next_empty_cell;`
  - `src/llama-memory-recurrent.cpp:580-618`
    > `const auto & seq_meta = cells[seq_id]; ... seq_meta.tail = ...;` 
    > `cell.seq_id.insert(seq_id); cells[seq_id].tail = cell_id;`
- Hybrid memory delegates seq ops and state write/read to both recurrent and attention stores, i.e., no special side-path for Granite hybrid beyond composition:
  - `src/llama-memory-hybrid.cpp:17-58`
    > constructs `mem_attn` and `mem_recr` with same `n_seq_max`
  - `src/llama-memory-hybrid.cpp:123-143`
    > `mem_attn->seq_rm...; mem_recr->seq_rm...` and `mem_attn->seq_cp...; mem_recr->seq_cp...`

**Verdict:** for `-np 2` interleaving, recurrent state is not globally shared by slot; contamination is unlikely to originate from `mem_recr` ownership alone.

## 3) Question B findings
- Granite template wiring:
  - `src/llama-chat.cpp:63-64`
    > map entries for `granite` and `granite-4.0`
  - `src/llama-chat.cpp:195-199`
    > detection on `<|start_of_role|>` returning Granite 4.0 vs 3.x
- Granite rendering appends `end_of_text` delimiters per message:
  - `src/llama-chat.cpp:627-652`
    > `... << message->content << "<|end_of_text|>\n";`
- Vocabulary EOT/EOG handling is generic + token-text based, with Granite markers included:
  - `src/llama-vocab.cpp:2358-2362`
    > special EOT includes `"<|end_of_text|>" // granite`
  - `src/llama-vocab.cpp:2570`
    > EOG set includes `"<|end_of_text|>"`
  - `src/llama-vocab.cpp:2605-2612`
    > ensures `special_eos/eot/eom` are included in EOG
- Sampler uses EOG-aware filtering globally (no Granite-only rule):
  - `src/llama-sampler.cpp:3628-3640`
    > computes `p_eog_sum`, may drop to EOG-only branch
  - `src/llama-sampler.cpp:3741-3747`
    > if no non-EOG tokens remain, force EOT/EOS fallback

**Verdict:** I do not see a Granite-only “silent stop” trigger. The likely truncation vector is template/terminator tokenization + normal EOG sampling behavior at temperature=0 (plus any JSON-array formatting pressure).

## 4) Recommended bench experiment for each
- **For Q-A:**
  ```bash
  cd /Volumes/WorkSSD/repos/personal/llamactl && bash tools/memory-efficacy-bench/sweep.sh
  ```
  Compare `bench-results/sweep-baseline.json` (np2) vs `bench-results/sweep-np1.json` (np1) for JSON-valid-rate / schema-valid-rate deltas under same workload.
- **For Q-B:**
  ```bash
  cd /Volumes/WorkSSD/repos/personal/llamactl && bash tools/memory-efficacy-bench/sweep.sh
  ```
  Compare `sweep-baseline.json` vs `sweep-jinja.json` and `sweep-aggressive.json` to isolate whether Granite template/Jinja mode shifts JSON truncation signatures under identical `temperature:0` bench client behavior.

## 5) Out of scope / not audited
- Did not audit backend kernel execution path (`ggml` ops, Metal/CUDA scheduler).
- Did not execute the sweep in this pass.
- Did not debug caller-side payload shaping outside `sweep.sh`/`run-bench.ts` (e.g., upstream JSON generator or transport retry logic).
