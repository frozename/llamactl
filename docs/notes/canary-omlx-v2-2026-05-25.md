# oMLX Slot v2 Canary — 2026-05-25

Live canary against real MLX runtime on mac-mini. Workload `mlx-granite-3b-slot-canary-mac-mini` (granite-4.1-3b-4bit, port 8197, `--max-concurrent-requests 1`, `--slot-save-path /Volumes/AI-DATA/cache/omlx-slot-canary-slots`). Drove `/v1/slots/capabilities`, `/slots/0?action=save`, `/slots/0?action=restore`, `/v1/chat/completions` directly via curl (skipping llamactl proxy — see Phase 5 note).

## Positive validations

1. **Capability bit advertised correctly**:
   ```
   GET /v1/slots/capabilities → {"slots":{"api_version":2,"supports_request_handle":true},"max_concurrent_requests":1,"slot_save_path_configured":true,...}
   ```
   Phase 1a wire contract works against a live server.

2. **State machine — SAVING refused during GENERATING**:
   Streaming chat-completion in flight; save fired in parallel:
   ```
   POST /slots/0?action=save → 409 {"error":{"code":"slot_busy","state":"GENERATING","message":"slot is busy"}}
   ```
   Phase 2's `acquire_for_save` correctly refuses with structured envelope when slot is non-IDLE.

3. **Restore: structured 404 on missing payload**:
   ```
   POST /slots/0?action=restore body={"model":"M","request_handle":"nonexistent"} → 404
     {"detail":{"error":{"code":"slot_file_not_found","message":"slot payload not found: nonexistent.kvslot"}}}
   ```
   Phase C+v2.A error envelope honored.

4. **Regression: chat without slot fields still works**:
   ```
   POST /v1/chat/completions body=(no x_omlx_*) → 200 normal completion
   ```
   Phase 2 admission hook is gated correctly on `x_omlx_request_handle` presence.

## Negative findings (real production blockers)

### P0 — Save is unreachable in practice

`POST /slots/0?action=save` returns:
```
500 {"error":{"code":"slot_serialize_failed","message":"no cache state available for slot save"}}
```

Repro: tried two patterns:
- Streaming chat → parallel save → save sees state=GENERATING (correct 409)
- Non-streaming chat → IMMEDIATE save → save sees no cache (request already GC'd)

Root cause matches the adversarial review's architect P1 + data P0:
> save path does not bind request_handle to a specific request/cache; it serializes the first cache-bearing request it finds (`_extract_slot_request_payload`).

`_extract_slot_request_payload` iterates `scheduler.requests` (a dict that's emptied at request completion) looking for any request with `prompt_cache` set. After completion, no such request exists. During generation, the slot is busy. There is no live window where save can succeed.

Architecturally: save should pull from the `BlockAwarePrefixCache` (cross-request KV state, persistent), not from a per-request `prompt_cache` reference. This is a v1-era design inheritance, not specific to v2.

**Severity**: this blocks ALL v2 round-trip canaries. Restore + apply paths cannot be exercised end-to-end without a real saved slot artifact.

### P0 — Bogus handle returns generic 500 instead of structured 409

```
POST /v1/chat/completions body={"x_omlx_request_handle":"bogus","x_omlx_restore_epoch":"deadbeef",...} 
→ 500 {"error":{"message":"Internal server error","type":"server_error","param":null,"code":null}}
```

Per Phase 2 contract, this should be:
```
→ 409 {"error":{"code":"slot_handle_not_found","details":{"model":"M","request_handle":"bogus"}}}
```

The non-streaming chat handler isn't catching `SlotApplyHandleNotFound` (or its sibling `SlotApplyEpochMismatch` / `SlotApplyGuardMismatch`). Bubbles up as generic 500.

Matches architect's P1 finding: "streaming vs non-streaming failure-contract divergence". Canary proved it's WORSE — the non-streaming path also doesn't honor the 409 contract; everything bubbles to 500.

## Slice X.3 follow-up: supervisor ModelHost gap fixed

Per integration adversarial finding (P1): supervisor.ts:325 + store.ts:90 only loaded ModelRun manifests, so `useProxy: true` on ModelHost yaml was a no-op. Fixed in commit `7e64fa3`:
- New `loadWorkloadByNameAny()` returns `ModelRun | ModelHost`
- supervisor.ts startup resolver drops the `kind === 'ModelRun'` gate
- 5 new tests (ModelHost with/without useProxy + ModelRun regression + store union loader)

Doesn't directly affect the canary (canary drives oMLX directly via curl), but unblocks end-to-end llamactl-proxy → oMLX routing once the v2.5 save fix lands.

## Recommended next moves (sequenced)

1. **v2.5-fix-1**: rewrite `_extract_slot_request_payload` to pull from BlockAwarePrefixCache, not per-request prompt_cache. Without this, save is dead. (Likely larger than 200 LoC — touches scheduler internals.)
2. **v2.5-fix-2**: wrap chat-completion handler in oMLX with try/except for SlotApply* exceptions → return structured 409. (Small.)
3. After fixes land + canary green: re-run canary save → restore → apply → expect `cached_tokens > 0` in response usage + `slot_apply_success` event.
4. Then: enable canary via llamactl proxy path (now possible after `7e64fa3` supervisor fix + Phase 3 proxy injection).

## Canary teardown

Workload `mlx-granite-3b-slot-canary-mac-mini` still running on mac-mini pid 43190, port 8197. NOT torn down yet; leaving for v2.5 fix-then-retest cycles.

## Artifacts

- Canary workload manifest: `templates/workloads/mlx-granite-3b-slot-canary-mac-mini.yaml`
- Slot save dir: `mac-mini:/Volumes/AI-DATA/cache/omlx-slot-canary-slots` (empty — no successful saves)
- Spec hash: see `/Volumes/AI-DATA/ai-models/local-ai/workloads/mlx-granite-3b-slot-canary-mac-mini/modelhost.state` on mac-mini
