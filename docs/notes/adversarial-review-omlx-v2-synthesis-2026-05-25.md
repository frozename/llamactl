# oMLX Slot v2 — Adversarial Review Synthesis (2026-05-25)

5 personas, all non-Anthropic (Anthropic 7-day at 100%): architect, security, simplicity (all oMLX-side) + data-correctness (oMLX) + combined architect/security/data (llamactl-side).

Reviewers (codex-acp-deep except simplicity=codex-acp-fast). Synthesizer: hand (codex-acp-deep synthesizer pool poisoned by routing-guard on cross-repo path inlining; outputs were already concrete enough to merge by hand).

## Convergent findings (multiple personas, prioritized)

### P0 — Bind table consume-before-validate (3 personas: architect, security, data)

**Location**: `omlx/scheduler.py:3334,3349` + `omlx/slot_store.py:151`

**Issue**: `try_apply_one_shot_bind` calls `consume_any()` (destructive pop) BEFORE epoch/guard validation. A wrong-epoch request consumes the bind, then fails validation, leaving no entry for the subsequent correct request — which then fails with `handle_not_found`.

**Failure mode**: Innocent retry, clock skew, or wrong-epoch request can permanently drop a legitimate restore. Also a trivial denial-of-service: any client that knows or guesses a handle can poison another client's restore.

**Fix**: Make consume atomic with epoch+guard validation. `consume(model_id, request_handle, restore_epoch)` should check epoch BEFORE removing; on mismatch, leave entry intact (or atomically rebind). Update tests for the new contract.

### P0 — No prompt-prefix guard on apply (data persona)

**Location**: `omlx/server.py:1204,1209` + `omlx/scheduler.py:3394,3397`

**Issue**: Save serializes `model_id` + `cached_tokens` only. Apply trusts `manifest.n_tokens` to slice the CURRENT request prompt as `prompt[n_tokens:]` — without checking that `prompt[:n_tokens]` actually matches the prefix that was cached. A handle+epoch can be applied to a totally different prompt, silently skipping prefill on tokens the cache never saw.

**Failure mode**: Silent semantic corruption — model generates from a half-decoded state that's stitched from prompt A's cache + prompt B's tail. Output is plausible but wrong.

**Fix**: Persist a prompt-prefix hash in the manifest (sha256 of `prompt_token_ids[:cached_tokens]`). At apply time, recompute the same hash on `request.prompt_token_ids[:manifest.n_tokens]` and reject on mismatch with hard 409 `slot_prefix_mismatch`. Add an integration test: save from prompt A, restore, try to apply to prompt B → must 409.

### P0 — Default handle collision (architect, security)

**Location**: `omlx/server.py:341,342` + `omlx/slot_store.py:135`

**Issue**: Missing `request_handle` falls back to global `"default"`. Two clients on the same model collide at `(model_id, "default")` for save AND restore AND apply.

**Fix**: For v2.1, require explicit `request_handle` (deprecate implicit `"default"` fallback). Alternative: scope default handle by client session token (would require auth integration, larger change).

### P0 — Response-cache vendor-field stripping enables replay (llamactl security)

**Location**: `packages/core/src/cache-identity/canonical.ts:3,17` + `packages/core/src/openaiProxy.ts:630,1395`

**Issue**: The exclude-list strips `x_omlx_request_handle` + `x_omlx_restore_epoch` from the cache key BEFORE hash. For oMLX routes where these fields are semantic, two semantically-different requests collapse to the SAME cache key. A request with handle A could replay-cache-hit a response from handle B.

**Fix**: Don't strip vendor fields blindly. Either: (a) include them in the cache key for oMLX routes (separate identity function for ModelHost+omlx), or (b) reject user-supplied `x_omlx_*` fields at the proxy ingress (only proxy-injected after-restore values are allowed). Option (b) is safer.

### P1 — OneShotBindTable unbounded memory (architect, security)

**Location**: `omlx/slot_store.py:130,135,156`

**Issue**: No TTL, no max-entries, no max-bytes. Each entry holds full `payload_bytes` (multi-MB at scale). Repeated restore POSTs with unique handles → unbounded RAM consumption.

**Fix**: Add `max_pending_global`, `max_pending_per_model`, `max_bytes_pending` config knobs; LRU/oldest eviction policy; return 429/503 on admission when full. Drop the synthesis's "no TTL needed" assertion — even consume-only needs an upper bound when the consumer never arrives.

### P1 — Filename↔handle mapping non-bijective for `.safetensors` (data)

**Location**: `omlx/server.py:335,338,339`

**Issue**: `filename="x.safetensors"` resolves to `handle="x.safetensors"`, but `handle="x.safetensors"` resolves back to `filename="x.safetensors.kvslot"`. Round-trip lookup breaks for non-`.kvslot` filenames.

**Fix**: Canonicalize the mapping. Pick one rule: either require `.kvslot` suffix in handle-derived filenames, or strip ANY `.<ext>` suffix consistently. Add round-trip tests for `.safetensors`, multi-dot, whitespace, unicode cases.

### P1 — restore_epoch leaked in structured logs (security, llamactl-security)

**Location**: `omlx/server.py:2070`, `omlx/scheduler.py:3351`, `omlx/slot_store.py:166`, `packages/core/src/openaiProxy.ts:845,858`

**Issue**: `restore_epoch` is effectively a bearer token for bind application. Logs include `expected_epoch`, `provided_epoch`, `restore_epoch` verbatim. Anyone with log-read access can replay-steal binds.

**Fix**: Redact epochs in logs — log a hash prefix (`epoch=abc12...`) or just a boolean (`epoch_match=false`). NEVER log expected_epoch verbatim.

### P1 — Capability probe memoized forever (llamactl data)

**Location**: `packages/core/src/kvstore/upstreamSlots.ts:30,99`

**Issue**: `supportsRequestHandle()` result is cached for the lifetime of the `UpstreamSlotClient` instance. A transient `/props` failure pins `false` for the process lifetime. A capability rolled out after probe time stays invisible.

**Fix**: Add a TTL to the probe cache (60s reasonable default); re-probe on failure responses from upstream; invalidate on connection error.

### P1 — Scheduler imports server module state (architect)

**Location**: `omlx/scheduler.py:3262,3297`

**Issue**: `_server_state`, `_slot_entry_for_model`, `_slot_ctx_size_for_model` imported from server module into scheduler. Hard singleton coupling blocks multi-engine / multi-tenant / multi-instance composition.

**Fix**: Inject guard resolver + bind table interfaces into scheduler/engine_core constructors. Server wires them at init. Scheduler stays decoupled.

### P1 — New event loop per request in admission path (architect)

**Location**: `omlx/scheduler.py:3442,3444`

**Issue**: `asyncio.new_event_loop()` + `close()` per tagged request in the hot admission path. Allocator pressure + latency at request rate.

**Fix**: Make `try_apply_one_shot_bind` synchronous (its body is just a dict lookup + bytes deserialize). Or maintain a persistent loop for the scheduler thread.

### P1 — Streaming vs non-streaming failure-contract divergence (architect)

**Location**: `omlx/server.py:2890,2906,3438`

**Issue**: Non-streaming maps slot-apply failures to HTTP 409. Streaming catches generic exceptions and emits SSE `server_error` after HTTP 200 starts. Client retry logic + observability are mode-dependent.

**Fix**: Preflight slot-apply BEFORE starting the SSE stream. If apply fails, return 409 before the stream begins. Both modes get the same failure contract.

## Simplicity persona cuts (codex-acp-fast)

Delete as redundant with behavioral tests:
- `tests/test_slot_store.py:334-353` — byte-level safetensors header assertions
- `tests/test_slot_store.py:527-546` — `test_drain_logs_each_dropped_entry`
- `tests/test_scheduler.py:415-453` — `test_apply_success_emits_structured_event`
- `tests/test_scheduler.py:497-522` — `test_apply_miss_handle_not_found_emits_structured_event`
- `tests/test_scheduler.py:562-597` — `test_apply_miss_epoch_mismatch_emits_structured_event_with_both_epochs`
- `tests/test_scheduler.py:625-664` — `test_apply_miss_guard_mismatch_emits_structured_event_with_field`

These are pure log-shape assertions on top of full behavioral coverage. Verdict: keep ONE of the log-emit tests (success path) for contract documentation; delete the other 5.

## Per-persona files (raw outputs)

- architect (oMLX): conv `b3d65c46`, handoff `26717bd1`
- security (oMLX): conv `c2abde67`, handoff `695a0103`
- simplicity (oMLX): conv `0dbaf607`, handoff `a94cdbdf`
- data-correctness (oMLX): conv `883edabb`, handoff `62ddd76d`
- architect+security+data (llamactl): conv `40336d72`, handoff `723241db`

## Recommended action plan

Two follow-up phases:

**v2.5 — Correctness fixes (BLOCKER for production)**:
- P0-1: atomic consume + non-destructive on mismatch
- P0-2: prompt-prefix hash in manifest + apply-time check
- P0-3: drop "default" handle fallback OR scope by session
- P0-4: don't strip vendor fields from cache key on oMLX routes (or reject user-supplied at ingress)

**v2.6 — Hardening (BEFORE wider rollout)**:
- P1-1: OneShotBindTable bounds + LRU eviction
- P1-2: filename↔handle bijective canonicalization
- P1-3: redact epochs from logs
- P1-4: capability probe TTL + invalidation
- P1-5: scheduler→server dependency injection
- P1-6: synchronous try_apply (drop new_event_loop)
- P1-7: preflight slot-apply before SSE stream
- Simplicity cuts (delete 5 log-shape tests)

Each can be 1-2 dispatches. Total scope ≤1200 LoC across both repos.

## Open questions for user

1. Are P0 findings blockers for the canary, or are we OK proceeding with the canary as a "smoke" against known-buggy implementation?
2. Should v2.5 + v2.6 be dispatched immediately, or queued for next session?
3. Does the prompt-prefix hash design need a brainstorm pass (it's a new manifest field — touches save/restore/apply and back-compat)?
