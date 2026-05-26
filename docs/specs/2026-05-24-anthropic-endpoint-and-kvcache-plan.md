# Plan: `/v1/messages` Anthropic endpoint + disk-backed KV cache

Date: 2026-05-24
Source spec: `docs/specs/2026-05-24-anthropic-endpoint-and-kvcache.md`
Synthesized from: architect (codex-acp-deep), simplifier (codex-acp-fast), risk (codex-acp-deep) personas via manual fan-out (workflow had cwd bug).
Synthesizer: in-session (Opus 4.7) — saved one claude-acp-sonnet dispatch given quota.

## Resolved conflicts

| Question | Decision | Reason |
|---|---|---|
| SQLite vs JSON registry | **SQLite** (user-confirmed) | Simplifier challenged but: consistent with fleet/lane/audit; query + GC efficiency at scale; WAL gives crash-safety we'd hand-roll anyway. |
| Trailer / ext-flag surface day 1 | **Defer to Phase 9** | Simplifier wins: no consumer until Anthropic exact-replay. Land trailer with its first user. |
| Chat-anchor alignment day 1 | **Defer to conditional Phase 8** | Simplifier wins: boundary-naive longest-prefix in v1; only build alignment if Phase 7 bench shows false-hit cost. |
| Continued-store cadence day 1 | **Defer to conditional Phase 8** | Single save per response in v1. Cadence is an optimization for measured write amplification. |
| SSE streaming day 1 | **Yes** (user-confirmed) | Claude Code is streaming-only in practice. |
| Slice 1 + Slice 2 land in parallel | **Sequential, not parallel** | Architect's Phase 1 seam extraction is the shared dependency. Slice 1 (Phases 1-3) ships standalone first; Slice 2 (Phases 4-7) builds on the seam. Phase 9 composes them. |

## Adopted from architect persona
- **Phase 1 = pure seam extraction**, no behavior change. Refactor `proxyOpenAI` into `parseIncoming → maybeTranslate → resolveRoute → forward → maybeTranslateResponse` stages with pure-function translators.
- **KV metadata MUST live outside the workload-runtime mtime tree** (`<workloadRuntimeDir>/kvcache/` writes would thrash the existing `routeMapCache` and `modelsResponseCache` keyed on `workloadRuntimeRoot` mtime). Use a sibling dir or a separate mtime key.
- **`workload_epoch` from runtime sidecar facts**, not workload yaml. `pid + startedAt + rel + args-hash` from `server.ts`/`engines/state.ts`. Soft-reject KV entries with stale epoch.
- **Slot ID abstraction**: single-slot fast path (slot=0, `--parallel 1` default) + guarded multi-slot path with explicit allocation policy. Don't bake slot=0 in.

## Adopted from simplifier persona
- **Cut entry schema** to: `sha, upstreamSlotFile, workload, createdAt, lastUsed, hits, tokens, ctxSize, payloadBytes, textBytes, quantBits, reason`. Defer `extFlags` to Phase 9 with its consumer.
- **No trailer/ext-flag surface in v1**. JSON sidecar lands when Anthropic exact-replay needs it.
- **No chat-anchor alignment in v1**. Boundary-naive longest-prefix match. Phase 7 bench decides if Phase 8 is justified.
- **No cadence/suppression API in v1**. One save per response.

## Adopted from risk persona
- **Per-phase FAILURE MODES + DETECTION** section.
- **Secondary guard** beyond byte-prefix SHA: `(prefix_byte_length + token_count + workload + quantBits + ctxSize)` must all match. SHA alone is collision-prone over time.
- **`registry_integrity_errors_total` startup scan** + ENOSPC fault-injection tests on the eviction path.
- **Token-level divergence check at first decoded token after restore** → downgrade to cold prefill + `kv_false_hit_total` counter.
- **Tool-call args fragmented across deltas fuzz test** — random chunk boundaries; final reconstructed JSON must parse.
- **Unknown upstream SSE event type** → emit `translator_unknown_event_total`, continue unless invariant break.
- **Mid-stream upstream hard-fail** → canonical Anthropic terminal mapping contract (write down what we emit when there is no real stop_reason).
- **Stale slot file on restart** → TTL/ownership policy.
- **Transactional restore-vs-eviction race**: registry state transition `reserved → active`; concurrent eviction must defer.

## Risks the original spec did not address
1. Schema migration strategy for the SQLite registry across version bumps — add migration tests with at least one prior schema.
2. Tokenizer ambiguity: same bytes can hash equally but tokenize differently across model versions. Secondary equivalence guard handles, but tokenize once and store the token-count fingerprint.
3. Workload disable/re-enable during in-flight request that's using a slot → `slot_eviction_blocked_active_request` event + defer eviction.
4. `--parallel >1` is not just slot=0; explicit allocation, contention metric.

---

## Phased plan

### Phase 1 — Proxy seam extraction (no behavior change)

**Target:** `packages/core/src/openaiProxy.ts` + `packages/core/test/openaiProxy.test.ts`

**RED**
- Add test asserting existing `/v1/chat/completions` routing behavior unchanged after seam extraction (snapshot test of forwarding semantics).
- Add test asserting `/v1/messages` currently returns a deterministic "not implemented" 501, not silent passthrough.
- Add test asserting `routeMapCache` build count does not increase across N successive non-workload-changing requests.

**GREEN**
- Refactor `proxyOpenAI` into staged pipeline: `parseIncoming → maybeTranslate → resolveRoute → forward → maybeTranslateResponse`.
- Translator slot is a no-op for now; the structure exists.
- Preserve all existing forwarding semantics (header strip, JSON body routing, ReadableStream re-wrap).
- Decide the KV-metadata directory location (outside `workloadRuntimeRoot`). Document in `kvstore/README.md` (one paragraph).

**VERIFY**
- `bun test packages/core/test/openaiProxy.test.ts`
- `bun run --cwd packages/core tsc --noEmit`

**FAILURE MODES + DETECTION**
- Seam extraction silently changes routing → snapshot-shaped tests catch.
- `/v1/messages` falls through legacy forwarding → 501 assertion catches.

---

### Phase 2 — Anthropic request translator

**Target:** `packages/core/src/anthropic/{translateRequest.ts,types.ts,index.ts}` + `packages/core/test/anthropic.translateRequest.test.ts`

**RED**
- Failing cases for: `system` (string + content[]), text blocks, image blocks (base64 → data URL), `tool_use` blocks (→ `assistant.tool_calls`), `tool_result` blocks (→ `role:"tool"` with N-results-fanout), `tools` wrap, `tool_choice` enum permutations (auto/any/none/specific).
- Failing test for malformed/unsupported content blocks → deterministic 4xx translation error.

**GREEN**
- Implement translator as pure function `(AnthropicMessagesRequest) → OpenAIChatRequest`.
- Wire `/v1/messages` request branch in `proxyOpenAI` to translator → existing OpenAI forward path → upstream `/v1/chat/completions`.

**VERIFY**
- `bun test packages/core/test/anthropic.translateRequest.test.ts packages/core/test/openaiProxy.test.ts`

**FAILURE MODES + DETECTION**
- Wrong role/block mapping silently mutates semantics → golden fixture tests assert full translated JSON via structured diff.
- `tool_choice` enum mismatch → contract tests for each permutation with explicit upstream payload assertion.

---

### Phase 3 — Anthropic response + SSE translator (strict ordering)

**Target:** `packages/core/src/anthropic/{translateResponse.ts,translateStream.ts}` + `packages/core/test/anthropic.translateResponse.test.ts` + `packages/core/test/anthropic.translateStream.test.ts`

**RED**
- Failing test: non-stream stop_reason map (`stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use`).
- Failing test: SSE event-order invariant — every `content_block_delta` falls between an open `content_block_start` and its matching `content_block_stop`.
- Failing test: mixed OpenAI deltas (`content` + `tool_calls` interleaved) emit correctly indexed Anthropic blocks.
- Failing fuzz test: tool-call JSON arguments split across N random chunk boundaries → reconstructed JSON must parse + match source.
- Failing test: upstream mid-stream error → translator emits canonical terminal sequence (`content_block_stop` if open, then `message_delta` with documented synthetic stop_reason, then `message_stop`).
- Failing test: unknown upstream SSE event type → `translator_unknown_event_total` counter increments, stream continues unless invariant break.

**GREEN**
- Line-buffered SSE parser + state machine in `translateStream.ts`. Track open content-block index, demote OpenAI text deltas → `text_delta`, demote `tool_calls[].index` deltas → `input_json_delta` keyed by index, emit transitions.
- `[DONE]` handling, periodic `ping` every ~15s.
- Document and implement the synthetic stop_reason fallback for upstream errors (proposed: `end_turn` with `usage.output_tokens` reflecting partial output + a structured log event `anthropic_stream_upstream_error`).

**VERIFY**
- `bun test packages/core/test/anthropic.translateResponse.test.ts packages/core/test/anthropic.translateStream.test.ts`
- `bun run --cwd packages/core tsc --noEmit`

**FAILURE MODES + DETECTION**
- Out-of-order event emission closes strict clients → state-machine invariant tests assert legal transition graph.
- Tool-call args fragmented produce invalid JSON → fuzz test.
- Upstream disconnect mid-stream → terminal-mapping contract test.

> **Slice 1 ships here.** Local Claude Code / opencode-anthropic can complete a 3-turn tool-using session against a local workload through the proxy.

---

### Phase 4 — KV registry (SQLite WAL) + eviction score (pure)

**Target:** `packages/core/src/kvstore/{registry.ts,storage.ts,evictionScore.ts,policy.ts,index.ts}` + tests

**RED**
- Failing schema migration test: create v0 DB → run migrator → v1 schema present + data preserved.
- Failing crash-mid-write recovery test: kill between metadata write and trailer-placeholder write → startup integrity scan flags it, increments `registry_integrity_errors_total`, quarantines the row.
- Failing eviction score test: DS4-shape decay (6h hit half-life, live-prefix overlap penalty, hard-protect `protected_sha`).
- Failing test: longest-prefix lookup must match on (sha + prefix_byte_length + token_count + workload + quantBits + ctxSize) — single-SHA-match without secondary guard must be rejected.
- Failing test: ENOSPC during eviction → metric `registry_write_fail_total{reason="enospc"}` + structured warning; registry remains queryable.
- Failing test: KV metadata writes do NOT bump `workloadRuntimeRoot` mtime (no `routeMapCache` thrash).

**GREEN**
- SQLite + WAL, schema with migration version table.
- Entry shape (minimal, per simplifier): `sha, workload, upstreamSlotFile, quantBits, tokens, ctxSize, hits, createdAt, lastUsed, payloadBytes, textBytes, reason`. Also stored: `prefix_byte_length, workload_epoch` for the secondary guard.
- Pure `evictionScore(entry, liveTokens, protectedSha, now)` port of `ds4_kvstore_entry_eviction_score`.
- Storage dir: `<dataRoot>/kvstore/` (sibling of workload runtime, not child).
- Startup integrity scan with quarantine.

**VERIFY**
- `bun test packages/core/test/kvstore.registry.test.ts packages/core/test/kvstore.eviction.test.ts packages/core/test/kvstore.storage.test.ts packages/core/test/openaiProxy.test.ts`
- `bun run --cwd packages/core tsc --noEmit`

**FAILURE MODES + DETECTION**
- Crash mid-write → integrity scan + counter.
- ENOSPC during eviction → fault-injection test + counter.
- Byte-prefix SHA collision → secondary guard hard-rejects single-SHA-match without full tuple.

---

### Phase 5 — llama-server slot client + workload_epoch + slot policy

**Target:** `packages/core/src/kvstore/upstreamSlots.ts` + tests + minor `engines/state.ts` extension for epoch

**RED**
- Failing mocked-upstream test: `/slots/0?action=save` write a file, `?action=restore` read it back.
- Failing test: restore-miss (file absent) returns a structured error, proxy falls back to cold prefill, increments `kv_restore_miss_total`.
- Failing test: epoch mismatch (workload restarted between save and restore) → soft-reject + `kv_restore_reject_total{reason="epoch"}`.
- Failing test: quant mismatch → hard-reject + `kv_restore_reject_total{reason="quant"}`.
- Failing test: ctxSize mismatch (slot saved at ctx=8k, current workload ctx=32k) → hard-reject + counter.
- Failing race test: concurrent restore + eviction on same entry → registry transitions `reserved→active→idle`; eviction must defer when state ≠ `idle`.
- Failing stale-slot-file test: slot file exists on disk but no matching registry row → flagged as orphan + TTL-based cleanup after configurable interval.
- Failing test: under `--parallel >1`, slot allocator picks a non-zero slot when slot 0 is in use.

**GREEN**
- `upstreamSlots.ts` with `save(slotId, filepath)` / `restore(slotId, filepath)` against llama-server's slot endpoint.
- Compute `workload_epoch` from `pid + startedAt + rel + args-hash` read from runtime sidecar files; expose via `engines/state.ts` helper.
- Slot allocator abstraction: single-slot fast path + guarded multi-slot pool.
- Orphan slot-file sweeper at startup + TTL.

**VERIFY**
- `bun test packages/core/test/kvstore.upstreamSlots.test.ts packages/core/test/openaiProxy.test.ts`

**FAILURE MODES + DETECTION**
- Concurrent requests trample slot → per-slot lock contention metric + tests proving no interleaved save/restore.
- Wrong-quant/model-binary mismatch silently restores garbage → hard guard chain.
- Restore-vs-eviction race → transactional state.
- Stale slot file from prior version restored → epoch + TTL guard.

---

### Phase 6 — Wire KV into `openaiProxy` JSON path (boundary-naive)

**Target:** `packages/core/src/openaiProxy.ts` integration + `packages/core/test/openaiProxy.kv-cache.test.ts`

**RED**
- Failing E2E test: cold-miss request forwards full prompt + saves slot post-response.
- Failing E2E test: identical-prefix request restores slot + forwards suffix only.
- Failing **false-hit detection** test: mocked upstream returns a token at first-decoded-position that proves the cache restore was semantically wrong → proxy increments `kv_false_hit_total` + falls back to cold prefill + invalidates the offending entry.
- Failing test: per-workload byte budget exceeded → eviction runs + drops lowest-score entries.
- Failing test: workload disable/re-enable mid-request → `slot_eviction_blocked_active_request` event; active request completes without slot being yanked.

**GREEN**
- Lookup at proxy ingress: compute byte-prefix SHA + the secondary guard tuple, query registry, find longest match.
- On hit: call `upstreamSlots.restore`, then forward only the suffix tokens, attach `kv_restored=true` to upstream request metadata.
- On response: per single-save-per-response v1 policy, save the new slot file + register the entry.
- Boundary-naive: prefix granularity = whole prompt bytes only (no chat-anchor splits in v1).
- First-decoded-token equivalence check: small spec-defined heuristic (e.g., the first response token's logits match a snapshot taken during the original save) — if heuristic disagrees, downgrade.

**VERIFY**
- `bun test packages/core/test/openaiProxy.kv-cache.test.ts packages/core/test/openaiProxy.test.ts`
- Cross-repo smoke: `bun test && (cd ../nova && bun test) && (cd ../sirius-gateway && bun test) && (cd ../embersynth && bun test)`

**FAILURE MODES + DETECTION**
- False positive cache hit → first-decoded-token equivalence + counter + entry invalidation.
- Mid-flight slot eviction → blocked-active-request event + defer.
- Cache write storm under tool-call bursts → not addressed in v1 (Phase 8 if needed).

---

### Phase 7 — Bench: measure the win, decide on Phase 8

**Target:** `packages/eval/matrix/` extension — port `ds4-bench` per-frontier methodology

**RED**
- Failing test (bench): cold→warm prefill wall on 16k Gemma-4 26B-A4B (mac-mini :8181 or M4 Pro local) drops ≥50%.
- Failing test (bench): per-frontier instantaneous prefill/gen t/s at 2k/4k/8k/16k/32k frontiers with KV restore between probes.

**GREEN**
- Port `ds4-bench` per-frontier loop into `packages/eval/matrix/` as a new workload type `kv-warm-bench`.
- Run bench, record results, decide:
  - If ≥50% on 16k AND write cost <100ms p95 → ship as-is, Phase 8 not required.
  - If gain ≥50% but write cost >100ms p95 → Phase 8 mandatory (cadence + suppression).
  - If gain <50% → root-cause before adding complexity.

**VERIFY**
- Bench results recorded in `docs/benchmarks/2026-05-XX-kv-warm-restore.md` with raw CSV.

**FAILURE MODES + DETECTION**
- Unsafe cache reuse synthetically passes bench → semantic parity assertion in the bench harness (compare generated tokens vs cold-prefill run with same seed).

---

### Phase 8 — (Conditional) Chat-anchor alignment + continued-store cadence + suppression API

**Trigger:** Phase 7 shows write amplification or false-hit rate ≥ measurable threshold.

**Scope (only if triggered):**
- Per-workload tokenizer access (extend `/v1/models` or read workload yaml — decide based on workload type).
- Chat-anchor token IDs configurable per workload.
- `continued_interval_tokens` cadence; only write at chat-anchor positions.
- Suppressible API: `kvCache.suppressContinuedStore() / restoreContinuedStore()` for mid-tool-call bursts.

Detailed phasing deferred until Phase 7 says it's needed.

---

### Phase 9 — Anthropic exact tool-replay (composes Slice 1 + Slice 2)

**Target:** `packages/core/src/kvstore/trailer.ts` + integration into `packages/core/src/anthropic/`

**RED**
- Failing 3-turn test: Anthropic SDK against the proxy executes a multi-turn tool-using session; turn 2 must hit the warm cache; the upstream must receive the **exact** `tool_use` DSML bytes from turn 1's sampled output (not a re-canonicalization).
- Failing test: trailer sidecar JSON round-trips through Phase 4 storage + Phase 5 save/restore.
- Failing test: trailer corruption (truncated JSON) → main slot file still usable, trailer marked invalid in registry.

**GREEN**
- Implement `trailer.ts` with `extFlags` bitfield (`TOOL_MAP | SESSION_TITLE | THINKING_VISIBLE | RESPONSES_VISIBLE`) and per-flag read/write hooks.
- `extFlags` column added to registry entries.
- Anthropic translator writes `tool_map: {tool_use_id → exact bytes upstream emitted}` to trailer on save.
- Anthropic translator reads `tool_map` on restore and substitutes exact bytes during turn-N prompt rendering.

**VERIFY**
- `bun test packages/core/test/anthropic.kv.integration.test.ts`
- Closes the Qwen3 tool-call canonicalization gap (`project_qwen_tool_grammar_2026-05-15`).

**FAILURE MODES + DETECTION**
- Trailer write succeeds but main-file save fails → atomicity via temp-file + rename of both.
- Tool-use bytes diverge from canonical re-render but cache reuses anyway → semantic parity assertion in test.

---

### Phase 10 — oMLX slot API audit + decision

**Target:** `packages/remote/src/server/modelhost.ts`

**Investigation only:**
- Does oMLX (`ModelHost` workload kind) expose a slot save/restore API? Audit Sub A surface from `project_mlx_sub_a_shipped_2026-05-19`.
- Decision matrix:
  - If yes: minor wrapper in `upstreamSlots.ts`, oMLX workloads get KV warm-restore for free.
  - If no but feasible: file a Sub-A-follow-up to add it (1-2 weeks engine work).
  - If no and infeasible: document oMLX path as KV-degraded (cold prefill always); proxy detects ModelHost route and skips KV lookup.

Output: a short decision doc + either a code change or a follow-up spec.

---

## Success metrics (unchanged from spec)

- **Slice 1 (after Phase 3):** `@anthropic-ai/sdk` against the proxy completes a 3-turn tool-using session against a local llama-server workload; response shape matches `api.anthropic.com` modulo model differences.
- **Slice 2 (after Phase 7):** cold→warm prefill wall on 16k Gemma-4 26B-A4B M4 Pro drops ≥50%, measured by per-frontier bench methodology.
- **Phase 9:** Qwen3 tool-call canonicalization gap (per `project_qwen_tool_grammar_2026-05-15`) closes — adapter receives exact sampled bytes on turn 2+.

## Effort estimate
- Phases 1-3 (Slice 1): ~1 week, 3 medium PRs
- Phases 4-7 (KV foundation + bench): ~2 weeks, 4 medium PRs
- Phase 8 (conditional): 3-5 days IF triggered
- Phase 9: 3-5 days
- Phase 10: 1-3 days investigation, plus follow-up scope if engine work needed

## Open questions for kickoff
1. Which environment does Phase 7 bench run on — M4 Pro local Gemma-4 26B-A4B (matches user daily driver) or mac-mini :8181 (consistent reference)? Probably M4 Pro since that's where the cold-prefill pain lives.
2. Should the first-decoded-token equivalence check (Phase 6) require the upstream to expose a "snapshot logits" hook, or do we use a softer heuristic (sample the first token under temperature=0 with both cold and warm, compare)?
3. KV storage dir default: `<dataRoot>/kvstore/` where `dataRoot` is... `~/.llamactl/data/`? Or `~/.llamactl/kvstore/` as a top-level peer? (Affects backup/migration story.)
