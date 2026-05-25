## Boundary/failure-mode review — session diff 80eac87..61144b4

### Top 5 failure modes (likeliest-to-fire first, with prod impact)
1. Anthropic stream translator drops any SSE frame that includes `event:`/`id:` lines
   - File: packages/core/src/anthropic/translateStream.ts:295
   - Trigger: Upstream starts emitting spec-valid SSE frames with both `event:` and `data:` lines (or `id:` lines). The parser marks any non-`data:` line as `unknownLine`, then discards the entire frame even if `data:` is valid JSON.
   - Symptom: Anthropic clients see missing content/tool deltas (possibly only terminal `message_delta` + `message_stop`). Tool calls can disappear completely while upstream looks healthy.
   - Detection signal: `translator_unknown_event_total()` climbs quickly; add a regression test with `event: message\ndata: {...}` expecting normal translation (currently fails).
   - Fix priority: high

2. SSE response-cache path can persist truncated streams as valid cache entries
   - File: packages/core/src/openaiProxy.ts:892
   - Trigger: Upstream returns `200 text/event-stream` but closes early (mid-content/mid-tool-args) without semantic completion (e.g., no `[DONE]`). Cache persistence reads whatever bytes arrived via `arrayBuffer()` and stores them whenever status is `200` and deterministic gate passes.
   - Symptom: First request may partially succeed; subsequent warm hits deterministically replay the same truncated SSE forever until eviction, creating stable bad outputs.
   - Detection signal: Cached SSE entries ending without `[DONE]` or expected terminal event; reproduce with an upstream that closes stream early and check second call equals truncated first.
   - Fix priority: high

3. Warm KV lease/state cleanup can be skipped if response-cache stream read throws
   - File: packages/core/src/openaiProxy.ts:1208
   - Trigger: Warm-hit path reserves + activates KV entry (`maybeKvLookup`), then `maybePersistResponseCache` attempts `upstream.arrayBuffer()`. If that read throws (mid-stream transport error), `proxyOpenAI` exits before `maybePersistKv`, so `kv.runtime.registry.release(...)` and `warmHitLease.release()` in `maybePersistKv`'s `finally` never run.
   - Symptom: Entry can remain stuck `active`/`reserved`; future reserves/evictions degrade, warm-hit behavior becomes inconsistent, and slot allocator pressure increases.
   - Detection signal: After induced mid-stream read failure, registry row state remains non-idle; `slot_eviction_blocked_active_request` logs increase.
   - Fix priority: high

4. KV schema migration is not crash-safe across ALTER + version update boundaries
   - File: packages/core/src/kvstore/storage.ts:68
   - Trigger: Power loss/process crash between `ALTER TABLE ... ADD COLUMN` and `UPDATE schema_version`. On restart, migrator re-runs same step from stale version and `ALTER` can fail with duplicate-column errors.
   - Symptom: Agent/proxy fails to open KV store at startup; cache path effectively bricked until manual DB repair.
   - Detection signal: Startup errors mentioning duplicate column during `runMigrations`; DB has column present while `schema_version` is lower.
   - Fix priority: high

5. Response-cache stores `200` JSON error envelopes as successful deterministic hits
   - File: packages/core/src/openaiProxy.ts:907
   - Trigger: Deterministic request, upstream returns `200 application/json` with an error envelope/body that is semantically a failure (`{"error": ...}`), not a normal completion. Cache logic only gates on HTTP status + content type.
   - Symptom: Poisoned cache returns repeated synthetic "success" failures on all warm hits for that prompt/model until eviction.
   - Detection signal: Cached payload has top-level `error` and no valid completion fields (`choices`); warm-hit rate rises while user-facing failures repeat.
   - Fix priority: medium

### Lower-priority observations (bullets)
- Concurrent same-prefix requests do not serialize around warm-hit reuse: one request can win `reserve`/warm-restore while another falls back to cold prefill, causing duplicate upstream work instead of coalescing (`packages/core/src/openaiProxy.ts:754`, `packages/core/test/kvstore.raceTransitions.test.ts:122`).
- `sweepOrphanSlotFiles` is currently not wired into the hot path, so the specific sweeper-vs-restore race is latent today; once scheduled concurrently, deleting by filename after registry disappearance can still race with in-flight restore/save unless state-aware coordination is added (`packages/core/src/kvstore/orphanSweep.ts:17`).
- `workloadEpoch` includes `startedAt` wall-clock text; any restart with clock adjustments changes epoch and invalidates prior KV hits. This is safe but can produce cache churn/flapping under frequent clock corrections (`packages/core/src/kvstore/workloadEpoch.ts:15`).
- Supervisor startup proxy resolution is one-shot and manifest-dependent: if workload YAML is missing at startup, it logs warning and keeps fallback URL; if fallback URL is stale, probe routing does not self-heal mid-loop (`packages/cli/src/commands/supervisor.ts:100`, `packages/cli/src/commands/supervisor.ts:324`).
- `--no-auth` bind restriction is enforced before `startAgentServer` in CLI path; server binds once with configured host (no observable rebind window in this path). Direct library callers can still pass broader binds, but loopback bypass remains gated by `allowNoAuth(...)` (`packages/cli/src/commands/agent.ts:433`, `packages/remote/src/server/serve.ts:273`).
