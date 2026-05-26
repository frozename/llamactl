# Executable Phased TDD Plan — Anthropic Endpoint + KV Cache

Date: 2026-05-24
Source: `docs/specs/2026-05-24-anthropic-endpoint-and-kvcache-plan.md`

---

## Dispatch readiness checklist

Before kicking off Phase 1, verify ALL of the following:

```bash
# 1. Baseline test suite green
bun test

# 2. Type-check passes (packages/app typecheck is a no-op; use tsc directly)
bun run --cwd packages/core tsc --noEmit
bun run --cwd packages/remote tsc --noEmit
bun run --cwd packages/eval tsc --noEmit

# 3. Penumbra daemon running
launchctl list | grep penumbra

# 4. Agent availability — confirm in chain_list_agents output:
#    codex-acp-fast, codex-acp-deep, claude-acp-sonnet

# 5. Working directory clean
cd /Volumes/WorkSSD/repos/personal/llamactl && git status --short

# 6. openaiProxy entry point exists
ls packages/core/src/openaiProxy.ts

# 7. Disk space for kvstore slot files
df -h ~/.llamactl 2>/dev/null || echo "~/.llamactl not yet created — Phase 4 creates it"
```

---

## Dependency graph

```
Phase 1
├── Phase 2 → Phase 3 ─────────────────────────────────────┐
│                                                           │
└── Phase 4 → Phase 5 ──────────────────────────────┐      │
                                                     ▼      ▼
                                                   Phase 6 → Phase 7 → Phase 8 (conditional)
                                                       │
                                                       └──────── Phase 9 (composes)

Phase 10 — independent investigation; no hard prerequisite
```

**Parallelization note:** After Phase 1 clears, Phases 2 and 4 can be dispatched in parallel (both depend only on Phase 1's seam; neither depends on the other). Phase 3 requires Phase 2's types. Phase 5 requires Phase 4's registry. Phase 6 requires BOTH Phase 3 and Phase 5. The source plan mandates sequential slices (Slice 1: 1→3 then Slice 2: 4→7) for clarity; parallel dispatch is structurally safe for Phases 2+4 if sprint pressure warrants it.

---

## Phase 1 — Proxy seam extraction (no behavior change)

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_small
initial_agent: codex-acp-fast
use_worktree: true
expected_wall_time: 45 min
blocking_checkpoint: "bun test packages/core/test/openaiProxy.test.ts && bun run --cwd packages/core tsc --noEmit"
```

**Agent-selection rationale:** `codex-acp-fast` — mechanical refactor of a single file, paste-ready edit pattern. No schema design, no new module surface.

### Dispatch graph (within phase)

Single task, sequential.

```
T1.1  refactor openaiProxy.ts into staged pipeline + add RED tests + kvstore README
```

### T1.1 — Seam extraction + baseline tests

**Targets:** `packages/core/src/openaiProxy.ts`, `packages/core/test/openaiProxy.test.ts`, `packages/core/src/kvstore/README.md`

**RED → GREEN → VERIFY:**

RED:
- Add test asserting existing `/v1/chat/completions` routing behavior unchanged after refactor (snapshot test of forwarding semantics).
- Add test asserting `/v1/messages` currently returns a deterministic 501, not silent passthrough.
- Add test asserting `routeMapCache` build count does not increase across N successive non-workload-changing requests.

GREEN:
- Refactor `proxyOpenAI` into `parseIncoming → maybeTranslate → resolveRoute → forward → maybeTranslateResponse` pipeline.
- Translator slot is a no-op for now; structure only.
- Preserve all existing forwarding semantics (header strip, JSON body routing, ReadableStream re-wrap).
- Write `packages/core/src/kvstore/README.md` (one paragraph): storage dir is `<dataRoot>/kvstore/` — a sibling of the workload runtime dir, intentionally outside `workloadRuntimeRoot` so KV metadata writes do not bump `workloadRuntimeRoot` mtime and do not thrash `routeMapCache` or `modelsResponseCache`.

**FAILURE MODES + DETECTION:**
- Seam extraction silently changes routing → snapshot-shaped tests catch.
- `/v1/messages` falls through legacy forwarding → 501 assertion catches.

### Acceptance gate → Phase 2

```bash
bun test packages/core/test/openaiProxy.test.ts
bun run --cwd packages/core tsc --noEmit
# Expected: all tests green, zero type errors
```

---

## Phase 2 — Anthropic request translator

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_substantial
initial_agent: codex-acp-deep
use_worktree: true
expected_wall_time: 90 min
blocking_checkpoint: "bun test packages/core/test/anthropic.translateRequest.test.ts packages/core/test/openaiProxy.test.ts"
```

**Agent-selection rationale:** `codex-acp-deep` — translator design requires mapping the full Anthropic message schema (image blocks, tool_choice permutations, multi-result tool_result fanout) to OpenAI format. Structured reasoning over a defined spec with golden fixture assertions.

### Dispatch graph (within phase)

Single task, sequential.

```
T2.1  translateRequest.ts + types.ts + wire into proxyOpenAI + fixture tests
```

### T2.1 — Request translator + fixture tests

**Targets:** `packages/core/src/anthropic/translateRequest.ts`, `packages/core/src/anthropic/types.ts`, `packages/core/src/anthropic/index.ts`, `packages/core/test/anthropic.translateRequest.test.ts`

**RED → GREEN → VERIFY:**

RED:
- Failing cases for: `system` (string + content[]), text blocks, image blocks (base64 → data URL), `tool_use` blocks (→ `assistant.tool_calls`), `tool_result` blocks (→ `role:"tool"` with N-results fanout), `tools` wrap, `tool_choice` enum permutations (auto/any/none/specific).
- Failing test for malformed/unsupported content blocks → deterministic 4xx translation error.

GREEN:
- Pure function `translateRequest(req: AnthropicMessagesRequest): OpenAIChatRequest`.
- Wire `/v1/messages` branch in `proxyOpenAI` to translator → existing OpenAI forward path → upstream `/v1/chat/completions`.

**FAILURE MODES + DETECTION:**
- Wrong role/block mapping silently mutates semantics → golden fixture tests assert full translated JSON via structured diff.
- `tool_choice` enum mismatch → contract tests for each permutation with explicit upstream payload assertion.

### Acceptance gate → Phase 3

```bash
bun test packages/core/test/anthropic.translateRequest.test.ts packages/core/test/openaiProxy.test.ts
bun run --cwd packages/core tsc --noEmit
```

---

## Phase 3 — Anthropic response + SSE translator (strict ordering)

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_substantial
initial_agent: claude-acp-sonnet
use_worktree: true
expected_wall_time: 2 h
blocking_checkpoint: "bun test packages/core/test/anthropic.translateResponse.test.ts packages/core/test/anthropic.translateStream.test.ts && bun run --cwd packages/core tsc --noEmit"
```

**Agent-selection rationale:** `claude-acp-sonnet` — SSE state machine with strict event-ordering invariants, a fuzz test for tool-call args across random chunk boundaries, and a synthetic stop_reason fallback contract require multi-file, stateful implementation. Sustained multi-step coherence reward the higher-capacity model.

### Dispatch graph (within phase)

Sequential — stream translator depends on non-stream types established in T3.1.

```
T3.1  translateResponse.ts + non-stream stop_reason tests
T3.2  translateStream.ts + SSE state machine + fuzz + upstream-error contract  (depends T3.1)
```

### T3.1 — Non-stream response translator

**Targets:** `packages/core/src/anthropic/translateResponse.ts`, `packages/core/test/anthropic.translateResponse.test.ts`

RED:
- Failing test: stop_reason map (`stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use`).

GREEN:
- `translateResponse(res: OpenAIChatResponse): AnthropicMessagesResponse` pure function.

**FAILURE MODES + DETECTION:**
- Wrong stop_reason → per-value contract tests.

### T3.2 — SSE stream translator + fuzz

**Targets:** `packages/core/src/anthropic/translateStream.ts`, `packages/core/test/anthropic.translateStream.test.ts`

RED:
- Failing test: SSE event-order invariant — every `content_block_delta` falls between an open `content_block_start` and its matching `content_block_stop`.
- Failing test: mixed OpenAI deltas (`content` + `tool_calls` interleaved) emit correctly indexed Anthropic blocks.
- Failing fuzz test: tool-call JSON arguments split across N random chunk boundaries → reconstructed JSON must parse and match source.
- Failing test: upstream mid-stream error → translator emits canonical terminal sequence (`content_block_stop` if open, then `message_delta` with documented synthetic stop_reason, then `message_stop`).
- Failing test: unknown upstream SSE event type → `translator_unknown_event_total` counter increments, stream continues unless invariant break.

GREEN:
- Line-buffered SSE parser + state machine in `translateStream.ts`. Track open content-block index, demote OpenAI text deltas → `text_delta`, demote `tool_calls[].index` deltas → `input_json_delta` keyed by index, emit transitions.
- `[DONE]` handling, periodic `ping` every ~15s.
- Document and implement the synthetic stop_reason fallback for upstream errors: `end_turn` + `usage.output_tokens` reflecting partial output + a structured log event `anthropic_stream_upstream_error`.

**FAILURE MODES + DETECTION:**
- Out-of-order event emission closes strict clients → state-machine invariant tests assert legal transition graph.
- Tool-call args fragmented produce invalid JSON → fuzz test.
- Upstream disconnect mid-stream → terminal-mapping contract test.
- Unknown SSE type → `translator_unknown_event_total` counter.

### Acceptance gate → Phase 4 (Slice 1 ships here)

```bash
bun test packages/core/test/anthropic.translateResponse.test.ts packages/core/test/anthropic.translateStream.test.ts packages/core/test/openaiProxy.test.ts
bun run --cwd packages/core tsc --noEmit
# Slice 1 acceptance: @anthropic-ai/sdk completes a 3-turn tool session against a local workload through the proxy
```

> **Slice 1 ships here.** Local Claude Code / opencode-anthropic can complete a 3-turn tool-using session against a local workload through the proxy.

---

## Phase 4 — KV registry (SQLite WAL) + eviction score (pure)

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_substantial
initial_agent: claude-acp-sonnet
use_worktree: true
expected_wall_time: 2 h
blocking_checkpoint: "bun test packages/core/test/kvstore.registry.test.ts packages/core/test/kvstore.eviction.test.ts packages/core/test/kvstore.storage.test.ts && bun run --cwd packages/core tsc --noEmit"
```

**Dependency:** Phase 1 acceptance gate. Phase 3 does NOT need to be complete — Phase 4 can begin in parallel with Phases 2+3 after Phase 1 clears (see Dependency Graph note).

**Agent-selection rationale:** `claude-acp-sonnet` — SQLite WAL schema, migration version table, crash-recovery integrity scan, DS4-shape eviction score, ENOSPC fault injection, and secondary guard tuple design all require sustained multi-file architectural reasoning.

### Dispatch graph (within phase)

Three tasks; T4.2 and T4.3 are logically independent after T4.1 but dispatch sequentially to avoid worktree conflicts.

```
T4.1  SQLite schema + migration + storage bootstrapping
T4.2  evictionScore.ts + policy.ts (pure, no DB access)   (depends T4.1)
T4.3  secondary guard enforcement + ENOSPC fault injection  (depends T4.1)
```

### T4.1 — SQLite schema + storage bootstrapping

**Targets:** `packages/core/src/kvstore/registry.ts`, `packages/core/src/kvstore/storage.ts`, `packages/core/src/kvstore/index.ts`, `packages/core/test/kvstore.storage.test.ts`

RED:
- Schema migration test: create v0 DB → run migrator → v1 schema present + data preserved.
- Crash-mid-write recovery test: kill between metadata write and placeholder write → startup integrity scan flags it, increments `registry_integrity_errors_total`, quarantines the row.
- KV metadata writes do NOT bump `workloadRuntimeRoot` mtime (no `routeMapCache` thrash).

GREEN:
- SQLite + WAL, migration version table.
- Entry shape (minimal, per simplifier): `sha, workload, upstreamSlotFile, quantBits, tokens, ctxSize, hits, createdAt, lastUsed, payloadBytes, textBytes, reason`. Also: `prefix_byte_length, workload_epoch` for secondary guard.
- Storage dir: `<dataRoot>/kvstore/` (sibling of workload runtime, not child).
- Startup integrity scan with quarantine.

### T4.2 — Eviction score (pure)

**Targets:** `packages/core/src/kvstore/evictionScore.ts`, `packages/core/test/kvstore.eviction.test.ts`

RED:
- DS4-shape decay: 6h hit half-life, live-prefix overlap penalty, hard-protect `protected_sha`.

GREEN:
- Pure `evictionScore(entry, liveTokens, protectedSha, now)` port of `ds4_kvstore_entry_eviction_score`.

### T4.3 — Secondary guard + ENOSPC

**Targets:** `packages/core/src/kvstore/policy.ts`, tests folded into `kvstore.registry.test.ts`

RED:
- Single-SHA-match without full secondary tuple must be rejected.
- ENOSPC during eviction → `registry_write_fail_total{reason="enospc"}` + registry remains queryable.

GREEN:
- `longestPrefixLookup()` enforces full tuple `(sha + prefix_byte_length + token_count + workload + quantBits + ctxSize)`.
- ENOSPC fault-injection path with structured warning.

**FAILURE MODES + DETECTION (all T4.x):**
- Crash mid-write → integrity scan + counter.
- ENOSPC → fault-injection test + counter.
- SHA collision → secondary guard hard-rejects single-SHA-match without full tuple.
- Schema bump breaks existing rows → migration test.

### Acceptance gate → Phase 5

```bash
bun test packages/core/test/kvstore.registry.test.ts packages/core/test/kvstore.eviction.test.ts packages/core/test/kvstore.storage.test.ts packages/core/test/openaiProxy.test.ts
bun run --cwd packages/core tsc --noEmit
```

---

## Phase 5 — llama-server slot client + workload_epoch + slot policy

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_substantial
initial_agent: codex-acp-deep
use_worktree: true
expected_wall_time: 2 h
blocking_checkpoint: "bun test packages/core/test/kvstore.upstreamSlots.test.ts packages/core/test/kvstore.registry.test.ts packages/core/test/openaiProxy.test.ts"
```

**Dependency:** Phase 4 acceptance gate.

**Agent-selection rationale:** `codex-acp-deep` — restore-vs-eviction race condition (state machine `reserved→active→idle`) and the concurrent slot allocator require structured multi-step reasoning. The surface is well-defined; correctness properties reward the reasoning-capable codex variant over fast.

### Dispatch graph (within phase)

Sequential (state machine must be correct before race tests can be meaningfully authored):

```
T5.1  upstreamSlots.ts basic save/restore + epoch + mocked-upstream tests
T5.2  race tests + orphan sweeper + multi-slot allocator   (depends T5.1)
```

### T5.1 — Slot client + epoch

**Targets:** `packages/core/src/kvstore/upstreamSlots.ts`, minor `packages/core/src/engines/state.ts` extension, `packages/core/test/kvstore.upstreamSlots.test.ts`

RED:
- Mocked-upstream test: `/slots/0?action=save` writes file, `?action=restore` reads it back.
- Restore-miss → structured error + `kv_restore_miss_total`.
- Epoch mismatch → `kv_restore_reject_total{reason="epoch"}`.
- Quant mismatch → hard-reject + `{reason="quant"}`.
- ctxSize mismatch → hard-reject + counter.

GREEN:
- `save(slotId, filepath)` / `restore(slotId, filepath)` against llama-server `/slots/<id>?action=`.
- `workload_epoch` from `pid + startedAt + rel + args-hash` read from runtime sidecar files; expose via `engines/state.ts` helper.
- Orphan slot-file sweeper at startup + TTL.

### T5.2 — Race tests + multi-slot allocator

**Targets:** additions to `kvstore.upstreamSlots.test.ts` + slot allocator in `upstreamSlots.ts`

RED:
- Concurrent restore + eviction on same entry → registry transitions `reserved→active→idle`; eviction defers when state ≠ `idle`.
- Stale slot file exists on disk with no matching registry row → flagged as orphan + TTL-based cleanup.
- Under `--parallel >1`, slot allocator picks a non-zero slot when slot 0 is in use.

GREEN:
- Slot allocator abstraction: single-slot fast path (slot=0, `--parallel 1` default) + guarded multi-slot pool with explicit allocation policy.
- Per-slot contention metric.

**FAILURE MODES + DETECTION:**
- Concurrent requests trample slot → per-slot lock + tests proving no interleaved save/restore.
- Wrong-quant/model-binary mismatch silently restores garbage → hard guard chain.
- Restore-vs-eviction race → transactional state.
- Stale slot file from prior version restored → epoch + TTL guard.

### Acceptance gate → Phase 6

```bash
bun test packages/core/test/kvstore.upstreamSlots.test.ts packages/core/test/kvstore.registry.test.ts packages/core/test/openaiProxy.test.ts
bun run --cwd packages/core tsc --noEmit
```

---

## Phase 6 — Wire KV into `openaiProxy` JSON path (boundary-naive)

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_substantial
initial_agent: claude-acp-sonnet
use_worktree: true
expected_wall_time: 2 h
blocking_checkpoint: "bun test packages/core/test/openaiProxy.kv-cache.test.ts packages/core/test/openaiProxy.test.ts"
```

**Dependencies:** Phase 3 acceptance gate (translator types + Anthropic response path) AND Phase 5 acceptance gate (upstreamSlots + registry). Both must pass before dispatching Phase 6.

**Agent-selection rationale:** `claude-acp-sonnet` — integration wires three prior packages (translator, registry, slot client) into the proxy pipeline with non-trivial ordering semantics, plus the first-decoded-token false-hit heuristic which spans two modules.

### Dispatch graph (within phase)

Sequential (false-hit detection depends on basic wiring being correct):

```
T6.1  cold-miss + warm-hit wiring + eviction + workload-disable guard
T6.2  first-decoded-token false-hit detection + fallback + invalidation   (depends T6.1)
```

### T6.1 — Cold/warm wiring + eviction + workload guard

**Targets:** `packages/core/src/openaiProxy.ts`, `packages/core/test/openaiProxy.kv-cache.test.ts`

RED:
- Cold-miss request forwards full prompt + saves slot post-response.
- Identical-prefix request restores slot + forwards suffix only.
- Per-workload byte budget exceeded → eviction runs + drops lowest-score entries.
- Workload disable/re-enable mid-request → `slot_eviction_blocked_active_request` event; active request completes without slot being yanked.

GREEN:
- Lookup at proxy ingress: compute byte-prefix SHA + secondary guard tuple → `longestPrefixLookup()`.
- On hit: call `upstreamSlots.restore`, forward only the suffix tokens, attach `kv_restored=true` to upstream request metadata.
- On response: save new slot file + register entry (single save per response, v1 policy).
- Boundary-naive: prefix granularity = whole prompt bytes only (no chat-anchor splits in v1).

### T6.2 — False-hit detection

**Targets:** additions to `openaiProxy.ts` + `openaiProxy.kv-cache.test.ts`

RED:
- Mocked upstream returns a token at first-decoded-position inconsistent with save-time snapshot → `kv_false_hit_total` + cold prefill fallback + entry invalidation.

GREEN:
- First-decoded-token equivalence check: compare first response token under temperature=0 between cold and warm; on mismatch, downgrade to cold prefill.

**FAILURE MODES + DETECTION:**
- False positive cache hit → first-decoded-token equivalence + counter + entry invalidation.
- Mid-flight slot eviction → blocked-active-request event + defer.
- Cache write storm under tool-call bursts → not addressed in v1 (Phase 8 if triggered).

### Acceptance gate → Phase 7

```bash
bun test packages/core/test/openaiProxy.kv-cache.test.ts packages/core/test/openaiProxy.test.ts
bun run --cwd packages/core tsc --noEmit
# Cross-repo smoke
bun test && (cd ../sirius-gateway && bun test) && (cd ../embersynth && bun test)
```

---

## Phase 7 — Bench: measure the win, decide on Phase 8

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_small
initial_agent: codex-acp-deep
use_worktree: true
expected_wall_time: 4 h (including bench run on M4 Pro local)
blocking_checkpoint: "ls docs/benchmarks/2026-05-*-kv-warm-restore.md && grep -E 'gain|decision' docs/benchmarks/2026-05-*-kv-warm-restore.md"
```

**Dependency:** Phase 6 acceptance gate.

**Sandbox limitation:** `codex-acp-fast`/`codex-acp-deep` workers cannot bind listening sockets. T7.1 (harness code) is dispatched; T7.2 (bench run + doc) must be executed locally. Assign locally or hand to a worker with llama-server access.

**Agent-selection rationale:** `codex-acp-deep` — porting the `ds4-bench` per-frontier loop into the eval matrix harness requires understanding the existing `packages/eval/matrix/` workload type registration pattern and bench methodology. Schema-aware, not purely mechanical.

### Dispatch graph (within phase)

T7.1 dispatched; T7.2 manual.

```
T7.1  port ds4-bench into packages/eval/matrix/ as kv-warm-bench workload type   (dispatched)
T7.2  run bench on M4 Pro, record results, write decision doc                     (manual, local)
```

### T7.1 — Bench harness (dispatched)

**Targets:** `packages/eval/matrix/` (new workload type `kv-warm-bench`)

Implement:
- Per-frontier loop at 2k/4k/8k/16k/32k token frontiers with KV restore between probes.
- Semantic parity assertion: compare generated tokens vs cold-prefill run with same seed.
- Workload config for Gemma-4 26B-A4B M4 Pro / mac-mini :8181.

### T7.2 — Bench run + decision doc (manual)

Run locally:
```bash
bun run --cwd packages/eval kv-warm-bench --workload gemma4-26b-a4b --frontiers 2k,4k,8k,16k,32k
```

Record in `docs/benchmarks/2026-05-XX-kv-warm-restore.md` with raw CSV.

**Decision rules:**
- cold→warm prefill wall ≥50% AND write cost <100ms p95 → Phase 8 **skipped**.
- gain ≥50% AND write cost >100ms p95 → Phase 8 **mandatory**.
- gain <50% → root-cause before proceeding to Phase 9.

**FAILURE MODES + DETECTION:**
- Unsafe cache reuse synthetically passes bench → semantic parity assertion in harness (compare tokens vs cold-prefill run with same seed).

### Acceptance gate → Phase 8 or Phase 9

```bash
ls docs/benchmarks/2026-05-*-kv-warm-restore.md
grep -E "gain|decision" docs/benchmarks/2026-05-*-kv-warm-restore.md
# Decision doc must exist and contain an explicit "decision: skip|mandatory|blocked" line
```

---

## Phase 8 — (Conditional) Chat-anchor alignment + continued-store cadence + suppression API

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_substantial
initial_agent: TBD  # defer until Phase 7 decision doc is written
use_worktree: true
expected_wall_time: 3–5 days
blocking_checkpoint: TBD — defined after Phase 7 results
```

**Trigger:** Phase 7 records `decision: mandatory` (write amplification OR false-hit rate ≥ measurable threshold: write cost >100ms p95 or gain <50%).

**Scope (only if triggered):**
- Per-workload tokenizer access (extend `/v1/models` or read workload yaml — decide based on workload type at trigger time).
- Chat-anchor token IDs configurable per workload.
- `continued_interval_tokens` cadence; only write at chat-anchor positions.
- Suppressible API: `kvCache.suppressContinuedStore() / restoreContinuedStore()` for mid-tool-call bursts.

Detailed task decomposition, agent assignment, and acceptance gate are deferred until Phase 7 produces trigger criteria. If Phase 7 records `decision: skip`, proceed directly to Phase 9.

---

## Phase 9 — Anthropic exact tool-replay (composes Slice 1 + Slice 2)

### Task metadata

```yaml
task_class: STANDARD
task_type: implement_substantial
initial_agent: claude-acp-sonnet
use_worktree: true
expected_wall_time: 3–5 h
blocking_checkpoint: "bun test packages/core/test/anthropic.kv.integration.test.ts && bun run --cwd packages/core tsc --noEmit"
```

**Dependencies:** Phase 3 AND Phase 6 acceptance gates must both pass. (Phase 8 acceptance gate additionally if Phase 8 was triggered.)

**Agent-selection rationale:** `claude-acp-sonnet` — Phase 9 couples Slice 1 (translator) and Slice 2 (KV) by threading the trailer/extFlags design through both, including multi-turn tool-replay semantics (exact bytes substitution). Maintaining full context of both slices simultaneously favors the higher-capacity model.

### Dispatch graph (within phase)

Sequential:

```
T9.1  trailer.ts (extFlags + read/write hooks) + registry extFlags column migration
T9.2  Anthropic translator tool_map write/read on save/restore   (depends T9.1)
T9.3  3-turn integration test + trailer corruption test           (depends T9.2)
```

### T9.1 — Trailer storage

**Targets:** `packages/core/src/kvstore/trailer.ts`, registry `extFlags` column (migration)

RED:
- Trailer JSON round-trips through Phase 4 storage + Phase 5 save/restore.
- Trailer corruption (truncated JSON) → main slot file still usable + trailer marked invalid in registry.

GREEN:
- `extFlags` bitfield (`TOOL_MAP | SESSION_TITLE | THINKING_VISIBLE | RESPONSES_VISIBLE`) with per-flag read/write hooks.
- `extFlags` column added to registry with schema migration.
- Atomicity: temp-file + rename of both main slot file and trailer together.

### T9.2 — Translator tool_map integration

**Targets:** `packages/core/src/anthropic/translateRequest.ts`, `translateStream.ts`, `translateResponse.ts`

Implement:
- On save: Anthropic translator writes `tool_map: {tool_use_id → exact bytes upstream emitted}` to trailer.
- On restore: translator reads `tool_map` and substitutes exact bytes during turn-N prompt rendering.

### T9.3 — 3-turn integration test

**Targets:** `packages/core/test/anthropic.kv.integration.test.ts`

RED:
- 3-turn test: Anthropic SDK → proxy → local workload. Turn 2 must hit warm cache. Upstream must receive exact `tool_use` DSML bytes from turn 1 (not a re-canonicalization).
- Closes `project_qwen_tool_grammar_2026-05-15` canonicalization gap.

**FAILURE MODES + DETECTION:**
- Trailer write succeeds but main-file save fails → atomicity via temp-file + rename of both.
- Tool-use bytes diverge from canonical re-render but cache reuses anyway → semantic parity assertion in test.

### Acceptance gate (Phase 9 complete)

```bash
bun test packages/core/test/anthropic.kv.integration.test.ts packages/core/test/openaiProxy.kv-cache.test.ts packages/core/test/openaiProxy.test.ts
bun run --cwd packages/core tsc --noEmit
```

---

## Phase 10 — oMLX slot API audit + decision

### Task metadata

```yaml
task_class: STANDARD
task_type: unknown
initial_agent: TBD  # assign based on Sub A oMLX surface familiarity; likely claude-acp-sonnet
use_worktree: false  # investigation only; no committed code required initially
expected_wall_time: 1–3 days investigation + potential follow-up scope
blocking_checkpoint: "ls docs/specs/2026-05-*-omlx-kv-decision.md"
```

**Dependency:** None hard. Can run in parallel with any phase after Phase 5 (slot-client surface is the closest integration point, but investigation is read-only). Recommend dispatching alongside Phase 7 or Phase 9 to not block the critical path.

**Agent-selection rationale:** TBD — ideally whoever worked on Sub A (`project_mlx_sub_a_shipped_2026-05-19`). `claude-acp-sonnet` as default given the cross-package analysis required (`packages/remote/src/server/modelhost.ts`).

### T10.1 — oMLX slot API audit

**Targets:** `packages/remote/src/server/modelhost.ts` (read-only audit)

Investigate:
1. Does oMLX (`ModelHost` workload kind) expose a slot save/restore API? Audit Sub A surface from `project_mlx_sub_a_shipped_2026-05-19`.
2. Apply decision matrix:
   - **Yes** → minor wrapper in `upstreamSlots.ts`; oMLX workloads get KV warm-restore for free.
   - **No, feasible** → file Sub-A-follow-up spec (1-2 weeks engine work).
   - **No, infeasible** → document oMLX path as KV-degraded; proxy detects `ModelHost` route + skips KV lookup.

Output: `docs/specs/2026-05-XX-omlx-kv-decision.md`

**FAILURE MODES + DETECTION:** Investigation phase; no functional failures. Risk is incorrect conclusion — mitigate by running a live probe against the oMLX server during investigation.

### Acceptance gate (Phase 10 complete)

```bash
ls docs/specs/2026-05-*-omlx-kv-decision.md
# If a code change is included:
bun run --cwd packages/remote tsc --noEmit
```

---

## Phase summary table

| Phase | Agent | Task class | Depends on | Can parallelize with |
|---|---|---|---|---|
| 1 | `codex-acp-fast` | STANDARD / implement_small | — | — |
| 2 | `codex-acp-deep` | STANDARD / implement_substantial | Phase 1 gate | Phase 4 (after Phase 1) |
| 3 | `claude-acp-sonnet` | STANDARD / implement_substantial | Phase 2 gate | Phase 4, Phase 5 |
| 4 | `claude-acp-sonnet` | STANDARD / implement_substantial | Phase 1 gate | Phase 2, Phase 3 |
| 5 | `codex-acp-deep` | STANDARD / implement_substantial | Phase 4 gate | Phase 3 |
| 6 | `claude-acp-sonnet` | STANDARD / implement_substantial | Phase 3 + Phase 5 gates | — |
| 7 | `codex-acp-deep` | STANDARD / implement_small | Phase 6 gate | Phase 10 |
| 8 | TBD (conditional) | STANDARD / implement_substantial | Phase 7 trigger | Skip if decision=skip |
| 9 | `claude-acp-sonnet` | STANDARD / implement_substantial | Phase 3 + Phase 6 gates | Phase 10 |
| 10 | TBD | STANDARD / unknown | Phase 5+ (soft) | Phases 7–9 |

---

*End of executable plan.*
