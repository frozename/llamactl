## Simplifier review — session diff 80eac87..61144b4

### Top 5 cuts (highest reduction first)
1. Remove the full response-cache layer and keep only the KV prefix cache.
   - File: `packages/core/src/responsecache/*`, `packages/core/src/openaiProxy.ts:582-613`, `packages/core/src/openaiProxy.ts:892-936`
   - Why it's speculative: this adds a second cache with its own sqlite store, migration path, eviction policy, and registry just to optimize the narrow case where two requests are byte-for-byte identical. In the same proxy path, the KV cache already covers the more interesting warm-start case where prompts share a prefix but are not identical. The response cache is the “easy win” layer, but it also makes the system harder to reason about because the proxy now has to choose between full-response replay and prefix reuse on every request.
   - What we'd lose: identical-request repeats would no longer be instant cache hits, so deterministic repeat prompts would pay a model round-trip again. That is a real latency cost, but it is also the smaller win relative to the implementation and operational weight this layer adds.

2. Delete the multi-slot allocator path and collapse it to a single slot.
   - File: `packages/core/src/kvstore/slotAllocator.ts:1-56`
   - Why it's speculative: the allocator carries two code paths, `singleSlotBusy` and `busySlots`, but the current wiring always instantiates it as `new SlotAllocator(1)` in `packages/core/src/openaiProxy.ts:443`. That makes the multi-slot branch dead weight in the shipped session. It reads like a feature prepared for parallel warm slots, but nothing in this diff exercises that capability.
   - What we'd lose: future parallel slot experiments would need the allocator reintroduced or generalized later. For this diff, though, no user-visible behavior depends on `maxSlots > 1`, so the practical loss is zero today.

3. Remove the orphan sweep helper and make slot cleanup explicit rather than ambient.
   - File: `packages/core/src/kvstore/orphanSweep.ts:1-67`, `packages/core/src/kvstore/index.ts:14-15`
   - Why it's speculative: this is a standalone scanner for stale `.kvslot` files, but the current code does not show it being scheduled automatically anywhere in the hot path. That means it is extra filesystem traversal, extra branches, and extra tests for behavior that appears to be on-demand only. If it is not running routinely, it is not a lifecycle mechanism; it is a maintenance command.
   - What we'd lose: stale on-disk slot files would accumulate until some explicit cleanup path runs. That is annoying, but it is easier to explain and operate than a half-hidden sweeper with no obvious cadence in the product path.

4. Drop the workload-epoch fingerprint helper and replace it with a simpler restart marker.
   - File: `packages/core/src/kvstore/workloadEpoch.ts:1-53`, `packages/core/src/openaiProxy.ts:504`, `packages/core/src/kvstore/policy.ts:1-35`
   - Why it's speculative: the helper hashes `pid + startedAt + rel + argsHash` to derive a cache key, but the code only needs to know whether the workload is still the same one that produced the slot. The current helper is more like a content-addressed identity scheme than a restart guard, and the extra fields make the invalidation story harder to audit. The reportable behavior here is simple: if the workload restarted or changed args, do not reuse the slot.
   - What we'd lose: a little extra protection against accidentally reusing a slot across a very specific kind of process reincarnation. The counterpoint is that the current fingerprint complexity buys much less than it looks like, because the actual consumer is only a single lookup guard.

5. Remove the migration scaffold from the brand-new response-cache database.
   - File: `packages/core/src/responsecache/storage.ts:1-78`
   - Why it's speculative: the response cache is new in this diff, yet it already ships with a schema-version table and a migration loop. That is a lot of ceremony for a v1 cache that has never had a v0. The migration framework reads as if the module is already a long-lived subsystem, but the actual shipped value today is just a first pass at persistence.
   - What we'd lose: a future schema bump would need a simpler ad hoc migration or a later refactor to add versioning. That cost is acceptable compared with front-loading a full migration system before the module has earned it.

### Lower-priority cuts
- The `EXT_FLAG_THINKING_VISIBLE` and `EXT_FLAG_RESPONSES_VISIBLE` plumbing in `packages/core/src/kvstore/trailer.ts:5-15` looks premature because only `EXT_FLAG_TOOL_MAP` and `EXT_FLAG_SESSION_TITLE` are consumed in `packages/core/src/openaiProxy.ts:1068-1076`.
- The proxy’s “response cache plus KV cache” story should probably be one cache plus one replay path until real traffic proves the split matters.
- The supervisor startup wiring in `packages/cli/src/commands/supervisor.ts` and `packages/remote/src/server/serve.ts` looks heavy for what is still observability-first behavior; the launchd plumbing is larger than the operational win it delivers today.
- The `--no-auth` plus plain-HTTP-on-loopback combination in `packages/remote/src/server/serve.ts:223-250` is probably two flags too many for one local-only benchmark mode.
- The anthropic translation layer is useful, but the current file split (`translateRequest`, `translateResponse`, `translateStream`, `types`) is more decomposition than the current feature surface needs.

### What earned its keep
The proxy now has a coherent, testable route from incoming OpenAI/Anthropic requests to either a direct upstream call, a KV warm hit, or a deterministic replay, and that is the part that justifies the whole slice. The model routing, first-token guard, and the basic observability around cache hits/misses all serve a real user-visible outcome today: faster repeats and safer reuse of warm state. Everything else should be trimmed until it proves it can do that work better than a simpler path.
