# oMLX Slot v2.5 Canary Retest — 2026-05-25

After v2.5a + v2.5b + v2.5c landed on `feat/slot-api-phase-a` (tip `7b319d58`). Same canary workload `mlx-granite-3b-slot-canary-mac-mini` (port 8197, mcr=1, --slot-save-path), restarted to load v2.5 code (new pid 68076).

## Live validations (v2.5a fixes — all PASS)

| Test | Pre-v2.5a | Post-v2.5a |
|---|---|---|
| Chat with bogus handle | Generic HTTP 500 `Internal server error` | `409 {"error":{"code":"slot_handle_not_found","details":{"model":"granite-4.1-3b-4bit","request_handle":"bogus"}}}` ✅ |
| Save without handle or filename | Silent fallback to `request_handle="default"` (cross-client collision) | `400 {"error":{"code":"request_handle_required"}}` ✅ |
| Restore nonexistent | `404 slot_file_not_found` | `404 slot_file_not_found` (regression-safe) ✅ |

Phase 2's structured 409 envelope contract is now honored end-to-end. Atomic consume + explicit-handle requirements live.

## v2.5b structural verification (passes unit tests, blocked at canary)

v2.5b's `prompt_tokens` save path is correct in source. Live test:
1. Warmed cache with `Recite the names of three fruits.` chat completion
2. Tokenized via HuggingFace AutoTokenizer locally → 15 token IDs
3. Saved with `body={"model":"...","request_handle":"v25b1","prompt_tokens":[...]}` → **still failed** with `slot_serialize_failed: no cache state available for slot save`

Root cause is NOT v2.5b — it's that oMLX's BlockAwarePrefixCache in this canary workload doesn't produce cross-request hits:
- Sent IDENTICAL chat prompt twice; both reported `cached_tokens: 0` in usage
- Paged-ssd-cache dir IS growing (40MB of blocks 0-5+ persisted)
- So cache WRITES but reads never hit

Separate from slot v2; needs oMLX prefix-cache config investigation:
- Block size vs prompt length (16 tokens may not fill a block)
- Paged SSD cache read path configuration
- Eviction policy
- mcr=1 interaction with prefix-cache lookup

## v2.5c structural validation

Phase 4b log redaction + ingress strip were validated by unit tests (483 packages/core tests pass; new strip-at-ingress + epoch-prefix tests). No live llamactl-proxy → oMLX path exercised this canary because canary drives oMLX directly via curl. Will be exercised once Slice X.3 supervisor fix (commit `7e64fa3`) reaches a ModelHost workload with `useProxy: true`.

## Open follow-ups (not v2.5 scope)

1. **oMLX prefix-cache hit miss** — investigate why identical prompts report `cached_tokens: 0`. Block size? Read path? Granite-specific tokenizer issue? This is the blocker for actual production slot benefit (warm KV across requests was the whole point). Once fixed, v2.5b's path should work end-to-end.

2. **v2.6 hardening from adversarial review** (still queued):
   - OneShotBindTable bounds + LRU eviction
   - Filename↔handle bijective canonicalization
   - Capability probe TTL
   - Scheduler→server dependency injection
   - Synchronous try_apply (drop new_event_loop)
   - Simplicity persona's 5 redundant log-shape test cuts

3. **Local M4 canary** — granite-3b-4bit model files pulled to `/tmp/granite-3b-4bit-local/` (2GB). Workload manifest not created yet — deferred until prefix-cache config issue resolved (no point exercising the same broken path locally).

## Recommended next moves

- Investigate oMLX prefix-cache config; can dispatch a focused diagnostic to a codex-acp-deep agent given the cache config files + expected behavior.
- Once prefix cache hits cross-request: full v2.5b round-trip should succeed; canary will then validate `cached_tokens > 0` after restore.
- Then proceed with v2.6 hardening dispatches.

## Canary teardown

Workload still running on mac-mini pid 68076, port 8197. Keep up for prefix-cache investigation.
