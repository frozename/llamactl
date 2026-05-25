# oMLX Slot API v2 — Adversarial-Plan Synthesis (2026-05-25)

Synthesized phased TDD plan from 3-persona adversarial-plan fan-out on `docs/specs/2026-05-25-omlx-slot-api-v2-spec.md`. Personas: simplifier (codex-acp-fast), risk (codex-acp-deep), integration (codex-acp-deep). Synthesizer: codex-acp-deep. No Anthropic agents used (Anthropic 7-day at 100%).

## Key synthesis decisions

- **Drop** the new `/v1/slots/*` REST surface, PendingRestoreRegistry, TTL eviction, background GC, list/delete/capabilities endpoints. Simplifier said cut all of it; risk + integration didn't push back.
- **Keep** v1 `/slots/{id}?action=...` surface; just extend payload schema with optional `request_handle`.
- **Add** one-shot bind table keyed by `(model_id, request_handle)` storing serialized bytes (not live mlx tensors — risk's P0 cross-thread Metal residency concern).
- **Add** `restore_epoch` token returned from restore + required on next chat-completion — closes risk's P0 restore/admission race deterministically without registry GC machinery.
- **Hard 409 + consume** on mismatch (no silent fall-through to prefill). Single unambiguous policy per risk's "DO NOT SHIP UNTIL #1".
- **Fail-closed capability negotiation** — explicit `slots: { api_version: 2, supports_request_handle: true }` bit in oMLX `/props`; llamactl `supportsRequestHandle()` checks it. No v2 semantics if bit absent.
- **Exclude** `x_omlx_request_handle` + `x_omlx_restore_epoch` from llamactl response-cache key hash (integration's P1 — would fragment cache otherwise).

## Phased plan

### Phase 1 — Lock wire contract + capability fail-closed (≤350 LoC)

Touches oMLX + llamactl. Can split into:
- **Phase 1a (oMLX)**: extend save/restore payload schema with optional `request_handle`; add explicit capability bit to `/props`; preserve v1 alias shape.
- **Phase 1b (llamactl)**: update `UpstreamSlotClient.supportsRequestHandle()` from "any object" probe to explicit `supports_request_handle` check.

**RED**: contract tests on both sides (existing v1 still works; new field accepted; capability bit present; llamactl probe returns true only with explicit bit).

**Commit**: one per repo. `slots: add explicit request-handle capability contract` (oMLX); `core/kvstore: capability-aware supportsRequestHandle` (llamactl).

### Phase 2 — Apply-linkage in oMLX (≤500 LoC)

Replace `_slot_v2a_last_loaded` scratch with one-shot bind table keyed by `(model_id, request_handle)`. Store serialized bytes only. Restore returns `restore_epoch`; completion must present it. Hard 409 + consume on mismatch.

**RED**:
- Real E2E (no stub): save → restore(request_handle) → next chat completion with handle → `cached_tokens > 0` + measurable prefill skip.
- Hard 409 + consume on epoch mismatch.
- Ordering: restore returns `restore_epoch`; completion presents it.
- `n_saved` semantic: pin to full cached-token count.

**GREEN**: one-shot bind table; deserialize on admission thread (not at restore time — Metal residency fix). Consume entry on apply success OR on hard 409 mismatch.

**Commit**: `slots: apply restored cache to next matching completion`.

### Phase 3 — llamactl proxy injection (≤450 LoC)

Inject `x_omlx_request_handle` + `x_omlx_restore_epoch` after successful restore in `openaiProxy` — only when capability bit `supports_request_handle=true`. Exclude both fields from response-cache key hash.

**RED**:
- After successful restore, forwarded completion includes both fields.
- No injection when capability absent / restore failed / API v1 server.
- Response-cache test: both fields excluded from canonical hash.

**GREEN**: gated handle+epoch injection; update `cache-identity/canonical.ts` ignore list.

**Commit**: `proxy: inject omlx slot handle/epoch behind capability gate`.

### Phase 4 — Observability + rollback proof + canary (≤300 LoC)

Counters/log fields in BOTH repos: apply success rate, miss reasons (`capability_missing`, `epoch_mismatch`, `handle_not_found`, `409_mismatch`). Rollback test: v2 → v1 → v2 with explicit handling of stale one-shot binds (cleared or ignored deterministically). Canary script.

**Commit**: `slots: add apply/miss observability and rollback-safe rollout checks`.

## Trade-offs

- One-shot bind table is the bare minimum bridging state required to make "restore now, apply on next request" actually work. NOT a general registry — single entry per (model, handle), consume-on-apply, no TTL needed (one-shot + epoch token closes the race window).
- `restore_epoch` adds wire-shape complexity but eliminates GC/eviction race classes that the registry approach would otherwise need TTL + monotonic-time fixes for.
- Capability fail-closed means v2 oMLX server with v1 llamactl client = no v2 behavior, no error — silent downgrade is acceptable here since v1 still works.
- We do NOT add list/delete REST endpoints. Operators inspect/clean slot files via filesystem (`ls $slot_save_path/$model/`, `rm`).

## Open questions

1. Is `restore_epoch` mandatory when `x_omlx_request_handle` is present? Synthesis recommends yes, always — eliminates a class of races without conditional code paths.
2. Final 409 error schema: pick one stable code, e.g. `slot_apply_epoch_mismatch` vs `slot_handle_not_found`, with structured details.
3. `n_saved` vs `n_computed` naming — leave as `n_saved` for back-compat unless tooling demands clarity.
4. Should one-shot bind entries have a safety-fuse monotonic expiry (e.g., 60s)? Synthesis: keep consume-only for v2; add if production evidence shows orphaned entries accumulate.

## Inputs (artifacts in t1)

- spec: `docs/specs/2026-05-25-omlx-slot-api-v2-spec.md`
- simplifier conv: `conv-2fd556c4-f0ae-474e-a88c-700368ba5855`, handoff `245d753b-1945-4fc0-8194-d8c309522f5e`
- risk conv: `conv-602b3991-2434-4762-a284-f125789a6729`, handoff `101ce797-15c3-427d-8372-27253c1c3db3`
- integration conv: `conv-7b9dc0a8-96c9-473d-93dd-e927aef75b03`, handoff `64918505-1c5a-4fb3-8440-4c4ec35b2a23`
- synthesizer conv: `conv-9983ee89-74bd-43f1-859e-7e9c36be1a0e`, handoff `fc7c2c5f-5621-4c80-9db7-4245b57ae6c1`
