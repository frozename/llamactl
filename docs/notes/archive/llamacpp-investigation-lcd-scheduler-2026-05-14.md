# llama.cpp `--lookup-cache-dynamic` and `-np 2` scheduler impact investigation

## TL;DR
The most likely root cause is **cache locality loss due to per-slot speculative cache + slot-level request interleaving**, not a flag parsing issue: `--lookup-cache-dynamic` is parsed and passed correctly, but each slot owns its own speculative n-gram cache (`slot.spec`) and cache entries are not shared across slots. With `-np 1`, every request for the same JSON workload reuses the same slot and warms the same context; with `-np 2`, work is split across two slots and each slot gets roughly half the opportunity to build effective repeated n-gram context, which can collapse dynamic-draft benefits. Confidence: **high (~0.8)**. The key confirmation would be per-slot hit-rate telemetry showing `common_speculative_draft()` hits concentrating in one slot when `-np 1` and splitting roughly evenly (or not rising above warm-up noise) at `-np 2`.

## Code trace

1. **Flag parsing and common params**
- CLI flag definition and capture: `common/arg.cpp:1229-1234` defines `--lookup-cache-dynamic`/`-lcd` and assigns `params.speculative.lookup_cache_dynamic`.
- The flag is part of `common_params_speculative`: `common/common.h:312-333`.
- This travels via `common_params` into server options as `params_base.speculative` and into each server slot’s speculative state at startup.

2. **Server startup flow to speculative state**
- Server reads global/common params (including speculative fields) during startup: `tools/server/server.cpp` calls into `common_params_parse` and `server_init()`.
- For each slot initialized by `-np`, `server-context.cpp:~900+` sets one `server_slot` and creates slot-local speculative state via:
  - `slot.spec = common_speculative_init(params_base.speculative, slot.ctx);`
- So `--lookup-cache-dynamic` does reach server runtime through `params_base.speculative` into each slot’s `slot.spec`.

3. **Cache structures and lookup-dynamic input contract**
- N-gram cache state is in `common/ngram-cache.h` (`common_speculative_state_ngram_cache`, plus `common_ngram_cache` helpers): `common/ngram-cache.h:73-99, 120+`.
- Key update contract and cache behavior is in `common/ngram-cache.cpp:12-23, 146-198, 200+`:
  - cache lookup checks are attempted from `ngram_cache_context`, then `ngram_cache_dynamic`, then `ngram_cache_static`.
  - update requires **append-only prompt history** (`"inp_data can ONLY BE APPENDED TO"`), so reuse depends on a coherent growing per-slot token history.

4. **Where lookups are consumed in speculative drafting**
- `common/speculative.cpp` initializes state and calls:
  - `create_state_ngram_cache(...)` and `common_speculative_begin(...)`.
- Drafting path (important): in `common/speculative.cpp` (then into n-gram cache functions), speculative draft does:
  - if prompt has grown since last call, append only new prompt tokens into ngram cache context.
  - call `common_ngram_cache_draft(...)` with `(cache_context, cache_dynamic, cache_static)`.
- Server invokes draft and accept per active slot in `tools/server/server-context.cpp:2101-2116` (draft) and `2134-2144` (accept), then calls `common_speculative_accept(...)`.
- The scheduler path for which slot receives tasks is in `tools/server/server-context.cpp` (`get_available_slot`, prompt scheduling, and task launch flow), and each slot maintains its own speculative state and batch.

5. **Effect chain summary (flag → effect)**
- `--lookup-cache-dynamic` path: `common/arg.cpp` → `common/common.h` fields → `server params` → `slot.spec` → per-slot speculative state → `common_speculative_draft` → `common_ngram_cache_draft`.
- Benefit depends on **temporal locality in the same slot’s speculative state**.

## The `-np 2` gap

At `-np 2`, the runtime creates and uses **two independent slot states**, each with its own speculative cache object (`slot.spec`). There is no shared n-gram context cache object across slots in this path:

- slot-local state creation: `slot.spec = common_speculative_init(params_base.speculative, slot.ctx);` in server slot initialization.
- no server-wide shared `ngram_cache_dynamic` singleton is created or looked up in scheduler paths.

Concrete issues that explain observed behavior:

1. **No cache sharing across slots**
- Dynamic cache is only part of each slot’s speculative state (`common_speculative_state_ngram_cache`) and therefore each slot has an isolated cache, so inter-slot reuse does not aggregate hits.
- This is consistent with `get_n_draft_max` / scheduling behavior that can alternate work across slots (task launch and queueing in `server-context.cpp`/`server-queue.cpp`).

2. **No persistence of `-lcd` in this execution mode**
- In the cache creation path, save flags are explicitly false (`bool save_dynamic = false; bool save_static = false;`) so dynamic data is not persisted during runtime.
- That means repeated startup/session benefits are limited to current in-memory slot state.

3. **Append-only update contract + short JSON tasks**
- Since cache update expects incremental prompt appends, frequent short request cycles with high scheduler churn mean a slot may never get enough sequential token history to produce stable lookup hits.
- With one slot, short JSON runs still accumulate in the same slot (especially under bursty similar prompts), enough to show benefit in your measurements.

4. **Speculative path is per-slot, not coordinated across parallel slots**
- There is a TODO near the draft call in `server-context.cpp` (`TAG_SERVER_SPEC_REWORK`) indicating draft/context sharing across slots is considered future work; current implementation runs shared-server batching per slot.
- Practically: `-np 2` increases concurrency by duplication of slot state, not by sharing speculative memory.

Relevant code points to support this:
- `tools/server/server-context.cpp` slot creation + per-slot `slot.spec` init.
- `tools/server/server-context.cpp` draft/accept loop.
- `tools/server/server-context.cpp` scheduling (`get_available_slot`, prompt reuse branch).
- `tools/server/server-queue.cpp` task deferral/retry behavior when slots are busy, affecting per-slot occupancy patterns.
- `tools/server/server-task.cpp` does not read `lookup_cache_dynamic` from request JSON, so the flag is global startup configuration only.

## Proposed fix sketch

### 1) Most likely actionable local change (recommended)
Introduce a **shared runtime n-gram cache object per `llama_context` model instance** (or explicit “model cache shard”), while keeping per-slot/context-sensitive state for recent prompt context.

Pseudo-diff:
- In common speculative state:
  - add optional shared pointer/reference to a `common_ngram_cache` for `lookup_cache_dynamic`.
  - keep `cache_context` per-slot as today.
- In `common_speculative_draft`:
  - query order: `context -> shared_dynamic -> static` and optionally decay/namespace dynamic entries with model+slot-independent key.
- In state creation:
  - construct one shared dynamic cache in server startup from path or config; pass shared handle into each `slot.spec`.

This preserves correctness while recovering cache locality across slot interleaving.

### 2) Alternative: per-slot warmup + pinning
- On workloads with high similarity (JSON benchmarking), pin repeatable requests to a single slot (`n_parallel` unchanged) using scheduler affinity.
- This avoids architectural change but loses true parallelism and is likely not desirable unless benchmark-only.

### 3) Add instrumentation to prove/measure cause
- Instrument `common_speculative_draft` or `common_ngram_cache_draft` with counters:
  - `lookup_dynamic_hits`, `lookup_static_hits`, `lookup_context_hits`, total_drafts, bytes/token count.
- Expose via existing metrics endpoint/log line (wherever server metrics are emitted in `tools/server`) or new debug line gated by `--verbosity`.
- Track by slot-id to validate whether `-np 2` only halves or resets hit-rate versus `-np 1`.

### 4) Scheduler-side experiment to validate hypothesis quickly
- Add temporary mode that disables `get_available_slot` LRU interleave and forces a single slot affinity for a repeatable request class; compare cache hit/miss and throughput.
- If improvement matches `-np 1`, it strongly confirms slot-local cache locality is the root mechanism.

## Confidence and unknowns

Confidence: **high on root-cause direction**, medium on exact proportion of loss.

What I’d still verify before implementation:
1. Collect per-slot lookup stats (`context/dynamic/static`) under `-np 1` and `-np 2` (same prompt mix).
2. Capture per-slot occupancy timeline (`slot assignment` over time) for JSON workload to show interleave frequency.
3. Confirm whether context tokens per slot stabilize before steady-state in `-np 2`.

If per-slot dynamic hits are nearly equal but still low, we then need to test an additional hypothesis: prompt variance / scheduler rerouting is too high for n-gram locality even before slot split.

## Upstream-PR readiness

This is **upstream-PR-worthy with moderate scope** if implemented as:
- minimal, non-breaking change
- default behavior preserved
- configurable fallback preserving existing semantics
- metrics added for validation and regression prevention

Why it’s PR-worthy:
- It addresses a real throughput bug pattern for users enabling `-lcd` with parallel decoding.
- It likely generalizes to other draft decoding workloads.

Why it may be local-fork-only:
- If upstream wants strict determinism / memory behavior changes and prefers keeping slot-local speculative state, shared-cache changes may need additional design around concurrency and invalidation across prompts.
- In that case a scheduler affinity fallback (pinning similar requests to one slot) could be introduced as local opt-first change.
