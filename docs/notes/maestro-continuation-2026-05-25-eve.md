# Maestro continuation — 2026-05-25 eve

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, no AI/tool attribution. Delegate coding via `chain_start`; hand-code only when the worker/daemon won't boot.

**Execute the First moves checklist (§7) immediately in efficient order, batching independent calls in parallel — don't ask permission per item.** Only pause for items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity. The user authorized the checklist by handing it over.

---

## 1 — Where we ended

oMLX **v2.6a + v2.6b** are both shipped, reviewed (2 adversarial rounds, 1 surgical correction round), live-verified end-to-end on all 3 oMLX processes (M4 Pro canary, M4 Pro gains-host-35b production, mac-mini canary), and pushed to `frozename/omlx`. Penumbra's `UX hygiene` improvements are landed, pushed, and active on the now-restarted daemon. llamactl `main` was pushed earlier today (the 8 slot v2 commits).

The session arc:
1. v2.6a hardening (3 bundles + 2-round adversarial review + 1 cap-break surgical round) — landed `ece985d9` → `57917e38` on `feat/slot-api-phase-a`.
2. Live-deployed v2.6a to mac-mini canary, then to M4 Pro (new canary on :8198 + gains-host restart). M4 deployment surfaced 2 real oMLX bugs.
3. v2.6b additive + refactor → fixes the M4-surfaced bugs + addresses the 4 deferred medium-severity follow-ups from round-2 review.
4. Penumbra UX hygiene → 5 maestro-experience improvements (incl. accurate `dispatch_land` sha + audit-aware auto-accept + persona fuzzy-match + memory titles + worktree PYTHONPATH guidance).

## 2 — Commits beyond v2.5b on `feat/slot-api-phase-a`

| Commit | Why | Notes |
|---|---|---|
| `0de0d2a5` | v2.6b refactor — shared `SlotResolveResult` resolver (F2) + `OneShotBindTableProtocol` typed DI (F3) + `SlotApplyRuntimeError.reason` enum (F4) + `BindResult` return (F5). 240 tests pass. | codex-acp-deep, 7m07s. Closes round-2 deferred items. |
| `a0832d6e` | v2.6b additive — `SlotSaveRuntimeError` + narrow save catch + sanitized "slot save failed" + WARNING-log w/ correlation_id; persist hygiene (don't write `slot_save_path`/`model_dirs`/`ssd_cache_dir` to `~/.omlx/settings.json`); `POST /v1/tokenize` endpoint. 291 tests pass. | codex-acp-deep, in parallel with penumbra UX hygiene. |
| `57917e38` | v2.6a round-3 — `SlotApplyRuntimeError` → HTTP 500 (was 409, semantically wrong for unclassified server-fault) + delete dead `x_omlx_request_handle is None` guard. 4 lines changed. | codex-acp-fast, 1m36s. Cap-break for genuine HIGH from round-2 review. |
| `de380a0c` | v2.6a round-2 — atomic `OneShotBindTable.consume_sync/peek_sync` (closes F1 direct `_entries` access); narrow `SlotApplyRuntimeError` catch (closes F2 over-broad except); generic sanitized message + correlation-id WARNING log (closes F6 str(exc) leak). 230 tests pass. | codex-acp-deep, 14m23s. Closes round-1 blocking findings. |
| `0e292849` | bundle C — `--paged-cache-block-size` CLI flag (default 256). | Pure-additive. |
| `1041b2d4` | bundle B — OneShotBindTable bounds/LRU/TTL + filename↔handle canonicalization (reject `.kvslot`-suffixed handles 400) + scheduler dependency injection (slot_lookup_fn etc.) + 4 redundant log-shape test cuts. 229 tests pass. | codex-acp-deep. |
| `ece985d9` | bundle A — catch-all chat-completion exception envelope + sync `try_apply_one_shot_bind` (drops `asyncio.new_event_loop`) + real-impl integration test exercising the full apply path without mocks. 17 tests in new file. | codex-acp-deep, 9m37s. Real-impl test would have caught the asyncio NameError that bit live this morning. |

## 3 — Live state across all 3 oMLX processes

| Process | Where | PID | Code | Slot API |
|---|---|---|---|---|
| M4 canary | local 127.0.0.1:8198 | (relaunched, see /tmp/canary-m4.pid) | v2.6b | enabled, mcr=1 |
| gains-host-35b-local | local 127.0.0.1:8096 | 3852 | v2.6b | NOT enabled (no --slot-save-path) |
| mac-mini canary | macmini.ai 192.168.68.76:8197 | 93970 | v2.6b | enabled, mcr=1 |

All three respond to `/v1/tokenize` and `/v1/slots/capabilities` correctly. M4 canary's slot artifact at `/Volumes/WorkSSD/cache/omlx-slot-canary-m4-slots/v26b_canary.kvslot`; mac-mini's at `/Volumes/AI-DATA/cache/omlx-slot-canary-slots/longprompt1.kvslot` (preserved from v2.5b round-trip).

Penumbra daemon + worker restarted post-`f96d435d` land — fresh PIDs 17150 + 17157. UX hygiene improvements now active (next session will see real landed-tip shas, no `force:true` for clean dispatch_land, fuzzy-matched persona names, memory titles in chain_start, PYTHONPATH guidance in codex-acp-deep prompts).

## 4 — Real bugs surfaced + fixed live

| # | Bug | Where surfaced | Fix |
|---|---|---|---|
| asyncio.NameError | `scheduler.py:3489` missing import | mac-mini canary v2 round-trip 2026-05-25 am | hotfix `e4411ce2` morning + bundle A's real-impl integration test prevents recurrence |
| `f6f4269c` placeholder sha in `dispatch_land` response (for `main`-named branches) | every land today | penumbra `f96d435d` (a) adds a test that locks the post-merge tip contract |
| `verdict_unverified` 409 forcing `force:true` every land | every land today | penumbra `f96d435d` (b) — audit-aware auto-accept |
| persona name typo `"simplifier"` rejected | adversarial-review round 1 | penumbra `f96d435d` (c) — Levenshtein ≤2 fuzzy-match |
| `recalled_memory_ids` opaque (no titles) | every chain_start | penumbra `f96d435d` (d) — `recalled_memories[]` additive field |
| codex-acp-deep pytest imports from shared checkout, not worktree | bundle B + bundle C verification | penumbra `f96d435d` (e) — system prompt now tells the agent to prepend `PYTHONPATH=$PWD` |
| `~/.omlx/settings.json` cross-contamination — canary's `slot_save_path` bled into gains-host launch | M4 gains-host restart for v2.6a | oMLX `a0832d6e` — settings save now excludes per-launch fields |
| save-path catch-all returns `str(exc)` + no logger.exception → swallows tracebacks | M4 first round-trip attempt | oMLX `a0832d6e` — mirror of round-2 F6 on save path |
| save path needs `prompt_tokens` (ints), no `/v1/tokenize` endpoint to produce them | M4 round-trip attempt | oMLX `a0832d6e` — `POST /v1/tokenize` |

## 5 — Open follow-ups

### A) `dispatch_land` sha bug for non-main-named branches (penumbra)

Penumbra `f96d435d` added a contract test that locks the correct behavior for `main`-targeted lands. But today's oMLX lands targeted `feat/slot-api-phase-a` and continued to return the `f6f4269c` placeholder. The fix may need to honor the actual branch ref in the response, not just `rev-parse main`. **One-line probe**: do a `dispatch_land --mode ff` against `feat/slot-api-phase-a` after the daemon restart; if it still returns `f6f4269c`, there's a per-branch resolution gap.

### B) `chain_start project_id: "penumbra"` rejected with HTTP 400 from llamactl session

Workaround in this session: use `caller_cwd: "/Volumes/WorkSSD/repos/personal/penumbra"` + `task_type: implement_small` (not `implement_substantial`). Could be cost-gate composite (anthropic still happy though), routing-guard mismatch (the project_id name doesn't match what the daemon expects), or both. Worth investigating because cross-repo dispatches are common.

### C) mcr (`max_concurrent_requests`) still persisted in `~/.omlx/settings.json`

v2.6b excluded `slot_save_path`/`model_dirs`/`ssd_cache_dir` but NOT `scheduler.max_concurrent_requests`. CLI args override correctly so today's incident wouldn't recur, but a future launcher that doesn't set `--max-concurrent-requests` explicitly will inherit whatever the last process used. Softer bug; can defer.

### D) Push penumbra UX hygiene branch protection (info)

`origin/main` push to `frozename/llamactl` earlier today triggered a "Bypassed rule violations" notice (main requires PR; user has bypass). Same may apply to penumbra. If you intend to enforce PR flow going forward, swap to feat-branch + gh pr create.

### E) Investigate why bundle B's `OneShotBindTable.put()` / `bind()` naming inconsistency

The dispatched v2.6b refactor mentioned changing `bind()` signature to return `BindResult`, but the actual API today exposes `put()` (the agent's report). They may have ended up overloading. Worth a quick `grep -n "def put\|def bind" omlx/slot_store.py` to confirm the public API is what we expect.

### F) Deferred from this session

- Hand-implemented `logger.exception` probe on save catch-all (reverted before commit) — properly addressed in v2.6b `a0832d6e`.
- llamactl `packages/remote` tsc debt (~40 errors) — still on the long-deferred list.
- Rust rewrite of oMLX — answered "no, not yet" in 2026-05-25 pm note; still no.

## 6 — Push state

All pushed today:
- llamactl `main` → `frozename/llamactl` (`0f2be60`; branch-protection bypass auto-applied)
- oMLX `feat/slot-api-phase-a` → `frozename/omlx` (`0de0d2a5`; new tracking branch)
- penumbra `main` → `frozename/penumbra` (`f96d435d`)

## 7 — First moves

1. Parallel: `git status --short && git log --oneline origin/main -5` (llamactl) + `cd /Volumes/WorkSSD/src/omlx && git log --oneline -2 && git branch --show-current` (oMLX) + `cd /Volumes/WorkSSD/repos/personal/penumbra && git log --oneline -2` (penumbra) + `launchctl list | grep penumbra` + `mcp__penumbra__handoff_list_pending` + `mcp__penumbra__cost_quota_status`.
2. Live state probes in parallel: `curl -s http://127.0.0.1:8198/v1/slots/capabilities` (M4 canary), `curl -s http://127.0.0.1:8096/v1/models` (gains-host), `ssh macmini.ai 'curl -s http://127.0.0.1:8197/v1/slots/capabilities'` (mac-mini canary).
3. Decide direction with the user. Most natural pick-up:
   - **(A1)** Smoke-test the penumbra UX hygiene improvements end-to-end: run a tiny `chain_start` + observe `recalled_memories[]` populated; run a `dispatch_land` against `feat/slot-api-phase-a` and check if the placeholder sha returns (open #5A); attempt persona name `"simplifier"` in adversarial-review and confirm fuzzy-match warning surfaces.
   - **(A2)** Tackle #5B (chain_start `project_id: "penumbra"` rejection from llamactl) — root-cause + fix in penumbra.
   - **(B)** Move off the slot work entirely: address the broader Anthropic-endpoint + KV-cache plan (Slice 3 onwards per `docs/specs/2026-05-24-anthropic-endpoint-and-kvcache-plan-executable.md`).
   - **(C)** llamactl `packages/remote` tsc debt cleanup.

## Conventions for this session

- Delegate substantive code via `chain_start`. Hand-implement only when the worker/daemon won't boot.
- Use Penumbra MCP for state (`handoff_get`, `chain_wait`, `chain_get_response`); never query the live sqlite DB directly except for forensics.
- Search memory before non-trivial work — `mcp__penumbra__memory_search`.
- Repo text (commits, PR descriptions) is neutral; no AI-tool authorship attribution.
- For cross-node oMLX work, use `mcp__llamactl_*` via the daemon; do not ssh into mac-mini and run `llamactl` from there (the source tree there is often stale relative to `/Volumes/WorkSSD/src/omlx`).
- The new `/v1/tokenize` endpoint on oMLX gives `{token_ids, n_tokens, applied_chat_template}` for `{model, messages}` or `{model, prompt}` — use this when crafting slot-save payloads, never load mlx_lm locally just for tokenization.
