## Architect planner — review of oMLX slot API spec

### Top 5 issues with the 6-phase plan (highest impact first)
1. Slot identity model is under-specified and can break correctness under real server modes.
   - Spec section: `Slot mapping decision (v1)`, `Open questions`, `Phase 5`
   - Problem: The spec introduces an explicit `slot=0` abstraction while oMLX scheduling is fundamentally request-id-centric (`Request.request_id` UUID flow) and can run multiple concurrent requests (`SchedulerSettings.max_concurrent_requests` default 8). On top of that, oMLX is a multi-model server (`EnginePool` + alias/default resolution), and `/slots/{slot_id}` has no model selector. In that shape, “slot 0” is ambiguous whenever there are concurrent requests or >1 loaded model, and restore semantics can silently target the wrong active cache state. The spec references the `--max-concurrent-requests=1` fast path, but it does not define a hard runtime gate or conflict behavior when that assumption is violated.
   - Proposed adjustment: Define the canonical identity as `(model_id, request_snapshot_handle)` and treat `slot_id` as a compatibility alias only. For v1 compatibility with llamactl, allow `/slots/0` only when strict preconditions hold (single resolved model + scheduler concurrency mode that guarantees one active mutable cache target), otherwise return 409 with a machine-readable conflict reason. Add an explicit `model` selector (query or body field) or a required capability-mode default to remove multi-model ambiguity.

2. Phase ordering hides contract-critical dependencies (capability probe, auth shape, model routing).
   - Spec section: `Phase 1: Settings/CLI plumbing`, `Phase 2: HTTP contract skeleton`
   - Problem: Doing settings/CLI first and HTTP skeleton second looks clean, but the hardest decisions are protocol-level, not flag plumbing: capability discovery (`/props` is currently absent in oMLX, while llamactl’s client probes it), auth parity (`verify_api_key` gating), model resolution, and failure-mode mapping. If those are discovered after CLI/settings land, early tests can pass while the wire contract remains incomplete for real callers.
   - Proposed adjustment: Merge Phases 1+2 into one “capability-first HTTP skeleton” phase: implement endpoint shape, auth behavior, explicit disabled response, and capability discovery (`/props` or versioned `/v1/slots/capabilities`) before deep scheduler work. Then wire CLI/env flags directly into that behavior. This reduces rework and surfaces cross-repo contract mismatches immediately.

3. Persistence format choice (`.npz + manifest`) is misaligned with existing oMLX cache durability patterns and upgrade safety.
   - Spec section: `Disk format`, `Safety guards`
   - Problem: The spec picks `.npz` while existing oMLX KV persistence paths already use safetensors with explicit cache-format versioning, metadata for layer/cache topology, dtype handling (including BF16 paths), and compatibility guards/polyfills. Introducing a second serialization stack for full-slot snapshots increases maintenance surface and compatibility risk across MLX/runtime upgrades. The manifest fields listed are useful, but they are not sufficient alone to guarantee deserialization safety when cache internals evolve.
   - Proposed adjustment: Reuse the existing safetensors-centered serializer primitives (or a shared storage abstraction) and add an explicit `slot_format_version` with forward/backward compatibility rules. If `.npz` is kept, formalize a strict schema contract (dtype, shape, endian, cache class markers, model-cache config, version negotiation) and add upgrade tests across at least two MLX/oMLX versions before declaring the format stable.

4. Save-path memory behavior is underspecified for multi-GB KV snapshots.
   - Spec section: `Phase 4`, `Size estimates`
   - Problem: The spec correctly calls out multi-GB payload sizes, but the phase plan does not require a bounded-memory write path. oMLX’s existing cache pipeline is careful here: it extracts/evals on inference thread, defers heavy byte extraction to a background worker, and uses async write queues to avoid blocking generation. A naive slot-save implementation can double-buffer KV data (GPU + CPU + archive buffers), causing memory spikes and latency cliffs precisely at high-context workloads.
   - Proposed adjustment: Make memory-safe IO a phase requirement, not an implementation detail: define bounded queue/backpressure, async background writer behavior, and peak-memory acceptance criteria. Reuse scheduler/cache worker patterns already present in `scheduler.py` + paged SSD managers instead of implementing a separate synchronous snapshot writer.

5. Cross-repo API governance and CI are too weak for a forked upstream dependency.
   - Spec section: `Phase 6: End-to-end parity check with llamactl client contract`
   - Problem: Phase 6 validates response fields (`n_saved`/`n_restored`) but does not define a sustained compatibility strategy between llamactl and a separate oMLX fork that can drift from upstream internals. Once merged, llamactl depends on wire semantics, guard behavior, and error mapping stability; internal scheduler refactors in oMLX can break that contract without being caught by single-repo tests.
   - Proposed adjustment: Add explicit API versioning/capabilities and a cross-repo contract CI lane: llamactl should run slot-contract tests against pinned oMLX commits (and preferably a small version matrix), with clear minimum supported API version rules and fail-fast behavior when capabilities are missing or downgraded.

### What's well-designed about the plan (one paragraph)
The spec’s strongest property is that it grounds the proposed API in real existing primitives instead of inventing a fresh cache architecture: it correctly identifies that oMLX already has substantial KV persistence machinery, defines compatibility with llamactl’s current wire expectations (`filename` request body and `n_saved`/`n_restored` response fields), and stages delivery with TDD phases that keep disabled behavior and guard enforcement explicit. The attention to guard tuples and rollback-safe disabled mode is also good operationally.

### Suggested re-ordering or new phases (if any)
1. Phase A (new): Contract and capability decisions first.
   - Lock identity model (`slot alias` vs canonical handle), model scoping, concurrency constraints, and API version/capability endpoint.
2. Phase B (merge of current 1+2): HTTP skeleton + auth + disabled behavior + CLI/env wiring.
   - Include `/props` or `/v1/slots/capabilities` parity required by llamactl probing.
3. Phase C (current 3): Filename and filesystem validation.
4. Phase D (split current 4): Persistence engine choice and format/version contract.
   - Decide safetensors reuse vs npz with explicit compatibility matrix.
5. Phase E (current 4+5): Save and restore implementation with memory-safe async pipeline and guard enforcement.
6. Phase F (expanded current 6): Cross-repo CI contract lane and drift-detection policy.
