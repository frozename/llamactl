## Risk planner — review of oMLX slot API spec

### Per-phase failure modes (one section per phase 1-6)

#### Phase 1: Settings/CLI plumbing
- Failure mode: `--slot-save-path` is enabled while `--max-concurrent-requests > 1` and v1 still hardcodes slot `0`; operators assume per-request slot isolation but multiple active requests can race to the same logical slot target, producing nondeterministic save/restore outcomes and cache churn that looks like random model quality regressions instead of clear errors.
- Detection: Startup validation log + hard guard test: reject boot (or force read-only `/slots`) when `slot_save_path != None` and `max_concurrent_requests != 1`; add an explicit status flag in `/api/status` (`slot_api_mode: disabled|slot0_single_request_only`).
- Mitigation: Make this a configuration invariant in settings validation (not endpoint-time best effort): fail fast on incompatible concurrency, and require an explicit override flag if v1 ever allows degraded behavior.

- Failure mode: Path handling is accepted as a raw string but points to a slow, remote, or quota-limited filesystem; the API appears enabled yet save/restore latency and failure rate explode under load, creating backpressure in request handling.
- Detection: Boot-time probe (`mkdir`, write+fsync+rename+unlink) with duration histogram and a startup warning above threshold; emit `slot_io_probe_ms` and `slot_io_probe_error_total`.
- Mitigation: Treat save path readiness as part of feature enablement: if probe fails or is too slow, disable slot API (503) with explicit reason and remediation text.

#### Phase 2: HTTP contract skeleton
- Failure mode: Endpoint handlers directly touch scheduler/cache state from the FastAPI event-loop thread instead of routing through the engine’s MLX executor, racing with `scheduler.step()` and causing intermittent corruption or hard crashes under concurrent decode.
- Detection: Concurrency stress test (`/v1/chat/completions` streaming + repeated `/slots/0?action=save|restore`) and thread-affinity assertions in the slot path (log executor thread name and reject off-thread mutation in debug mode).
- Mitigation: Enforce a strict control path: slot operations must execute via `loop.run_in_executor(get_mlx_executor(), ...)` or a dedicated scheduler RPC queued onto the same single-thread execution context as decode.

- Failure mode: Response contract drifts from llama.cpp compatibility (`n_saved`/`n_restored` shape, error schema), silently breaking `UpstreamSlotClient` compatibility as clients evolve (e.g., expecting `n_kept`).
- Detection: Golden contract tests in oMLX and llamactl integration tests pinned to exact JSON fields and types; add a versioned response capability field (`slot_api_version`).
- Mitigation: Define forward-compat now: include a `capabilities` object (or version field) and a strict compatibility matrix; never remove existing fields, only add optional ones.

#### Phase 3: Filename validation + filesystem semantics
- Failure mode: Restore path does synchronous multi-GB I/O on the request thread; long restore blocks endpoint responsiveness, and dependent request paths appear hung/time out despite healthy model execution.
- Detection: Separate metrics for queue wait vs I/O duration (`slot_restore_queue_ms`, `slot_restore_io_ms`, `slot_restore_total_ms`) and server-level timeout/error spikes during large restores.
- Mitigation: Split operation into phases: schedule restore work off-thread, expose in-progress status (202/poll or streamed progress), and gate restore admission with per-slot mutex + bounded queue.

- Failure mode: Cross-filesystem atomicity assumptions break (temp file on a different mount, or fallback copy semantics), producing partially visible artifacts or non-atomic updates when save completes under stress.
- Detection: Explicitly log device IDs (`st_dev`) for temp and target paths and increment `slot_cross_fs_attempt_total`; chaos test with temp-dir override to different volume.
- Mitigation: Always create temp files inside the target directory and use `os.replace` there; if same-dir temp cannot be created, fail save hard rather than degrading to non-atomic copy.

#### Phase 4: Scheduler slot snapshot save path
- Failure mode: Save arrives during active prefill/decode and snapshots an in-flight KV state that is not a stable boundary; persisted data later restores with subtle token drift (not immediate crashes), which is the worst production failure mode.
- Detection: Add slot state machine + invariants (`IDLE|SAVING|RESTORING|GENERATING`): reject or queue save unless slot is quiescent; record `slot_save_rejected_busy_total` and include scheduler step counter/token cursor in saved manifest for forensic checks.
- Mitigation: Define save semantics explicitly: either (A) only save when request is not running, or (B) quiesce decode, synchronize, then snapshot under lock. v1 should choose A for minimal risk.

- Failure mode: Disk fills mid-save (ENOSPC/EDQUOT), producing half-written archive or manifest/data mismatch; a later restore may parse enough structure to proceed and inject corrupted KV.
- Detection: Two-phase commit markers in file format (`state: writing|committed`) plus checksum/size validation per tensor entry before publish; increment `slot_save_partial_write_total` and quarantine failed artifacts.
- Mitigation: Write to temp, fsync file + directory, validate archive completeness/checksums, then atomic replace to final name. Never write/mark manifest as committed before payload verification.

#### Phase 5: Restore path + guard enforcement
- Failure mode: Restore overwrites slot state while generation is in-flight, resetting caches under active decode and yielding corrupted output streams or abrupt request failure.
- Detection: Slot-level lock contention counters and explicit refusal logs (`restore_conflict_active_generation`); integration test where restore is issued mid-stream and must deterministically return 409/423 instead of mutating state.
- Mitigation: Serialize restore with generation on a per-slot mutex; v1 should reject restore when slot is active rather than attempting preemption.

- Failure mode: Fingerprint guard false-rejects due to metadata-only changes (mtime touch), invalidating otherwise safe cache files and causing chronic cache miss churn after backups/deploy tooling touches model files.
- Detection: Guard mismatch reason codes (`fingerprint_hash_mismatch`, `mtime_only_delta`, `ctx_mismatch`, etc.) and a metric split between hard incompatibility and metadata-only drift.
- Mitigation: Use stable fingerprint inputs (size + optional content digest of key manifests) and demote raw mtime to advisory metadata, or normalize mtimes out of the primary fingerprint in v1.

- Failure mode: MLX/NumPy dtype interpretation drifts across versions, restoring arrays with shape-compatible but semantic-incompatible dtypes (silent garbage KV).
- Detection: Persist explicit dtype + producer version (`mlx_version`, `numpy_version`, `cache_format_version`) and enforce strict restore compatibility checks with clear mismatch errors.
- Mitigation: Add a compatibility policy table in code (allowed producer/consumer ranges) and fail closed when dtype/version tuple is unknown.

#### Phase 6: End-to-end parity check with llamactl client contract
- Failure mode: oMLX returns syntactically valid save/restore fields but semantic meanings differ from llama.cpp evolution (e.g., future `n_kept`, partial restore semantics), causing llamactl planner/policy layers to make wrong decisions.
- Detection: Cross-repo contract tests (llamactl + oMLX) on every release tag and a parity fixture suite that replays canonical llama.cpp slot responses.
- Mitigation: Introduce an explicit protocol version/capability negotiation endpoint and pin llamactl behavior by capability, not by optimistic field presence.

- Failure mode: Multi-model ambiguity remains unresolved in `/slots/*` (no explicit model selector), so saves/restores accidentally bind to a different loaded/default model after pool churn.
- Detection: Include `model_id` in every save/restore response and audit log entry; alert when request model and slot model diverge.
- Mitigation: Require explicit model binding in slot operations (path/query/body) or bind slot namespace to `(model_id, slot_id)` rather than global `slot_id`.

### Top 3 cross-phase risks (issues that span multiple phases)
1. **Concurrency semantics are under-specified**: Save/restore vs decode/prefill race windows span phases 2, 4, and 5. Without a hard state machine + per-slot locking discipline, most failures surface as intermittent quality drift, not clean crashes. Mitigation: single-writer execution context + explicit slot lifecycle state transitions + busy refusal/queue semantics.
2. **Durability/atomicity gaps create silent corruption**: Large artifacts, ENOSPC, and cross-fs behavior span phases 3 and 4. If publish and validation order is wrong, restore can consume truncated state. Mitigation: commit protocol (temp write, fsync, checksum verify, atomic replace, commit marker) and quarantine on any mismatch.
3. **Contract and compatibility drift across layers**: API fields, model fingerprint policy, and dtype/version metadata span phases 2, 5, and 6. Drift causes either false rejects (cache churn) or false accepts (bad KV). Mitigation: versioned protocol + reason-coded guard failures + strict producer/consumer compatibility matrix.

### Hardest-to-detect failures (rank: which are most likely to ship to prod undetected?)
1. **Partial/in-flight snapshot accepted as valid KV**: output quality degradation appears workload-dependent and delayed.
2. **dtype/version drift with shape-compatible arrays**: restore “works” but semantics are wrong; no immediate exception.
3. **fingerprint false-reject churn**: presents as performance regression (lost cache hits), often misattributed to traffic/model changes.
4. **model-binding ambiguity in multi-model pools**: manifests as occasional wrong-context restores after load/unload churn.
