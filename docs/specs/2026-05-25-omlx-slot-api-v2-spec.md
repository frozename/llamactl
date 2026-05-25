# oMLX Slot API v2 Spec — (model_id, request_handle) Identity

> Supersedes the v2-direction stub in `2026-05-24-omlx-slot-api-spec.md` (Phase A/B/C v1).
> v1 is **shipped** on `feat/slot-api-phase-a` (commits 0943c0e9 → cbcd79ac).
> v2 closes the apply-linkage gap: v1 save serializes via `mlx_lm.save_prompt_cache`, but restore has no scheduler hook to inject cache into the next request matching the slot. v2 makes save+restore actually round-trip into live inference.

## Goal

Make oMLX slot save/restore functionally complete — when llamactl restores slot N, the next inbound chat-completion request that matches the slot's binding key MUST skip prefill and resume from the cached KV state on disk.

This requires three things v1 deferred:
1. **Canonical identity**: bind a slot to `(model_id, request_handle)` instead of the v1 numeric alias `slot=0`.
2. **Real serialization**: replace the v1 JSON `repr()` stub in `_serialize_slot_payload` with `mlx_lm.models.cache.save_prompt_cache` / `load_prompt_cache` (safetensors round-trippable).
3. **Apply linkage**: a scheduler-side hook that parks a restored cache and binds it to the next inbound request whose admission key matches.

## Non-goals (still deferred)

- Multi-tenant slot allocation (multiple concurrent slots per model). v2 keeps the v1 hard-gate of `max_concurrent_requests == 1` when `slot_save_path` is set.
- Cross-architecture slot portability (different model families).
- Quant guard + secondary-tuple guard (still v1.1 follow-up unless evidence requires).
- Compression / compaction of slot artifacts.

## Identity model

### Slot key (v2)

A slot is identified by a tuple `(model_id, request_handle)`:
- `model_id`: the resolved model alias used at save time (already required in v1 request body)
- `request_handle`: an opaque string the caller generates and provides on save AND restore. Must be URL-safe basename (same constraints as v1 `filename`). Length 1-128 chars. Charset `[A-Za-z0-9_.-]`.

The slot file naming on disk: `<request_handle>.kvslot` + paired `<request_handle>.kvslot.manifest.json` under `<slot_save_path>/<model_id>/`. Per-model subdir prevents cross-model collisions.

### slot_id=0 alias (back-compat)

v1 clients that POST `/slots/0?action=save|restore` continue to work. The server treats `slot_id=0` as alias for `request_handle="default"` under whatever `model` is bound (single-model strict mode preferred, else explicit `model` body field). v1's `filename` body field becomes a synonym for `request_handle` when present.

Behavior matrix:

| v1 request shape | v2 interpretation |
|---|---|
| `POST /slots/0?action=save body={"filename":"x.kvslot","model":"M"}` | request_handle="x.kvslot" (filename stripped of any `.kvslot` suffix → request_handle="x"; `.kvslot` becomes implicit), saved under `<root>/M/x.kvslot` |
| `POST /slots/0?action=save body={"model":"M"}` (no filename) | request_handle="default", saved under `<root>/M/default.kvslot` |
| `POST /slots/N?action=…` where N != 0 | HTTP 400 `invalid_slot_id` (unchanged from v1) |

### New endpoint surface

v2 adds an explicit, identity-first endpoint shape alongside the v1 alias:

```
POST /v1/slots/save     body={"model":"M","request_handle":"H"}        → 200 {n_saved}
POST /v1/slots/restore  body={"model":"M","request_handle":"H"}        → 200 {n_restored}
GET  /v1/slots                                                          → list of {model, request_handle, n_tokens, manifest_summary}
DELETE /v1/slots/{model}/{request_handle}                               → 204
GET  /v1/slots/capabilities                                             → {version: 2, features: ["request_handle","apply_on_admission",...]}
```

Both surfaces share the same SlotStore + state machine + manifest format.

## Request-handle binding (the apply linkage)

### Save side

When `save` fires, the server:
1. Looks up the currently active request (max_concurrent_requests==1 → exactly one active request).
2. Pulls `prompt_cache` from that request via `_extract_slot_request_payload` (v1 already does this).
3. Calls `mlx_lm.models.cache.save_prompt_cache(tmp_file, prompt_cache, metadata=manifest_fields)` (replaces the JSON `repr()` stub).
4. Atomic-publishes per v1 contract.
5. Returns `n_saved = num_computed_tokens` (real token count, not repr count).

### Restore side

When `restore` fires, the server:
1. Loads payload via `mlx_lm.models.cache.load_prompt_cache(tmp_file, return_metadata=True)`.
2. Validates manifest guards (model_fingerprint, ctx_size — unchanged from v1).
3. **Parks the cache** in a new server-state structure: `_server_state.pending_restores: dict[(model_id, request_handle), PendingRestore]`.
4. Returns `n_restored = manifest.n_tokens` (the count from the loaded cache; verifiable post-load via `cache[0].offset`).

### Admission hook

A new method on the scheduler — call it `scheduler.try_apply_pending_restore(request: Request) -> bool` — runs as part of the request admission path (before prefill).

Trigger condition: the caller's chat-completion request includes a new optional header or body field `request_handle`. Concretely, an OpenAI-format request body grows an optional top-level `"x_omlx_request_handle": "H"` (vendor-prefixed for namespacing). When set:
1. At admission, the scheduler queries `_server_state.pending_restores` for key `(request.model_id, request.x_omlx_request_handle)`.
2. If a `PendingRestore` is parked, the scheduler:
   - Assigns the parked `prompt_cache` to `request.prompt_cache`
   - Sets `request.cached_tokens = manifest.n_tokens`
   - Computes `request.remaining_tokens = request.prompt_token_ids[manifest.n_tokens:]` (skip the prefilled portion)
   - Removes the entry from `pending_restores`
   - Logs `slot_restore_applied` with the binding key
3. Prefill proceeds for only `remaining_tokens` — large win when the prompt prefix matches what was cached.

If `prompt_token_ids[:manifest.n_tokens] != cache.tokens` (the cache's recorded token prefix differs from the new request's prompt prefix), restore is rejected at admission with HTTP 409 `slot_prefix_mismatch` and the cache is dropped (or returned to pending_restores depending on policy — v2 chooses drop).

### Lifetime + GC

- `pending_restores` entries persist for `slot_pending_ttl_seconds` (default: 300) after restore POST.
- A background task drops expired entries and logs `slot_pending_expired`.
- On server shutdown: pending entries are NOT persisted (in-memory only); the disk artifact remains and can be restored fresh next boot.

## Concurrency state machine (v2 deltas)

Two new states extend the v1 set:
- `PENDING_RESTORE`: cache loaded from disk, parked in `_server_state.pending_restores`, awaiting admission match. Slot is **NOT** locked while pending — other saves/restores for OTHER `(model, handle)` keys can proceed.
- `APPLIED`: cache has been bound to a live request; cleared when that request terminates.

The v1 per-slot state (`IDLE`, `SAVING`, `RESTORING`, `GENERATING`) is replaced by a **per-(model, handle) state**:
- Save flow: `IDLE → SAVING → IDLE`
- Restore flow: `IDLE → RESTORING → PENDING_RESTORE → APPLIED → IDLE`
- Generation: `IDLE → GENERATING → IDLE`
- A `(model, handle)` mid-save/restore refuses concurrent operations on the same key.
- DIFFERENT keys may operate concurrently (subject to `max_concurrent_requests==1` overall constraint, which the v1 hard invariant still enforces).

## Wire contract (v2)

### Save

```
POST /v1/slots/save
body: {"model":"M","request_handle":"H","prefix_tokens":[optional list of int]}
→ 200 {"model":"M","request_handle":"H","n_saved":12345,"filename":"H.kvslot"}
```

The optional `prefix_tokens` body field lets the caller assert the cached prefix (server validates against the active request's actual `prompt_token_ids[:cached_tokens]` and returns 409 if it disagrees — defense-in-depth for incorrect handle reuse).

### Restore

```
POST /v1/slots/restore
body: {"model":"M","request_handle":"H"}
→ 200 {"model":"M","request_handle":"H","n_restored":12345,"pending_ttl_seconds":300}
```

### List

```
GET /v1/slots?model=M
→ 200 {"slots":[{"model":"M","request_handle":"H","n_tokens":12345,"saved_at":"2026-05-25T01:23:45Z","model_fingerprint":"<sha>","ctx_size":4096}]}
```

### Delete

```
DELETE /v1/slots/{model}/{request_handle}
→ 204 No Content
```

Returns 404 if not present.

### Error responses

All v1 codes preserved. New v2 codes:
- HTTP 409 `slot_prefix_mismatch` — restore's prompt prefix doesn't match cache's recorded prefix at admission time.
- HTTP 410 `slot_pending_expired` — caller's chat-completion request quoted a `x_omlx_request_handle` that had a TTL'd pending restore; cache is gone.
- HTTP 400 `invalid_request_handle` — handle violates charset/length rules.

## Implementation surface

### `omlx/slot_store.py` (extend)

- Move filename → `(model, request_handle)` decomposition; add helpers `key_for_v1(filename, model)` + `path_for_key(model, handle)` for back-compat alias resolution.
- `SlotState` enum gains `PENDING_RESTORE`, `APPLIED`.
- New: `class PendingRestore` dataclass holding `(prompt_cache, manifest, prefix_token_ids, expires_at)`.
- New: `class PendingRestoreRegistry` with `put(key, pending)`, `pop(key) -> PendingRestore | None`, `evict_expired() -> list[key]`. Keyed by `(model_id, request_handle)`.

### `omlx/server.py`

- `_serialize_slot_payload` rewritten to delegate to `mlx_lm.models.cache.save_prompt_cache` (writes to a tmp safetensors file under `slot_save_path`, reads bytes for SlotStore.write_atomic).
- `_apply_slot_restore_payload` rewritten: `mlx_lm.models.cache.load_prompt_cache(tmp_file)` → returns cache + metadata; then `pending_restores.put((model, handle), PendingRestore(...))`.
- New `_server_state.pending_restores: PendingRestoreRegistry`.
- New `/v1/slots/*` endpoint family alongside v1 `/slots/{id}` aliases.
- v1 alias handlers translate `slot_id=0` + `filename` → `(model, request_handle)` and delegate to the same internal save/restore primitives.

### `omlx/scheduler.py`

- New method `try_apply_pending_restore(request: Request) -> bool` called from the admission path (after `prompt_cache` is established from the existing block-aware prefix cache, before prefill kicks off).
- Behavior: if `request.x_omlx_request_handle` is set AND `_server_state.pending_restores.pop((request.model_id, handle))` returns a PendingRestore:
  - Validate manifest guards a SECOND time at admission time (defense-in-depth — model swap between restore POST and chat-completion arrival).
  - Validate `request.prompt_token_ids[:cache.tokens] == cache.recorded_token_ids` (if cache exposes recorded prefix; else skip and rely on caller's prefix_tokens assertion).
  - On match: replace request.prompt_cache with the parked one; set cached_tokens; recompute remaining_tokens; log `slot_restore_applied`.
  - On mismatch: log `slot_restore_rejected_prefix_mismatch`; the request prefills normally.

### `omlx/request.py`

- Add optional `x_omlx_request_handle: Optional[str] = None` to Request dataclass.
- Plumb from request body parse → Request construction.

### Background task

- New asyncio task `_pending_restore_gc_loop` started in `init_server` if slot API enabled. Runs every 60s, evicts expired entries, emits structured logs.

## RED tests (must FAIL before GREEN)

### Unit (`tests/test_slot_store.py`)

1. `test_v2_save_uses_safetensors_round_trip` — call save, load resulting file via mlx_lm.load_prompt_cache, assert returned cache equals the original (mlx array equality + token counts).
2. `test_pending_restore_registry_put_pop_roundtrip`.
3. `test_pending_restore_registry_evict_expired_removes_old_entries_only`.
4. `test_v1_alias_save_writes_to_per_model_subdir` — POST /slots/0 with model=M filename=X → file lands under `<root>/M/X.kvslot`.
5. `test_v2_save_rejects_invalid_request_handle_charset`.
6. `test_v2_save_rejects_request_handle_too_long`.

### Integration (`tests/integration/test_server_endpoints.py`)

7. `test_v2_save_restore_round_trip_via_v1_alias` — POST /slots/0 save then restore; assert n_restored == n_saved and pending entry registered.
8. `test_v2_restore_parks_to_pending_registry_with_ttl`.
9. `test_v2_chat_completion_with_handle_consumes_pending_restore` — full E2E: save → restore POST → chat-completion request with `x_omlx_request_handle` set → scheduler applies + cached_tokens > 0 + prefill skipped for the cached portion.
10. `test_v2_chat_completion_with_handle_prefix_mismatch_falls_back_to_full_prefill` — handle matches but prompt prefix doesn't.
11. `test_v2_chat_completion_with_expired_handle_returns_410`.
12. `test_v2_list_slots_returns_saved_slots_for_model`.
13. `test_v2_delete_slot_removes_payload_and_manifest_and_pending_entry`.
14. `test_v2_capabilities_endpoint_advertises_version_2`.
15. `test_v2_concurrent_saves_for_different_handles_do_not_block` — under max_concurrent_requests=1 invariant, save for handle A in flight; save for handle B should NOT 409 because keys differ. (Verify against the invariant: only ONE generating request at a time, but multiple slot ops are fine.)
16. `test_v2_invariant_violation_still_returns_503` — runtime detection unchanged from v1.

### Scheduler unit (`tests/test_scheduler.py`)

17. `test_try_apply_pending_restore_attaches_cache_to_matching_request`.
18. `test_try_apply_pending_restore_skips_non_matching_handle`.
19. `test_try_apply_pending_restore_validates_guards_at_admission`.
20. `test_try_apply_pending_restore_rejects_prefix_mismatch_drops_cache`.

### v1 regression guard

21. All existing v1 slot tests (Phase A+B+C) must still pass — no behavioral regression on `/slots/{id}` alias surface.

## GREEN phase (implementation order)

Phase v2.A — serialization swap (smallest, lowest-risk slice):
- Replace `_serialize_slot_payload` + `_apply_slot_restore_payload` JSON repr stubs with `mlx_lm.models.cache.save_prompt_cache` / `load_prompt_cache`.
- Manifest gains `n_tokens` from real cache, not from manifest echo.
- v1 alias behavior unchanged on the wire.
- Tests 1, 7 (without admission hook), 21 must pass.

Phase v2.B — pending registry + new endpoints:
- Add `PendingRestoreRegistry`, `PendingRestore` dataclass.
- Add `/v1/slots/save|restore|list|delete|capabilities` endpoints + v1 alias plumbing.
- Tests 2, 3, 4, 5, 6, 8, 12, 13, 14, 15, 16.

Phase v2.C — admission hook:
- Add `x_omlx_request_handle` to Request.
- Add `scheduler.try_apply_pending_restore` + admission-path integration.
- Add prefix-mismatch + guard re-check semantics.
- Tests 9, 10, 11, 17, 18, 19, 20.

Phase v2.D — background GC + observability:
- Async eviction loop.
- Structured log events: `slot_restore_applied`, `slot_restore_rejected_prefix_mismatch`, `slot_pending_expired`, `slot_invariant_violation`.
- Capability surface advertises `pending_ttl_seconds` + per-feature flags.

## Cross-repo coordination (llamactl side)

llamactl's `UpstreamSlotClient` (`packages/core/src/kvstore/upstreamSlots.ts`):
- Add `requestHandle: string` parameter to `save()` and `restore()` methods.
- Add `x_omlx_request_handle` plumbing through `openaiProxy`: when KV path picks up a slot restore for a workload, the proxy must inject `x_omlx_request_handle` into the upstream chat-completion request body.
- Capability negotiation: `supportsSlots()` already exists (v1); add `supportsRequestHandle()` checking `capabilities.features.includes("request_handle")`.

These llamactl changes are Phase D of the v1 spec (cross-repo CI parity) extended to v2 — out of scope for this oMLX-side spec but flagged here.

## Rollback / disable

- `slot_save_path` unset → all `/v1/slots/*` endpoints return 404 (same as v1 `/slots/{id}`).
- Feature flag (env or config): `OMLX_SLOT_API_VERSION` defaults to 2. Setting to 1 disables `/v1/slots/*` + scheduler admission hook, keeps v1 alias only — gives a kill switch if v2 regresses.

## Open questions

1. Should `pending_restores` survive a server restart? Spec says no (in-memory). Argument for yes: cached state is durable on disk; the binding key is the only ephemeral piece, and re-binding could be lazy on chat-completion arrival. v2 chooses no for simplicity; revisit if evidence demands.
2. Should `x_omlx_request_handle` be a header instead of a body field? Header is OpenAI-API-friendlier (no body schema change); body is easier to plumb through proxies that don't preserve custom headers. v2 picks BODY for proxy compatibility but accepts BOTH (header takes precedence if both present).
3. What's the semantics of `n_saved` vs cache token count? v1 returned `cached_tokens` which equals the prefix-cache hit count, NOT the cache's full content. v2 should align — saved cache represents the entire computed context (cached + computed prefill), so `n_saved = num_computed_tokens`.
4. Should the v2 spec be implemented behind a dispatch-time feature flag, or directly on `feat/slot-api-phase-a` continuing the v1 chain? Recommendation: same branch, since v1 alias semantics are preserved and v2 is strictly additive on the wire.

## Revision history

- v2.0 (2026-05-25): Initial v2 draft extending v1's deferred identity model + closing the apply-linkage gap surfaced in Phase C's scheduler-hook deviation note. Drafted by maestro in llamactl session; pending adversarial-plan fan-out before phased TDD plan.
