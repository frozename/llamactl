# Adversarial Review + Plan — Synthesis (2026-05-24)

Synthesized from 8 codex-persona reports:
- 4 reviews of session diff `80eac87..61144b4` (architect, security, simplifier, boundary)
- 4 plan reviews of oMLX slot API spec (architect, simplifier, risk, integration)

Synthesizer: in-session (Opus 4.7). Skipped sonnet synthesizer dispatch to preserve Anthropic quota.

---

## P0 — Correctness bugs to fix before more production traffic

Each of these was flagged by ≥1 persona as HIGH priority, and each can produce silent wrong behavior in shipped code today.

### P0-1. SSE translator drops frames with `event:` or `id:` lines
**Source**: boundary review #1
**File**: `packages/core/src/anthropic/translateStream.ts:295`
**Bug**: Parser marks any non-`data:` line as `unknownLine` and discards the entire SSE frame even when `data:` payload is valid. Spec-compliant upstreams emit `event: message\ndata: {...}\n\n` — we silently drop the whole event. Tool calls can disappear completely; user sees terminal `message_stop` with no content. `translator_unknown_event_total` counter climbs.
**Fix**: parse `data:` independently from `event:`/`id:` lines per spec; allow named events; only mark truly unknown line *kinds* (not `event:` or `id:`).
**Test**: add a fixture with `event: message\ndata: {...}` → expect normal translation.

### P0-2. Response cache persists corrupted/incomplete responses as warm hits
**Source**: boundary review #2 + #5, security review #3, architect review #1
**Files**: `packages/core/src/openaiProxy.ts:892` (persist gate), `packages/core/src/responsecache/policy.ts:24` (no TTL)
**Bug** (multiple, same class):
- Partial SSE (upstream closes before `[DONE]`) → truncated stream cached + replayed forever
- Status-200 JSON with `{"error":...}` envelope → poison cached as "successful" deterministic hit
- No TTL → poisoned entry survives until budget eviction
- No re-validation on replay
**Fix bundle**:
- Persist SSE only when terminal event observed (`[DONE]` or `message_stop` for Anthropic-wrapped).
- Reject persist when JSON body has top-level `error` (even with status 200).
- Add TTL (e.g. `LLAMACTL_RESPONSE_CACHE_TTL_HOURS=24`); evict entries past TTL on lookup.
- Optional: add a `validateBeforeServe` hook for callers that want strict re-validation.

### P0-3. KV lease leak when response-cache stream read throws
**Source**: boundary review #3
**File**: `packages/core/src/openaiProxy.ts:1208`
**Bug**: warm-hit path reserves + activates KV entry in `maybeKvLookup`, then `maybePersistResponseCache` calls `upstream.arrayBuffer()`. If that throws mid-stream, `proxyOpenAI` exits before `maybePersistKv` (which holds the `release()` finally). Entry stuck `active`/`reserved` forever; future reserves/evictions degrade; `slot_eviction_blocked_active_request` floods.
**Fix**: hoist the KV registry release into a try/finally at the `proxyOpenAI` level, OR thread the warm-hit lease through the response context and release in a top-level finally regardless of which stage failed.

### P0-4. KV schema migration not crash-safe across `ALTER` + `UPDATE schema_version`
**Source**: boundary review #4
**File**: `packages/core/src/kvstore/storage.ts:68`
**Bug**: Crash between `ALTER TABLE ... ADD COLUMN` and `UPDATE schema_version`. On restart, migrator re-runs the same step and `ALTER` fails with "duplicate column" → agent fails to open DB → effectively bricked.
**Fix**: wrap each migration step in a transaction with the `UPDATE schema_version` inside it, OR make ALTER idempotent (catch `duplicate column` and continue), OR check `PRAGMA table_info` before ALTER.

---

## P1 — Correctness concerns to fix soon

### P1-1. Response cache key missing route/workload-epoch scoping
**Source**: architect review #1
**File**: `packages/core/src/openaiProxy.ts:592`
**Issue**: Cache identity is `{sha, model}`. If a model alias gets re-pointed to a different workload (or workload epoch bumps), deterministic requests can serve responses from the OLD backing runtime — bypassing routing + KV validation. Correctness, not just hit-rate.
**Fix**: extend cache key to `{sha, model, workload, workloadEpoch}`. Invalidate stale-epoch rows on lookup.

### P1-2. Cache key canonicalization mismatch between KV and response cache
**Source**: architect review #3
**Files**: `packages/core/src/openaiProxy.ts:743` (KV uses raw bodyText SHA), `packages/core/src/responsecache/sha.ts` (response uses canonical JSON)
**Issue**: Two layers disagree on identity for the same semantic request. Same prompt with reordered JSON keys hits response cache but misses KV.
**Fix**: extract a shared `cache-identity` module that both consume. Per-layer discriminators (workload epoch for KV, protocol variant for response) stay layer-local.

### P1-3. `/v1/messages` body size guard fires AFTER `req.text()`
**Source**: security review #2
**File**: `packages/core/src/openaiProxy.ts:352`
**Issue**: Anthropic path calls `await req.text()` + `JSON.parse` in `parseIncoming` BEFORE the 10 MB guard runs in `resolveRoute`. OOM-able with a huge `messages` array or base64-image bomb.
**Fix**: enforce max-body-bytes via content-length precheck + streamed-count cap BEFORE `req.text()` on the `/v1/messages` path. Reuse a shared limiter for OpenAI + Anthropic.

### P1-4. `--no-auth` bypass applies to `/trpc` + control-plane, not just `/v1/*`
**Source**: security review #1
**File**: `packages/remote/src/server/serve.ts:273` (and tRPC mount points 287/382/400/415/422)
**Issue**: A malicious local process (Docker host.docker.internal, sandboxed app reaching loopback, etc.) on a no-auth proxy can invoke tRPC mutation procedures — not just inference.
**Fix**: scope no-auth to `/v1/*` only. Keep `/trpc` and control-plane mutation routes bearer-protected even in `--no-auth` mode.

### P1-5. Anthropic responses cached pre-translation, replayed via live translator
**Source**: architect review #2
**File**: `packages/core/src/openaiProxy.ts:1208`
**Issue**: Persisted bytes are protocol-internal (OpenAI shape); user-visible bytes come from whatever translator is loaded at replay time. Translator version drift silently mutates cached anthropic outputs without invalidation.
**Fix**: either cache post-translation payloads for `/v1/messages` (preferred), or embed translator version in cache metadata and invalidate on bump.

---

## P2 — Cuts the simplifier proposed (review when convenient)

| Candidate cut | Source | Verdict |
|---|---|---|
| Entire response cache layer (keep only KV) | simplifier #1 | **REJECT** — backend-agnostic win for oMLX (KV-degraded). Different semantic surface. Keep both. |
| Multi-slot allocator path (always `maxSlots=1` today) | simplifier #2 | **DEFER** — small dead code, but the architecture leaves room for `--parallel >1` workloads. Low cost to leave; revisit if abandoned in 60 days. |
| Orphan sweeper helper | simplifier #3 | **DEFER** — agree it's not wired into a hot path today, but the cost-to-leave is minimal and prevents disk-fill if eviction logic ever skips. Document the "not auto-scheduled" status. |
| `workloadEpoch` helper complexity | simplifier #4 | **TAKE** — replace `pid + startedAt + rel + argsHash` SHA with simpler `startedAt + rel` boolean ("is workload same instance"). The fingerprint adds invalidation surprise (mtime touch flaps cache). Tracked as a refactor. |
| Response cache migration scaffold (v0→v1 on a brand-new module) | simplifier #5 | **DEFER** — overhead is tiny (~30 LOC) and pays off the first time we bump. Not worth ripping out. |
| Trailer `EXT_FLAG_THINKING_VISIBLE` + `EXT_FLAG_RESPONSES_VISIBLE` (no consumers) | simplifier lower-pri | **TAKE** — remove the unused flags. Reduces cognitive load. Re-add when needed. |

---

## P3 — Bigger architectural moves (tracked, not urgent)

- **SlotAllocator → durable SQLite-backed lease with TTL** (architect #4). Today it's process-local + drop-on-contention. Inter-process coordination needed if we ever run two proxies.
- **Promote routing-policy into a shared kind-agnostic function** (architect #5). Slice X.2 hardcodes `kind === 'ModelRun'`. ModelHost extension blocked behind this.
- **Unified observability surface** (architect lower-pri, security lower-pri). Counters are scattered across kvstore + responsecache + slot allocator. No persistence, no export.

---

## oMLX spec — pre-implementation revisions required

Strong convergence across architect / simplifier / risk / integration personas:

### Spec revision #1 — `slot=0` abstraction doesn't fit oMLX reality
**Flagged by all 4 planners.** oMLX is request-ID (UUID) based, supports `max_concurrent_requests > 1` by default, and has multi-model EnginePool. `/slots/{id}` with no model selector is ambiguous.

**Required change**: pick one of:
- **(a) Strict invariant**: hard-gate slot endpoints to refuse boot when `slot_save_path && max_concurrent_requests != 1`. Document this loudly. Use `slot=0` only.
- **(b) Canonical identity**: change the spec to `(model_id, request_handle)` with `slot=0` as a back-compat alias. Add explicit `model` selector to slot endpoints.

Recommendation: **(a) for v1**, **(b) on the roadmap**. The hard-gate is one bool of work and makes the safe path obvious. (b) is the long-term right answer.

### Spec revision #2 — collapse 6 phases to 3-4
**Flagged by simplifier + architect.** Phase 1 (settings/CLI) + Phase 2 (HTTP skeleton) should merge; capability discovery (`/props` parity) needs to land in the same phase to avoid contract rework.

Proposed:
- **Phase A**: capability + HTTP skeleton + CLI/env wiring + auth + disabled-mode (404 not 503 per simplifier)
- **Phase B**: save path with memory-safe async pipeline (use oMLX's existing scheduler primitives, not synchronous writer)
- **Phase C**: restore path + 2 guards (model fingerprint + ctx size only; defer quant + secondary tuple unless evidence demands)
- **Phase D**: cross-repo contract CI lane (pinned oMLX commit + version negotiation field)

### Spec revision #3 — concurrency state machine is not implementation detail
**Flagged by risk planner as the #1 cross-phase risk.** Save during active decode = unstable snapshot. Restore mid-decode = corrupted stream. Both span phases.

**Required**: spec must define `IDLE | SAVING | RESTORING | GENERATING` slot state machine + per-slot mutex semantics + busy-refusal behavior (409/423 responses, not silent races) BEFORE Phase B implementation starts.

### Spec revision #4 — persistence format should reuse existing oMLX machinery
**Flagged by architect #3 + simplifier #2.** oMLX already has safetensors-based serialization with cache-format versioning. `.npz + manifest.json` introduces a second stack.

**Required**: spec should note the existing primitives + justify the new format OR adopt them. Add explicit `slot_format_version` + dtype/shape/cache-class markers regardless of format choice.

### Spec revision #5 — cross-repo CI + capability negotiation
**Flagged by architect #5 + integration #1.** No mechanism today catches drift between our fork's slot API and llamactl's `UpstreamSlotClient` expectations.

**Required**: spec adds explicit `capabilities` object in `/props` or `/v1/slots/capabilities` endpoint. llamactl's `supportsSlots()` keys on capability, not field-presence. Pin minimum oMLX commit in llamactl docs. Add CI lane that builds both sides and runs save/restore parity.

### Spec revision #6 — `useProxy` ModelHost parity is a prerequisite
**Flagged by integration #5.** Slot API value for oMLX is realized via `useProxy` routing, but `useProxy` is on `ModelRunSpecSchema` only. ModelHost extension is a separate slice.

**Required**: file Slice X.3 (extend `useProxy` to ModelHostSpec + widen `kindIsModelRunWithLlamacppEngine` gate in openaiProxy KV path) as a prerequisite for the oMLX slot rollout being end-user-visible.

---

## Suggested action sequence

1. **Fix P0-1, P0-2, P0-3, P0-4** before any more production traffic accumulates on the proxy. These are landed-bug fixes, ~1 day of focused work each.
2. **Revise oMLX spec** with the 6 revisions above. ~1 short dispatch.
3. **Land P1 series** (5 items) as a follow-up batch.
4. **Dispatch oMLX implementation** (Phase A → D from the revised spec) only AFTER spec revision lands.
5. **P2/P3** as background cleanup when convenient.

## What was done well (consensus across personas)

- The proxy pipeline is legible and the layer boundaries are mostly clean (architect, security)
- Bearer auth uses constant-time compare + hashed-at-rest tokens (security)
- The CLI validation refuses `--no-auth` with non-loopback bind (security, boundary)
- Anthropic translator fails closed on unknown content blocks (security)
- The session built coherent building blocks (registry / storage / policy split) that make fixing the issues above tractable without rewrite (architect)
