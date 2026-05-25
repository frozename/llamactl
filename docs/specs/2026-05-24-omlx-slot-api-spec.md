# oMLX Slot Save/Restore HTTP API Spec (Slice A.0, plan-only)

## Goal

Add a llama.cpp-compatible slot save/restore API to oMLX so llamactl can remove the current oMLX KV-degraded path and reuse warm KV state across requests, without changing `UpstreamSlotClient` wire behavior in llamactl.

## Review inputs (traceability)

This v2 spec revision applies the convergent findings from:
- `docs/notes/adversarial-synthesis-2026-05-24.md`
- `docs/notes/adversarial-plan-omlx-2026-05-24-architect.md`
- `docs/notes/adversarial-plan-omlx-2026-05-24-simplifier.md`
- `docs/notes/adversarial-plan-omlx-2026-05-24-risk.md`
- `docs/notes/adversarial-plan-omlx-2026-05-24-integration.md`

## Hard runtime invariant

This is a hard safety invariant for v1 slot endpoints:
- If `slot_save_path` is set, `max_concurrent_requests` MUST be exactly `1`.
- Startup MUST refuse to boot slot endpoints when `slot_save_path` is set and `max_concurrent_requests != 1`.
- Startup MUST emit an explicit operator-facing log line describing the violation and the required fix.
- If the invariant is ever violated after startup (defensive runtime check), every slot request MUST return HTTP 503 with an explicit machine-readable reason (`slot_invariant_violation`) and no scheduler/cache mutation.

Identity model and model targeting:
- v1 hard-gates to `slot_id=0` only.
- Slot requests MUST include a `model` selector (`model` body field), unless the server is in explicit single-model strict mode.
- In single-model strict mode, server MUST verify exactly one resolved model target before executing save/restore; otherwise return HTTP 409.

Future identity model (v2 direction):
- Canonical identity evolves to `(model_id, request_handle)`.
- `slot=0` remains a compatibility alias only.

## Wire contract

### Endpoint

`POST /slots/{slot_id}?action=save|restore`

### Request body

```json
{"filename":"<basename>","model":"<model_id_or_alias_optional_in_strict_single_model_mode>"}
```

Rules:
- `filename` must be a basename relative to `--slot-save-path`.
- Absolute paths and path traversal (`..`) are rejected with HTTP 400.
- `slot_id` must be `0` in v1.
- `model` is required unless single-model strict mode is active and validated.

### Success responses

`action=save`:

```json
{"id_slot":0,"model":"<resolved_model>","filename":"abc.kvslot","n_saved":12345}
```

`action=restore`:

```json
{"id_slot":0,"model":"<resolved_model>","filename":"abc.kvslot","n_restored":12345}
```

Notes:
- `n_saved`/`n_restored` are token counts for compatibility with `packages/core/src/kvstore/upstreamSlots.ts`.
- `id_slot` echoes the path parameter.
- `model` echoes the resolved model binding used for the operation.

### Error responses

- HTTP 400: invalid action, missing filename, invalid filename, absolute path, path traversal, invalid slot id, missing/invalid model selector.
- HTTP 404: slot API disabled (`slot_save_path` unset), or restore target file does not exist.
- HTTP 409: save conflict while slot is active, model selection ambiguity, or restore guard mismatch.
- HTTP 423: restore attempted while slot is active (`GENERATING`, `SAVING`, or `RESTORING`).
- HTTP 500: serialization/deserialization/runtime failure.
- HTTP 503: invariant violation (`slot_save_path` enabled with `max_concurrent_requests != 1`) detected at runtime.

### 500 schema (structured)

```json
{
  "error": {
    "code": "slot_serialize_failed",
    "message": "failed to serialize KV cache",
    "details": {"slot_id":0,"filename":"abc.kvslot","model":"<resolved_model>"}
  }
}
```

## Implementation surface in oMLX

## Current request/KV architecture (evidence)

- No existing `/slots` surface in HTTP router; current routes are `/health`, `/api/status`, `/v1/*` in `omlx/server.py:1537-2140`.
- Global state currently has no slot manager (`ServerState`) in `omlx/server.py:207-230`.
- Requests are keyed by UUID-like `request_id`, not numeric slots, in `omlx/engine_core.py:312-314` and `omlx/request.py:110-139`.
- Prefill and decode are split in scheduler:
  - Waiting->running scheduling and cache application in `omlx/scheduler.py:4242-4814`.
  - External prefill before decode insert in `omlx/scheduler.py:4641-4708`.
  - Decode step loop in `omlx/scheduler.py:5406-5477`.
- Cross-request KV reuse already exists via block-aware prefix cache:
  - Fetch on request admission in `omlx/scheduler.py:3285-3311`.
  - Store on completion in `omlx/scheduler.py:5046-5156` and worker write in `omlx/scheduler.py:1020-1072`.

## Changes required (spec only)

- `omlx/server.py`
  - Add `POST /slots/{slot_id}` handler near other API endpoints and gate with `verify_api_key` (`omlx/server.py:253-294`).
  - Add strict invariant checks (`slot_save_path`/`max_concurrent_requests`) and single-model strict-mode checks.
  - Add capability exposure (`/props` parity and/or `/v1/slots/capabilities`).

- `omlx/settings.py`
  - Add `slot_save_path: Optional[str]` to settings model and env/CLI plumbing alongside cache settings (`omlx/settings.py:246-310`, `:857-864`, `:948-954`).
  - Add startup validation for `slot_save_path && max_concurrent_requests != 1`.
  - Keep default disabled (`None`).

- `omlx/cli.py`
  - Add `--slot-save-path <dir>` under `serve` options near cache flags (`omlx/cli.py:579-609`).

- `omlx/scheduler.py`
  - Add explicit slot state capture/apply entry points on top of existing request cache objects (`Request.prompt_cache`, `cached_tokens`, `remaining_tokens` in `omlx/request.py:131-139`).
  - Enforce per-slot mutex and explicit state machine behavior.

- New module (proposed): `omlx/slot_store.py`
  - Centralize filename validation, model binding, state transitions, guard checks, and atomic persistence.

## Slot mapping decision (v1)

- Introduce slot semantics at HTTP layer as a compatibility surface.
- v1 supports slot `0` only.
- Requests must bind to one resolved model target (explicit `model` or validated strict single-model mode).
- Multi-slot allocation and full `(model_id, request_handle)` identity are deferred to v2.

## Disk format

v1 SHOULD reuse oMLX's existing safetensors-based persistence primitives and cache-format versioning rather than introducing a second serialization stack:
- safetensors persistence patterns: `omlx/cache/paged_ssd_cache.py:1281-1304`
- boundary snapshot persistence: `omlx/cache/boundary_snapshot_store.py:9-13`
- scheduler-managed async persistence pipeline touchpoints: `omlx/scheduler.py:1020-1072`, `omlx/scheduler.py:5046-5156`

Recommended v1 slot artifact fields (whether embedded metadata or sidecar manifest):
- `slot_format_version`
- `model_fingerprint`
- `model_id`
- `ctx_size`
- `n_tokens`
- per-tensor `dtype`
- per-tensor `shape`
- cache-class markers (to disambiguate cache layout family)
- producer compatibility tuple (`mlx_version`, `omlx_cache_format_version`)

### Format evolution policy

- `slot_format_version` is required and monotonic.
- Reader must fail closed on unknown major versions.
- Minor additive metadata is allowed if required fields remain present.
- Every save/restore response path must emit explicit mismatch reasons when version/dtype/cache-class checks fail.

## Safety guards

Restore must hard-fail (HTTP 409) on v1 guard mismatch for:
- Model fingerprint mismatch.
- Context size mismatch.

Deferred to v1.1 unless evidence requires earlier:
- Quant configuration guard.
- Secondary-tuple guard symmetry (`workload`, `quant_bits`, `ctx_size`, `workload_epoch`) with llamactl policy.

Fingerprint definition (v1):
- `sha256` over canonicalized model artifact manifest under `EngineEntry.model_path` (`omlx/engine_pool.py:50-56`) with stable fields (filename + size + selected content-hash inputs).
- Raw mtime should not be a primary fingerprint input.

## Concurrency state machine

This section is normative and must be implemented before Phase B.

Per-slot state set:
- `IDLE`
- `SAVING`
- `RESTORING`
- `GENERATING`

Per-slot mutex semantics:
- All slot transitions and slot read/write operations are guarded by a per-slot mutex.
- No slot mutation is allowed outside mutex ownership.
- Save/restore operations must never race silently with generation.

Busy/refusal behavior:
- `save` while slot is active (`GENERATING`, `SAVING`, `RESTORING`) => HTTP 409 Conflict.
- `restore` while slot is active (`GENERATING`, `SAVING`, `RESTORING`) => HTTP 423 Locked.
- No best-effort partial snapshotting; no silent downgrade.

Transition intent (v1):
- `IDLE -> SAVING -> IDLE`
- `IDLE -> RESTORING -> IDLE`
- `IDLE -> GENERATING -> IDLE`
- Any conflicting transition request during non-`IDLE` state must refuse with status above.

## Phased TDD plan

## Phase A: capability + skeleton + wiring

RED:
- Add failing tests in `tests/test_settings.py`, `tests/test_cli.py`, and `tests/integration/test_server_endpoints.py` for:
  - `--slot-save-path` parse/env/default behavior.
  - auth parity with existing protected endpoints.
  - disabled mode returns HTTP 404 (not 503) when `slot_save_path` is unset.
  - capability discovery via `/props` parity or `/v1/slots/capabilities`.

GREEN:
- Add settings/CLI/env wiring, endpoint skeleton, auth gate, invariant checks, and disabled behavior.
- Add explicit capability surface for slots.

VERIFY:
- `pytest tests/test_settings.py tests/test_cli.py tests/integration/test_server_endpoints.py -k slots`

## Phase B: save path with memory-safe async pipeline

RED:
- Add tests for save success and busy refusal with bounded-memory behavior expectations.
- Add tests asserting no synchronous multi-GB blocking on request thread.

GREEN:
- Implement save path by reusing existing scheduler/cache async primitives:
  - background write worker and staged write flow (`omlx/scheduler.py:1020-1072`)
  - completion/store pipeline hooks (`omlx/scheduler.py:5046-5156`)
  - paged SSD cache persistence conventions (`omlx/cache/paged_ssd_cache.py:1281-1304`)
- Implement atomic publish semantics and explicit state transitions.

VERIFY:
- `pytest tests/test_scheduler.py tests/integration/test_server_endpoints.py -k "slots and save"`

## Phase C: restore path + minimal guard set

RED:
- Add restore tests for success, missing file (404), active-state refusal (423), and the two v1 guards (fingerprint + ctx size).

GREEN:
- Implement restore load/apply path under per-slot mutex.
- Enforce only v1 guards: fingerprint + ctx size.
- Defer quant guard + secondary tuple to a v1.1 follow-up unless evidence demands earlier.

VERIFY:
- `pytest tests/test_scheduler.py tests/integration/test_server_endpoints.py -k "slots and restore"`

## Phase D: cross-repo contract CI and version negotiation

RED:
- Add failing contract tests in llamactl and oMLX pairwise lane for:
  - capability negotiation presence.
  - `supportsSlots()` gating on capability, not inference.
  - save/restore response shape parity.

GREEN:
- Add version negotiation field to capability surface.
- Add pinned oMLX commit/tag contract lane and paired smoke test execution.

VERIFY:
- paired CI lane builds both repos, runs slot save/restore parity tests, and reports compatibility tuple.

## Test surface

Existing test files to extend:
- `tests/test_settings.py` (new setting/env/default validation + invariant checks)
- `tests/test_cli.py` (new CLI flag)
- `tests/integration/test_server_endpoints.py` (HTTP contract, disabled mode, busy responses, errors)
- `tests/test_scheduler.py` (state machine + save/restore logic)

New test module (recommended):
- `tests/test_slot_store.py` for serializer/validator/guard/state-machine unit tests.

## Cross-repo contract governance

- Capability negotiation is explicit, not inferred:
  - expose `capabilities.slots` in `/props`, or
  - expose `/v1/slots/capabilities` with equivalent schema.
- llamactl `UpstreamSlotClient.supportsSlots()` MUST key on capability presence/version, not field-shape inference.
- llamactl docs must pin a minimum compatible oMLX commit/tag in `docs/notes/omlx-pinned-commit.md`.
- CI must include a cross-repo contract lane that builds llamactl + pinned oMLX together and runs save/restore parity smoke tests.

## Out of scope for v1

- Multi-slot allocation and scheduling (slot IDs > 0).
- Full `(model_id, request_handle)` identity migration.
- Cross-architecture restore portability.
- Compression/compaction policy for slot artifacts.
- Quant + secondary-tuple guards (tracked for v1.1 unless evidence escalates).

## Rollback / disable

- Feature is opt-in via `--slot-save-path`.
- When `slot_save_path` is unset, slot endpoints return HTTP 404.
- If invariant violation is detected (`max_concurrent_requests != 1` while slot feature configured), slot endpoints refuse with HTTP 503 and explicit reason.
- Existing `/v1/*` inference behavior remains unchanged.

## Follow-up

- Slice X.3 (prerequisite for end-user-visible rollout): extend `useProxy` to `ModelHostSpec` and widen `kindIsModelRunWithLlamacppEngine` gate in `openaiProxy` KV path. Without this, ModelHost workloads with slot support cannot opt into proxy-routed KV via spec YAML.
- v2 identity model: move from `slot=0` alias to canonical `(model_id, request_handle)`.

## Open questions

- Final capability surface location: `/props` only, `/v1/slots/capabilities` only, or both.
- Exact `model` selector shape (required body field vs query) when not in strict single-model mode.
- Whether restore should expose optional queued mode in v1.1 (currently explicit busy refusal only).

## Revision history

- v1 (2026-05-24, commit `6c340c1`): initial spec.
- v2 (2026-05-24, this commit): revised per 4-persona adversarial-plan synthesis — see `docs/notes/adversarial-synthesis-2026-05-24.md`.
