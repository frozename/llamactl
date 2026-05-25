# oMLX Slot Save/Restore HTTP API Spec (Slice A.0, plan-only)

## Goal

Add a llama.cpp-compatible slot save/restore API to oMLX so llamactl can remove the current oMLX KV-degraded path and reuse warm KV state across requests, without changing `UpstreamSlotClient` wire behavior in llamactl.

## Wire contract

### Endpoint

`POST /slots/{slot_id}?action=save|restore`

### Request body

```json
{"filename":"<basename>"}
```

Rules:
- `filename` must be a basename relative to `--slot-save-path`.
- Absolute paths and path traversal (`..`) are rejected with HTTP 400.

### Success responses

`action=save`:

```json
{"id_slot":0,"filename":"abc.kvslot","n_saved":12345}
```

`action=restore`:

```json
{"id_slot":0,"filename":"abc.kvslot","n_restored":12345}
```

Notes:
- `n_saved`/`n_restored` are token counts restored/saved for compatibility with `packages/core/src/kvstore/upstreamSlots.ts:47` and `:79`.
- `id_slot` echoes path param.

### Error responses

- HTTP 400: invalid action, missing filename, invalid filename, absolute path, path traversal.
- HTTP 404: restore target file does not exist.
- HTTP 409: restore guard mismatch (model/context/quant/guard tuple mismatch).
- HTTP 500: serialization/deserialization/runtime failure.
- HTTP 503: slot API disabled because `--slot-save-path` is unset.

### 500 schema (structured)

```json
{
  "error": {
    "code": "slot_serialize_failed",
    "message": "failed to serialize KV cache",
    "details": {"slot_id":0,"filename":"abc.kvslot"}
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
  - Resolve target model engine similarly to existing server routes that inspect engine pool (`omlx/server.py:1640-1724`).
  - Return 503 when slot feature disabled.

- `omlx/settings.py`
  - Add `slot_save_path: Optional[str]` to settings model and env/CLI plumbing alongside cache settings (`omlx/settings.py:246-310`, `:857-864`, `:948-954`).
  - Keep default disabled (`None`).

- `omlx/cli.py`
  - Add `--slot-save-path <dir>` under `serve` options near cache flags (`omlx/cli.py:579-609`).

- `omlx/scheduler.py`
  - Add explicit slot state capture/apply entry points on top of existing request cache objects (`Request.prompt_cache`, `cached_tokens`, `remaining_tokens` fields in `omlx/request.py:131-139`).
  - v1 slot mapping: only slot `0`, bound to currently active loaded model, with clear 409 for unsupported/mismatch states.

- New module (proposed): `omlx/slot_store.py`
  - Serialize/deserialize full request KV snapshot payload.
  - Centralize filename validation, guard checks, and atomic writes.

## Slot mapping decision (v1)

- Introduce an explicit slot concept at HTTP layer, independent of `request_id`.
- v1 supports slot `0` only.
- This aligns with `--max-concurrent-requests=1` fast path and avoids coupling restore semantics to transient request UUIDs.
- Multi-slot allocation and concurrent restore semantics are deferred.

## Disk format

Format choice: `.npz` container with JSON manifest sidecar inside the archive (`manifest.json` entry), plus per-layer tensor arrays.

Why `.npz` for v1:
- MLX/Numpy ecosystem friendly.
- Simple random-key array packing.
- Lower implementation risk than introducing a new safetensors schema for whole-request snapshots.

Trade:
- safetensors is already used by paged cache blocks (`omlx/cache/paged_ssd_cache.py:1281-1304`) and boundary snapshots (`omlx/cache/boundary_snapshot_store.py:9-13`), so a safetensors v2 could be a follow-up if uniformity is preferred.

### Layout

- File path: `<slot_save_path>/<filename>`
- Archive members:
  - `manifest.json`:
    - `format_version`
    - `model_fingerprint`
    - `model_id`
    - `model_path`
    - `ctx_size`
    - `quant_bits`
    - `workload`
    - `workload_epoch`
    - `n_tokens`
    - `num_layers`
    - `layer_cache_types`
    - `layer_meta_states`
  - `layer_{i}_state_{j}.npy` tensor payloads (N-state compatible, matching scheduler extraction patterns in `omlx/scheduler.py:3188-3250`).

### Size estimates (Qwen3.6-35B-A3B-4bit order-of-magnitude)

Using oMLX memory formula (`estimate_prompt_kv_bytes`) in `omlx/memory_monitor.py:341-364` and model config values:
- `num_hidden_layers=40`, `num_key_value_heads=2`, `head_dim=256` in `.../Qwen3.6-35B-A3B-4bit/config.json:669-730`
- `dtype=bfloat16` (`2` bytes) in `.../config.json:666`

Upper-bound bytes/token (assuming all 40 layers carry KV): `40 * 2 * 256 * 2 * 2 = 81,920 B/token`.

Approximate raw KV payload:
- 32,768 tokens: 2,684,354,560 B (~2.50 GiB)
- 65,536 tokens: 5,368,709,120 B (~5.00 GiB)
- 262,144 tokens: 21,474,836,480 B (~20.00 GiB)

Important nuance:
- oMLX can compute actual `num_kv_cache_layers` dynamically for hybrid architectures (`omlx/scheduler.py:5795-5806`), so real payload may be materially smaller than this upper bound.

## Safety guards

Restore must hard-fail (HTTP 409) if any guard mismatches:

- Model fingerprint mismatch.
- Context size mismatch.
- Quant configuration mismatch.
- Secondary tuple mismatch:
  - `workload`
  - `quant_bits`
  - `ctx_size`
  - `workload_epoch`

Secondary tuple mirrors current llamactl KV matching policy:
- lookup constraints in `packages/core/src/kvstore/policy.ts:22-27`
- kv metadata extraction in `packages/core/src/openaiProxy.ts:437-464`
- registry schema fields in `packages/core/src/kvstore/storage.ts:74-93`

Fingerprint definition (v1 spec):
- `sha256` over canonicalized manifest of model artifacts under `EngineEntry.model_path` (`omlx/engine_pool.py:50-56`), including:
  - relative filename
  - file size
  - file mtime
  - optional hash of `config.json`

This is a practical safety guard with low startup overhead; full content hashing of all weights is deferred.

## Phased TDD plan

## Phase 1: Settings/CLI plumbing

RED test (Python):
- Add failing tests in `tests/test_settings.py` and `tests/test_cli.py` for:
  - `--slot-save-path` parsing
  - env override (`OMLX_SLOT_SAVE_PATH`)
  - default disabled (`None`)

GREEN impl:
- Add setting field + env/CLI wiring.

VERIFY:
- `pytest tests/test_settings.py tests/test_cli.py`

## Phase 2: HTTP contract skeleton (disabled behavior first)

RED test:
- Add integration tests in `tests/integration/test_server_endpoints.py`:
  - `POST /slots/0?action=save` returns 503 when disabled
  - same for restore
  - auth behavior matches other protected endpoints

GREEN impl:
- Add `/slots/{slot_id}` route and action parsing.
- Return structured 503 message.

VERIFY:
- `pytest tests/integration/test_server_endpoints.py -k slots`

## Phase 3: Filename validation + filesystem semantics

RED test:
- Add endpoint tests for invalid filenames:
  - absolute path -> 400
  - `../` traversal -> 400
  - missing file on restore -> 404

GREEN impl:
- Add strict basename validator and resolve path under configured slot dir.

VERIFY:
- `pytest tests/integration/test_server_endpoints.py -k \"slots and (invalid or restore)\"`

## Phase 4: Scheduler slot snapshot save path

RED test:
- Add unit tests in `tests/test_scheduler.py` (or new `tests/test_slot_store.py`) for:
  - extracting a save payload from current cache state
  - persisted manifest includes guard fields and `n_saved`

GREEN impl:
- Add slot snapshot extraction and serializer module.

VERIFY:
- `pytest tests/test_scheduler.py -k slot`

## Phase 5: Restore path + guard enforcement

RED test:
- Add tests for restore success and each 409 mismatch branch:
  - model fingerprint
  - ctx size
  - quant bits
  - workload/workload_epoch

GREEN impl:
- Implement restore loader and guard checks before state injection.

VERIFY:
- `pytest tests/test_scheduler.py tests/integration/test_server_endpoints.py -k \"slot and restore\"`

## Phase 6: End-to-end parity check with llamactl client contract

RED test:
- Add integration test that drives exact request/response fields expected by `UpstreamSlotClient`:
  - save returns numeric `n_saved`
  - restore returns numeric `n_restored`
  - restore missing file maps 404

GREEN impl:
- Tighten response schema and error mapping.

VERIFY:
- `pytest tests/integration/test_server_endpoints.py -k \"slots and contract\"`

## Test surface

Existing test files to extend:
- `tests/test_settings.py` (new setting/env/default validation)
- `tests/test_cli.py` (new CLI flag)
- `tests/integration/test_server_endpoints.py` (HTTP contract and errors)
- `tests/test_scheduler.py` (slot extraction/apply logic)
- Optional: `tests/test_paged_ssd_cache.py` if serialization helpers are shared.

New test module (recommended):
- `tests/test_slot_store.py` for pure serializer/validator/guard unit tests.

## Out of scope for v1

- Multi-slot allocation and scheduling (slot IDs > 0).
- Cross-architecture restore portability (different MLX/runtime/hardware semantics).
- Snapshot compression and compaction.

## Rollback / disable

- Feature is opt-in via `--slot-save-path`.
- If unset, `/slots/*` returns HTTP 503 without mutating scheduler/cache state.
- Existing `/v1/*` inference behavior is unchanged, preserving current upstream-compatible behavior.

## Open questions

- Multi-model server ambiguity: when multiple models are loaded, should `/slots/*` bind to `default_model` or require an explicit model selector? Current contract has no model parameter.
- Do we standardize on `.npz` for v1, or align immediately with safetensors used by existing block cache and boundary snapshot paths?
- Should fingerprint be metadata-based (fast) or full-file-content hash (stronger, slower)?
- Should `/props` be added for parity with llama.cpp probing behavior, even though save/restore contract is sufficient for current client usage?
