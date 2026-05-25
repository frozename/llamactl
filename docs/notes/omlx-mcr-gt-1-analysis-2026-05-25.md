# oMLX `--slot-save-path` + `--max-concurrent-requests > 1` — architectural evolution

Date: 2026-05-25
Author context: written while promoting canary → prod (`mlx-qwen36-35b-a3b-local`). The slot v2 promotion forced the production server down to `mcr=1` to satisfy the existing guard, which traded ~4× peak concurrent-request capacity for KV warm-restore. This note traces the guard back to its real cause and sketches the path to lifting it.

## tl;dr

The guard `slot_save_path requires max_concurrent_requests=1` (enforced in `settings.py:1167` and `server.py:296`) is **over-broad**. The hard correctness reason it exists is `mlx_lm.models.cache.ChunkedKVCache` — used only by the Llama-4 family — lacks batch-aware `merge/filter/extract`. For paged-cache architectures (Qwen, Gemma, etc.) the constraint is not load-bearing, just untested. A two-phase plan can lift it for ~95 % of production models without touching upstream mlx_lm.

## where the guard lives

```
omlx/server.py:292-300         _slot_invariant_violation_reason()    runtime guard at /v1/slots/* + chat-completions
omlx/settings.py:1167-1171     Settings.validate()                    startup guard
omlx/scheduler.py:305-326      ChunkedKVCache monkey-patch comment    original mcr=1 reason (Llama-4 only)
```

The guard text gives no rationale. Git blame points to the same commit that introduced the slot save_path feature — added defensively, not after a measured failure. The ChunkedKVCache comment in `scheduler.py:311` is the **only** documented reason for `--max-concurrent-requests 1`, and it is model-architecture-specific.

## why batch>1 + slot save/restore is unsafe today

Two separate concerns are conflated:

1. **ChunkedKVCache lacks `merge` for `batch_size > 1`.** The scheduler monkey-patches in pass-throughs that raise on `len(caches) != 1`. Affects Llama-4 (Scout / Maverick) only.
2. **Slot save/restore quiescence.** `save_prompt_cache` serializes a list of cache layers. With continuous batching, multiple in-flight requests share the same paged-cache instance; if save runs while another request is still appending tokens, the serialized snapshot can capture a torn state.

Concern (2) is the real architectural question. SlotStore already enforces per-slot quiescence via `asyncio.Lock` (`slot_store.py:530-562`); per-request handle isolation is already in place via the `(model_id, request_handle)` keying introduced in slot v2. What is *not* in place is awareness of which **paged-cache blocks** belong to a given request handle, so the save path can fence around just that request's state.

## paged-cache makes per-request isolation feasible

oMLX's `PagedCacheManager` (`omlx/cache/paged_cache.py`) already tracks per-request block ownership: each in-flight request holds a list of logical block indices in the paged cache. The pieces needed to make slot save/restore safe under `mcr > 1`:

- **save**: serialize only the target request handle's blocks (not the whole cache); fence the request's batch slot for the duration of the serialize via the existing `SlotStore.acquire_for_save` lock.
- **restore**: allocate a fresh request batch slot, rehydrate its blocks from the slot file, then admit it into the next decoding step. Other in-flight requests' blocks are untouched.

This works because the paged cache is **logically partitioned per request**, even though it is physically a shared tensor. The ChunkedKVCache case is genuinely different (non-paged) and would still need an upstream `merge`.

## proposed evolution

### Phase 1 — narrow the guard by architecture (~50 LOC, 1 day)

Replace the unconditional guard with a model-class check:

```python
# settings.py
if self.scheduler.max_concurrent_requests != 1:
    chunked = _model_uses_chunked_kv_cache(self.model_name)
    if chunked:
        errors.append(
            "slot_save_path with this model class requires max_concurrent_requests=1 "
            "(ChunkedKVCache lacks batch-aware merge)"
        )
```

`_model_uses_chunked_kv_cache` reads the model's `config.json` and returns true iff the architecture maps to `ChunkedKVCache` in mlx_lm's registry. Conservative: any unknown class is treated as chunked (errs on the safe side).

Acceptance: the new test `tests/test_slot_save_mcr_arch_guard.py` covers (a) chunked-model + mcr>1 still rejected, (b) paged-model + mcr>1 + slot_save_path accepted at startup. Use Qwen3.6-35B-A3B as the paged-model fixture.

Risk: low. Pure validation-layer change. No save/restore code touched. Worst case at runtime: a request-handle save returns 500 because the underlying assumption was wrong, and the operator falls back to mcr=1.

### Phase 2 — per-request slot save under mcr>1 (~300 LOC, 2 days)

Two pieces:

(a) **`SlotStore.acquire_for_save(request_handle, batch_slot_id)`** — currently takes only `slot_id` (the file-side slot). Extend to also fence the batch slot in the live scheduler so the request's logical blocks don't migrate between save start and save end. The existing per-slot lock already handles concurrent saves on the same file; what's missing is the lock-vs-batch-loop coordination.

(b) **`save_prompt_cache(cache, request_handle)`** — at the layer below SlotStore, materialize the request's logical block slice into the format `load_prompt_cache` expects. mlx_lm's `save_prompt_cache` already accepts a list of cache layers; the work is the per-request slicing on the paged-cache side. Cross-check against existing `paged_cache.extract_blocks(block_ids)` helper.

Acceptance: integration test where two requests run concurrently against the same workload; one request fires `x_omlx_request_handle=A` save mid-stream, the other completes normally with no KV bleed-through; the saved slot file restores deterministically.

Risk: medium. Touches paged-cache + scheduler rendezvous. Mitigated by keeping the mcr=1 path as the default and gating mcr>1+slot behind an explicit `--enable-slot-mcr-gt-1` opt-in for the first ship.

### Phase 3 — restore under mcr>1 (~200 LOC, 1 day)

When a request arrives with `x_omlx_restore_epoch` set:

1. Allocate a batch slot reservation in the scheduler (existing `reserve_slot_for_restore`-like seam).
2. Read the slot file via `load_prompt_cache`.
3. Inject the blocks into the paged cache, owned by the new batch slot.
4. Admit the request into the next decoding tick.

The scheduler's existing one-shot bind table (v2.6b refactor introduced `BindResult` return) is already keyed by `(model_id, request_handle)`, so the per-request lookup is in place. The new work is the inject-then-admit step.

Risk: medium. Restore racing against eviction is the classic failure mode. Mitigation: hold the SlotStore restore lock for the entire admit window, not just the read.

### Phase 4 — observability + rollback path (~100 LOC, half a day)

- Counters: `slot_save_under_mcr_gt_1_total{outcome}`, `slot_restore_under_mcr_gt_1_total{outcome}`.
- A `--max-concurrent-requests-for-slot` flag that caps the slot-eligible request slots to a subset of total mcr. Lets the operator say "allow 4 concurrent decode but only 1 may save/restore at a time" while the contract is still maturing.

## upstream coupling

Lifting the guard for paged-cache models does **not** require mlx_lm changes. The ChunkedKVCache batch>1 limitation stays exactly where it is — only Llama-4 deployments would still need mcr=1 for slot use. Upstream PR is a separate, longer effort and not on this critical path.

## decision

For the current production posture (Qwen3.6-35B-A3B on `mlx-qwen36-35b-a3b-local`), Phase 1 alone unblocks the throughput regression we just took. Phase 2-3 are the durable answer.

Recommended sequence:
1. Cut `feat/slot-mcr-gt-1-paged-only` on oMLX, ship Phase 1, validate live at mcr=4 on the production workload.
2. If Phase 1 holds for a week (no slot save/restore failures observed in the telemetry counters from #4), open Phase 2-3 as a fresh oMLX slice.
3. Phase 4 ships alongside Phase 2 so observability is in place before the new path takes live traffic.

Expected end state: gains-host workload runs at `mcr=4` with slot v2 active, recovering the ~4× concurrent-request capacity we just gave up.

## links

- Current guard: `omlx/server.py:292-300`, `omlx/settings.py:1167-1171`
- ChunkedKVCache batch>1 limitation: `omlx/scheduler.py:305-365`
- SlotStore concurrency model: `omlx/slot_store.py:521-580`
- Slot v2 design: `docs/specs/2026-05-24-omlx-slot-api-v2-id.md` (in oMLX repo)
- Phase 7 KV decision: `docs/benchmarks/2026-05-25-kv-warm-restore-phase7-final.md`
