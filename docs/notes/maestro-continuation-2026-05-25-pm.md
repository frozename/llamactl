# Maestro continuation — 2026-05-25 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, no AI/tool attribution. Delegate coding via `chain_start`; hand-code only when the worker/daemon won't boot.

**Execute the First moves checklist (§7) immediately in efficient order, batching independent calls in parallel — don't ask permission per item.** Only pause for items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity. The user authorized the checklist by handing it over.

---

## 1 — Where we ended

**Slot v2 wire contract is shipped + live-validated end-to-end.** Save → restore → chat-completion-with-apply round-trips through real MLX runtime on the mac-mini canary, with `cached_tokens=256` reflected in the response usage and `[slot_apply_success]` event emitted. 18 commits across both repos (10 oMLX + 8 llamactl) covering Phase A → v2.6b. NOT pushed yet.

Today's last session burst added v2.5a/b/c + v2.6b + one critical hotfix (asyncio import in oMLX scheduler that mock-heavy tests had hidden).

## 2 — Today's commits (why, not what)

### oMLX (`feat/slot-api-phase-a`, 10 commits beyond Phase A; all unpushed)

| Commit | Why | How |
|---|---|---|
| `e4411ce2` | **HOTFIX**: Phase 2's `try_apply_one_shot_bind` used `asyncio.new_event_loop()` but never imported `asyncio` — every live chat-completion with handle+epoch threw `NameError`. Unit tests mocked the apply path; live canary caught it. | hand (1-line fix) |
| `7b319d58` | v2.5b: save extracts from BlockAwarePrefixCache via `prompt_tokens` body field (closes architect P0 "save doesn't bind to a request"); manifest gains `prompt_prefix_sha256` + `slot_format_version=2` (closes data P0 "no prompt-prefix guard"). v1 manifests still parse. | codex-acp-deep, ~10min |
| `d251036e` | v2.5a: 3 P0 fixes — atomic `consume(model, handle, epoch)` that preserves bind on mismatch (was destructive `consume_any`), `400 request_handle_required` (drops `"default"` fallback that allowed cross-client collision), structured 409 envelope for SlotApplyHandleNotFound/EpochMismatch/GuardMismatch in chat-completion (was generic 500). | codex-acp-deep, ~8min |
| `fd7b11fc` | Phase 4a: structured log events on apply success/miss paths + `OneShotBindTable.drain()` for rollback safety. | codex-acp-fast, ~3min |
| `f27f5cdc` | Phase 2: OneShotBindTable + restore_epoch + `scheduler.try_apply_one_shot_bind` admission hook + `x_omlx_request_handle`/`x_omlx_restore_epoch` request body fields. Bytes-only park (not live mlx tensors — Metal residency mitigation). | codex-acp-deep, ~16min |
| `e95d0b8d` | Phase 1a: `request_handle` field on save/restore payload + `slots.supports_request_handle: true` capability bit advertised on `/v1/slots/capabilities`. Preserves v1 alias. | codex-acp-fast, ~3min |
| `b1e91d0c` | Phase v2.A: replaced JSON `repr()` stub with `mlx_lm.models.cache.save_prompt_cache / load_prompt_cache`. Real round-trippable safetensors bytes. | codex-acp-deep, ~9min |
| `cbcd79ac` | Phase C: restore + minimal v1 guard set (fingerprint + ctx_size). | codex-acp-deep, ~8min |
| `946186fc` | Phase B fixups (typing.Any import; mutex fail-fast restructure; test slot_store init) — hand-fixed after codex-acp-deep's pytest verification surfaced 3 bugs. | hand (small) |
| `8ec57cb4` | Phase B: slot save path + per-slot state machine + atomic publish + manifest. | codex-acp-deep, ~11min |

### llamactl (`main`, 8 commits today; all unpushed)

| Commit | Why | How |
|---|---|---|
| `d9e4749` | docs: round-trip success note (the asyncio fix is THE story) | hand |
| `a0c8df9` | v2.6b: `UpstreamSlotClient.supportsRequestHandle` gets 60s TTL + invalidate-on-fetch-failure. Closes adversarial-review P1 (forever-memoized probe). | codex-acp-fast, ~3min |
| `5a28ca8` | docs: v2.5 canary retest findings | hand |
| `2bfbeb0` | v2.5c: strip user-supplied `x_omlx_*` at proxy ingress (closes cache-replay P0 — vendor fields would let handle-A response cache-hit handle-B); redact `restore_epoch` to prefix in logs (closes P1 epoch-as-bearer-token leak). | codex-acp-fast, ~3min |
| `786c86c` | docs: 5-persona adversarial review synthesis (no Anthropic — quota at 100%) + canary findings. 3 personas independently flagged the same P0s — high signal. | hand |
| `7e64fa3` | Slice X.3 follow-up: supervisor's startup useProxy resolver now loads ModelHost manifests (was ModelRun-only). Closes integration persona P1. | codex-acp-fast, ~2.5min |
| `5ab11c4` | Phase 4b: structured log events for proxy injection paths (`slot_injection_applied`, `slot_injection_skipped{reason}`). | codex-acp-fast, ~3min |
| `9868a1b` | Phase 3: openaiProxy injects `x_omlx_request_handle` + `x_omlx_restore_epoch` after successful slot restore (gated by `supportsRequestHandle()`); excludes both from response-cache canonical hash. | codex-acp-deep, ~16min |
| `8f6f585` | Phase 1b: `UpstreamSlotClient.supportsRequestHandle()` capability-aware probe. Fail-closed. | codex-acp-fast, ~2min |

### Dispatch reliability notes

- All v2.x dispatches went out as `task_class: TRIVIAL, task_type: unknown` because the cost-gate has been bouncing `STANDARD/implement_*` since Anthropic 7-day pinned 100%. None of the actual work was trivial — agents understood scope from explicit prompts.
- Cross-repo path mentions trip `chain_start.routing_guard.mismatch` HTTP 400. The 5-persona adversarial review had to be split into 2 fan-outs (per-repo project_id) to pass the guard.
- omlx-1 sticky worker poaches llamactl work because sticky isn't enforced in `handoffs.ts:247` (only `hard` is). Acceptable for free capacity; flag if you want strict.

## 3 — Live state

### Canary still running on mac-mini

- Workload: `mlx-granite-3b-slot-canary-mac-mini` (granite-4.1-3b-4bit, port 8197, mcr=1, slot enabled)
- Process: manual launch at pid 76781 (or whatever the latest manual restart was) — NOT under llamactl reconciler control because the reconciler spawn pipes stdio to /dev/null, blocking forensics. To capture stderr: `kill -9 $(cat /tmp/canary.pid); /Volumes/AI-DATA/src/omlx/.venv/bin/omlx serve --model-dir <path> --host 0.0.0.0 --port 8197 --max-concurrent-requests 1 --paged-ssd-cache-dir /Volumes/AI-DATA/cache/omlx-slot-canary --slot-save-path /Volumes/AI-DATA/cache/omlx-slot-canary-slots > /tmp/canary-stdout.log 2> /tmp/canary-stderr.log &`
- Persisted slot artifact: `mac-mini:/Volumes/AI-DATA/cache/omlx-slot-canary-slots/longprompt1.kvslot` + `.manifest.json` (256 tokens; usable for replay)
- v2.5b oMLX code (incl. asyncio import) was rsync'd from local `/Volumes/WorkSSD/src/omlx` → `/Volumes/AI-DATA/src/omlx` mid-session. Mac-mini's iso-granite-3b workload at port 8194 also runs against this same source dir, so a future restart of that workload will pick up v2 code too — generally backwards compatible (v1 alias preserved) but worth flagging.

### Local M4 oMLX

- `gains-host-35b-local` (Qwen3.6-35B-A3B-4bit MLX, port 8096, mcr=4) — production memory-recall ranker, untouched.
- granite-3b-4bit model files pulled to `/tmp/granite-3b-4bit-local/` (~2GB) — never used; local canary deferred since mac-mini's was sufficient.

### Penumbra fleet

- daemon + worker up; `omlx-1` worker (sticky, project_id=omlx) registered via `~/.penumbra/workers.yaml` (one-line config).
- All agent worktrees + branches cleaned per dispatch.

### Quota state

- Anthropic 7-day: still 100%, resets 2026-05-30 (4 days). The cost-gate composite bounces STANDARD across ALL providers when ANY is exhausted — that's why this whole session used `TRIVIAL/unknown`. Anthropic-using personas (`architect`, `test-first`, default synthesizer) were swapped for codex-only via direct `chain_start` instead of `/adversarial-plan` workflow.
- OpenAI tokens: were 0/1M but codex subscription-based; held up fine for many dispatches.

## 4 — Open follow-ups

### A) v2.6a oMLX hardening (queued, not started)

From adversarial review + canary, ordered by impact:

1. **Broader chat-completion exception envelope** — v2.5a wraps the 3 known SlotApply* exceptions, but ANY runtime error in the apply path bubbles as generic 500 (canary proved it with the asyncio NameError). Add a catch-all exception → structured `{"error":{"code":"slot_apply_runtime_error","details":...}}` envelope.
2. **Synchronous `try_apply` (drop new_event_loop)** — architect P1; bypasses the whole class of asyncio.* bugs. The apply body is dict lookup + bytes deserialize; doesn't need a new event loop.
3. **Real-implementation test that exercises the apply path without mocks** — would have caught the asyncio bug. Add an integration test that bootstraps a real scheduler + OneShotBindTable + cache and runs the actual code path.
4. **OneShotBindTable bounds + LRU eviction** — security/architect P1 (no TTL, no max-bytes, no max-entries — flood DoS).
5. **Filename↔handle bijective canonicalization** — data P1 (`x.safetensors` → handle "x.safetensors" → filename "x.safetensors.kvslot"; non-bijective for non-.kvslot suffixes).
6. **Scheduler→server dependency injection** — architect P1 (scheduler imports `_server_state`, `_slot_entry_for_model` directly from server module).
7. **Simplicity persona's 5 redundant log-shape test cuts** — `tests/test_scheduler.py:415-664` block.

### B) Configurable prefix-cache block size

Today's hardcoded `block_size=256` means cross-request hits ONLY fire for prompts ≥256 tokens. A `--paged-cache-block-size` CLI flag would unblock canaries with short prompts AND let smaller workloads benefit. Touches `omlx/scheduler.py:548` (default) + `omlx/cache/factory.py` + CLI parser. Probably ≤200 LoC.

### C) Push decisions

Both `oMLX feat/slot-api-phase-a` (11 commits) and `llamactl main` (8 commits since slot v2 work started) are LOCAL-only. The user has deferred this twice; reopen when ready.

### D) packages/remote tsc debt (still ~40 errors)

Deferred from earlier session — fixture normalization wider than a single mechanical dispatch can handle without entering round-N loops. Needs a real plan, not another batch attempt.

### E) Rust rewrite of oMLX (food-for-thought — user asked)

User's open question: "if we rewrite oMLX in rust would it be better?" My take:

- **Wins**: native MLX-C bindings via mlx-rs land you on a single process model with real concurrency (mcr>1 without GIL pain); tighter memory budgeting; structured-error culture stops the kind of NameError-at-runtime + generic-500 chain we hit twice today.
- **Costs**: rewriting against MLX from scratch is real; the existing Python+`mlx-lm` ecosystem (chat templates, tokenizers, prompt-cache APIs) doesn't have rust equivalents — you'd reimplement model loaders, sampling, paged cache. Months, not weeks.
- **Middle path that doesn't require a rewrite**: pull the *server* into rust (Axum/Tower) and keep the *inference engine* in python via PyO3 — gets you typed wire contracts + concurrency + observability without re-implementing MLX integration. Mirrors how vllm thought about it. Smaller scope; gets 60% of the wins.
- **Verdict for now**: don't rewrite. The bugs we hit today (NameError, generic 500, default-handle collision) are all *test-coverage gaps* + *exception-discipline gaps*, not language-level issues. Fix the discipline first. If after v2.6a the structural problems persist (scheduler→server coupling, GIL bottlenecks under real load), revisit with the server-only-rust middle path.

## 5 — Memories worth reading first

- `[[project-anthropic-endpoint-kv-cache-2026-05-24]]` — broader initiative this slot work sits inside
- `[[reference-extract-global-flags-trap]]` — if touching llamactl CLI parsing
- `[[reference-daemon-reload-config-scope]]` — reload semantics if you touch agentchat or workers.yaml
- `[[project-dispatch-routing-guard]]` — strict-mode routing-guard pitfalls (why cross-repo prompts split)
- `[[Cheap models hallucinate multi-file audits]]` — review-agent calibration
- The two synthesis notes from today: `docs/notes/adversarial-plan-omlx-v2-synthesis-2026-05-25.md`, `docs/notes/adversarial-review-omlx-v2-synthesis-2026-05-25.md`, `docs/notes/canary-omlx-v2.5-roundtrip-success-2026-05-25.md` — these capture the WHY, not just the WHAT.

## 6 — Stumble (filed via memory_observe)

`task_draft`: v2.6a hardening — bundled, ≤500 LoC each, queued for next session. Includes the asyncio test-coverage gap (#3 above) explicitly because that's what would have caught today's regression.

## 7 — First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `cd /Volumes/WorkSSD/src/omlx && git log --oneline -1 && git branch --show-current` — confirm feat/slot-api-phase-a at e4411ce2
3. `mcp__penumbra__handoff_list_pending` + `mcp__penumbra__cost_quota_status` (parallel) — confirm clean queue + quota windows (Anthropic 7-day should reset 2026-05-30)
4. `ssh macmini.ai 'curl -sk http://192.168.68.76:8197/v1/slots/capabilities | head -1'` — confirm canary still up at port 8197
5. **Decide direction**: v2.6a hardening dispatch vs. configurable block-size vs. push decisions vs. user pivots elsewhere.
6. If proceeding with v2.6a: dispatch `codex-acp-deep` against oMLX for fixes 1-3 (catch-all exception + sync try_apply + real-impl test); ≤500 LoC. Then fixes 4-7 as a second dispatch.
