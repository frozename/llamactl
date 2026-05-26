# Maestro continuation — 2026-05-25 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, no AI/tool attribution. Delegate coding via `chain_start`; hand-code only when the worker/daemon won't boot.

**Execute the First moves checklist (§6) immediately in efficient order, batching independent calls in parallel — don't ask permission per item.** Only pause for items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity ("decide whether to X"). The user authorized the checklist by handing it over.

---

## 1 — Where we ended (TL;DR)

Yesterday shipped the antirez/ds4-inspired KV cache + Anthropic `/v1/messages` endpoint + their cleanup pass. 41 llamactl commits + 1 oMLX commit. **All P0/P1/P2 review findings are fixed.** Internal proxy on 7944 is live; granite-3b + gains-host route penumbra traffic through it; KV slot files accumulating.

Day ended trying to dispatch **oMLX Phase B** (slot save implementation) and discovering that the daemon's `worker_extras` config doesn't subscribe a worker to the newly-registered `omlx` project. Every Phase-B dispatch attempt returned in 0s with `missing_adapter_lifecycle`. **That's the blocker to fix first today.**

## 2 — What yesterday shipped (just the why; diff has the what)

Grouped by initiative, oldest first.

### Anthropic /v1/messages endpoint + KV cache (Slices 1 + 2, plan in `docs/specs/2026-05-24-anthropic-endpoint-and-kvcache-plan-executable.md`)

| Phase | Commit | Why | How |
|---|---|---|---|
| 1 | f23f578 | Pipeline seam needed before any cache or translator could slot in cleanly | codex-acp-fast |
| 2 | 47c9193 | Anthropic→OpenAI request translator wired in `parseIncoming` branch | codex-acp-deep |
| 4 T4.1 | 9fd641e | SQLite registry + WAL + crash-recovery scaffold | codex-acp-deep |
| 3 T3.1 | dafc83d | Non-stream response translator (OpenAI→Anthropic shape) | codex-acp-fast |
| 4 T4.2 | a68c142 | DS4-shape eviction score (pure function, 6h hit half-life) | codex-acp-fast |
| 4 T4.3 | 1237777 | Secondary-guard lookup (sha alone too collision-prone) + ENOSPC safe-write | codex-acp-deep |
| 3 T3.2 | a002d15 | SSE state machine — last piece for Slice 1 ship | codex-acp-deep |
| 5 T5.1 | e58164d | Slot client (HTTP wrapper around llama-server slot save/restore) + workload_epoch helper | codex-acp-deep |
| 5 T5.2 | 1b98cce | Slot allocator + race transitions + orphan sweeper (schema v2) | codex-acp-deep |
| 6 T6.1 | ba70a8a | Wire KV cache into proxy (cold-miss save, warm-hit restore, budget eviction) | codex-acp-deep |
| 6 T6.2 | 0c6db38 | False-hit detection via first-token fingerprint (schema v3) | codex-acp-deep |
| 7 T7.1 | e847e71 | `kv-warm-bench` harness in `packages/eval/matrix` (per-frontier methodology from ds4-bench) | codex-acp-deep |

**Two production bugs were caught + fixed by live testing** during the bench (T7.2 manual run):
- `0299a82` + `56e5a9f`: slot save filename must be JSON body, not URL param (llama-server returned 500 "parse error attempting to parse an empty input")
- `928933a`: slot filename must be bare basename (llama-server rejects absolute paths with 400 Invalid filename)
- `6bff9db`: test mock updates to match the new wire shape

### Slice X — useProxy spec field + proxy-routing infrastructure

| Commit | Why | How |
|---|---|---|
| 7d7da1c | Workloads opt in via `useProxy: true` yaml field; `composite/apply` consumes it; new launchd plist for internal-only proxy on 7944 | codex-acp-deep |
| 526af7f | `--no-auth` flag must imply plain HTTP on loopback — was returning HTTPS-only causing transport mismatch with proxy URL | codex-acp-fast |
| 3530d39 | Supervisor consumes useProxy at startup → overrides `--workload=name@url` with proxy URL when the manifest has useProxy true | codex-acp-deep |
| 6ed0306 | Activate the path: granite-3b yaml gets useProxy:true + --slot-save-path; supervisor plist gets full workload names + --kind=ModelRun | hand |

The supervisor only health-probes through the proxy. **Actual inference benefit comes from the agentchat.yaml edits below** — those are USER CONFIG, uncommitted by design (live state, §3).

### Slice B — response-level cache + oMLX spec planning

| Commit | Why | How |
|---|---|---|
| 22a5873 | Phase 10 audit: oMLX has no slot API today; recommended Option C (KV-degraded) as immediate posture | codex-acp-deep (docs only) |
| 559dc34 | Phase 9: Anthropic exact tool-replay via KV trailer (closes Qwen3 canonicalization gap from `project_qwen_tool_grammar_2026-05-15`) | codex-acp-deep |
| f10b9b3 | 23 pre-existing tsc errors in `packages/eval` cleaned up (narrowing + Bun fetch-mock drift) | codex-acp-fast |
| 61144b4 | Slice B — response cache layer in front of KV cache. Backend-agnostic (benefits oMLX where KV is degraded) | codex-acp-deep |
| 6c340c1 | oMLX slot API spec v1 (Slice A.0) — design only, no impl | codex-acp-deep |

### Adversarial review + plan pass (yesterday's QA gate)

8 codex personas reviewed the day's diff + reviewed the oMLX spec. **None went through `/adversarial-review` before landing** — that's why we ran the gate after the fact.

| Commit | Persona | Output |
|---|---|---|
| 429563e | architect (review) | 5 structural risks |
| bdafb53 | security (review) | 5 attack surfaces |
| cb8f5b7 | simplifier (review) | 5 cuts |
| 2d53d63 | boundary (review) | 5 failure modes |
| 2e51846 | architect (plan) | 5 issues with oMLX 6-phase plan |
| 4d96f7a | simplifier (plan) | cut to 4 phases, drop 503→404 |
| 51ddee3 | risk (plan) | per-phase failure modes |
| 6f3799f | integration (plan) | cross-repo coordination story |
| a66ed84 | in-session synthesis (Opus) | P0/P1/P2 priorities + spec revisions |

### Fixes from the adversarial pass

| Commit | Severity | Why |
|---|---|---|
| ef26434 | P0-1 | SSE translator was dropping any frame containing `event:` or `id:` lines (spec-compliant upstreams lose all events) — fixed parser to respect SSE spec lines |
| d71fe5f | P0-2+3 | Response cache persisted partial SSE + status-200 error envelopes as warm hits + KV lease leaked when arrayBuffer threw mid-stream |
| d1c2126 | P0-4 | Schema migration not crash-safe (duplicate-column error on re-run after crash between ALTER and UPDATE schema_version) |
| 682dc48 | spec v2 | oMLX spec revised per all 4 planner findings (slot=0 hard-gate, 6→4 phases, concurrency state machine moved to spec proper, .npz justification, capability negotiation, useProxy ModelHost parity = Slice X.3) |
| cafb903 | P1-1/2/3/5 | Response cache scoped by workload+epoch+protocol_variant; shared canonicalization between KV + response cache; early body-size guard on /v1/messages; cache POST-translation for /v1/messages (avoid translator-version drift) |
| 6180e4a | P1-4 | `--no-auth` bypass scoped to `/v1/*` only — `/trpc` and control-plane mutation routes stay bearer-protected even in no-auth mode |
| 20b4453 | P2 cuts | Dropped unused `EXT_FLAG_THINKING_VISIBLE` + `RESPONSES_VISIBLE`; simplified `workloadEpoch` from `pid+startedAt+rel+argsHash` SHA to `startedAt+rel` (per simplifier review — pid was process-restart noise, argsHash flapped cache on mtime touch) |

### oMLX Phase A (in a different repo)

`/Volumes/WorkSSD/src/omlx` commit `0943c0e9` on branch `feat/slot-api-phase-a`:
- `omlx/settings.py`: `slot_save_path` + concurrency invariant (refuse boot when slot_save_path set AND max_concurrent_requests != 1)
- `omlx/cli.py`: `--slot-save-path` CLI flag
- `omlx/server.py`: `POST /slots/{slot_id}?action=save|restore` returning 501 when enabled; 404 when disabled; 400 invalid input. `GET /v1/slots/capabilities`. `slot_states: Dict[int, str]` state-machine scaffold.
- `tests/test_slot_{settings,routes,capabilities}.py`: 10 tests, **all 10 pass on M4 Pro** (sandbox can't run them due to Metal-device unavailable — that's environmental, not a real failure).
- **NOT pushed** to any remote.

Dispatched via codex-acp-deep with the "ignore-the-worktree, edit-oMLX-directly" prompt before oMLX was a registered project. Worker reported the same Metal-blocked pytest output; we verified by running pytest manually on M4 Pro post-dispatch.

## 3 — Live state (what's running, what's edited outside git)

### Persisted launchd services

```
launchctl list | grep -E "llamactl|penumbra"
```
expected entries:
- `com.llamactl.internal-proxy` — plist installed yesterday; **plain HTTP on 127.0.0.1:7944, --no-auth, opt-in**. Serves `/v1/*` without bearer for localhost; `/trpc` + control-plane still bearer-protected.
- `com.llamactl.fleet-supervisor` — bootout/bootstrapped yesterday with new args: full workload names (`granite41-3b-long-lived-local`, `gains-host-35b-local`) + `--kind=ModelRun`. Confirms supervisor stderr `[supervisor] workload=granite41-3b-long-lived-local routing via proxy http://127.0.0.1:7944 (was http://127.0.0.1:8083)`.
- `com.llamactl.node-agent` — original, unchanged.
- `com.llamactl.controller` — was kickstart-restarted yesterday to flush a stale in-memory snapshot.
- `dev.penumbra.daemon` + `dev.penumbra.worker` — both restarted yesterday so penumbra picks up the new agentchat URLs + project registry.

### Workloads through the proxy (uncommitted but persisted on disk)

`/Users/acordeiro/.config/agentchat/agentchat.yaml`: all 11 `baseUrl` entries point at `http://127.0.0.1:7944/v1`. Backup at `agentchat.yaml.bak-pre-proxy-2026-05-24`. Penumbra daemon + worker restarted to pick up new URLs. **Don't blow this away accidentally.**

### KV cache slot files (real traffic from yesterday)

`~/.llamactl/data/kvstore/slots/granite41-3b-long-lived-local/` accumulating real slot files (saw 698K and 36MB files from production granite-3b traffic).

### Quota state (end of yesterday)

- Anthropic seven-day window: **100% used**, resets 2026-05-30
- Anthropic five-hour: was 0% at session end, should be fresh by morning
- OpenAI primary: 11%, secondary: 5% — but **token quota was 0/1M** (exhausted)
- Google `gemini-3-flash-preview`: 98% remaining
- Google `gemini-3.1-pro-preview`: 100% daily

The **STANDARD/`implement_*` dispatch gate refused across all providers** at end of session — appears to be a composite cost-cap that projects total dispatch cost including worktree creation. Likely resets with the Anthropic five-hour window. **Test with a tiny TRIVIAL/unknown dispatch before assuming the gate is open.**

### Penumbra registry

`~/.penumbra/projects.yaml` now has 6 projects — `omlx` was added yesterday pointing at `/Volumes/WorkSSD/src/omlx` (`frozename/omlx` remote). `daemon_reload_config` picked it up (`project_registry_count: 6`). **But the worker is not subscribed to it** — see §4-A.

### oMLX repo state

- Branch `feat/slot-api-phase-a` at commit `0943c0e9` — Phase A landed.
- Tests pass on M4 Pro (10/10).
- NOT pushed. `git -C /Volumes/WorkSSD/src/omlx remote -v` shows `personal` → `frozename/omlx` + `origin` → `jundot/omlx`.

## 4 — Open follow-ups (concrete first moves)

### A) THE BLOCKER — configure `worker_extras` for the `omlx` project

Yesterday's last 6 dispatch attempts to caller_cwd=`/Volumes/WorkSSD/src/omlx` all returned 0s with `missing_adapter_lifecycle`. Adding oMLX to `~/.penumbra/projects.yaml` and reloading was **not enough** — the worker has to be subscribed too.

Read these to find the config:
- `packages/daemon/src/workers/config.ts` (look for `extra_worker_unknown_project` warning around line 109)
- `packages/daemon/src/routes/reload-config.ts:58` (`reloadExtraWorkersSubsystem`)
- `packages/daemon/src/serve.ts:214` (`workerAuthz` map)
- Search for the config file the worker-extras subsystem reads at startup (likely in `~/.config/agentchat/` or `~/.penumbra/`)

The fix is probably a one-yaml-entry addition + `daemon_reload_config` (which DOES handle `worker_extras` per the reload route — `worker_extras: workerExtras` returned in the reload response shape). Verify by re-dispatching the same Phase B prompt (below) and confirming it doesn't 0s-resolve.

### B) After A unblocks — dispatch oMLX Phase B

Spec: `docs/specs/2026-05-24-omlx-slot-api-spec.md` v2 (the revised one). Phase B = slot SAVE path with concurrency state machine + memory-safe async pipeline + two-phase commit + manifest. Commit on the SAME branch `feat/slot-api-phase-a` continuing Phase A.

Dispatch shape that's structurally correct (just blocked on worker-extras):
```
chain_start({
  initial_agent: "codex-acp-fast",   # or codex-acp-deep when quota allows
  task_class: "STANDARD",
  task_type: "implement_substantial",
  use_worktree: true,
  caller_cwd: "/Volumes/WorkSSD/src/omlx",
  message: <Phase B prompt — see message archive of conv-d59fc638-6f84-40be-9bef-0f5daeaf8fc1>
})
```

**Critical**: `caller_cwd` must be the oMLX repo (not llamactl) AND the prompt must NOT mention llamactl repo paths — the routing guard rejects with 400 `routing_guard.mismatch` if mentioned paths span projects. Inline the spec excerpt instead of referencing the path. Phase B prompt template is in conversation history; reuse with minor tweak.

### C) Then Phase C (restore + 2 guards) and Phase D (cross-repo CI parity)

Same pattern as Phase B. Per revised spec: only 2 guards in v1 (model_fingerprint + ctx_size); defer quant + secondary-tuple symmetry unless evidence demands.

### D) Slice X.3 — extend `useProxy` to ModelHostSpec

Prerequisite for oMLX rollout to be user-visible. Currently `useProxy` only exists on `ModelRunSpecSchema` (llama.cpp workloads). For oMLX (`ModelHost` kind) workloads to opt into proxy-routed KV via yaml, the schema needs widening + the proxy gate needs to drop `kindIsModelRunWithLlamacppEngine` exclusivity.

File: `packages/remote/src/workload/modelhost-schema.ts` (add useProxy field) + `packages/core/src/openaiProxy.ts` (widen the KV-eligibility check).

### E) Pre-existing tsc debt (low priority but tracked)

`packages/cli` + `packages/remote` have unrelated tsc errors that surfaced in dispatches but were correctly flagged as pre-existing. Same shape as the `eval-tsc` fix (commit `f10b9b3`): missing `allowExternalBind` in test fixtures, fetch-mock `preconnect` drift, missing `modelHostStart`/`modelHostStop`/`modelHostStatus` on test doubles. Mechanical cleanup, codex-acp-fast suitable.

### F) Worktree + branch cleanup

`/Volumes/WorkSSD/repos/personal/llamactl-worktrees/` accumulates worktrees per dispatch. Yesterday's cleanup brought 24 → 2; we'll have 5-10 more from the day's adversarial pass + post-cleanup dispatches. `git worktree prune` + `git branch -D agent/*` if it gets cluttered.

## 5 — Memories worth reading first

- `[[project-anthropic-endpoint-kv-cache-2026-05-24]]` — initiative overview, links to all 3 spec files in `docs/specs/`. Save state: Slice 1 + 2 shipped + adversarial pass cleaned up; oMLX Phase A in fork.
- `[[reference-extract-global-flags-trap]]` — flags like `--node`/`--context` get eaten by `bin.ts:317` before subcommands; relevant if touching CLI parsing for Slice X.3.
- `[[reference-daemon-reload-config-scope]]` — the reload scope quirk: agentchat validation refreshes, judge pool needs full daemon restart. Probably also relevant for `worker_extras` reload mechanics.
- `[[reference-penumbra-dispatch-routing]]` — predates today's `routing_guard.mismatch` lesson but related: project_id resolution from caller_cwd matters more than you'd think.
- `[[reference-mac-mini-launchd-bun-env]]` — bun under launchd has env quirks; relevant if Slice X.3 requires touching plists.
- `[[project-qwen-tool-grammar-2026-05-15]]` — the canonicalization gap that Phase 9 closes; useful context if you touch the trailer/tool_map code.

## 6 — First moves (run in efficient order, parallelize independents)

1. `git status --short && launchctl list | grep -E "llamactl|penumbra" && git log main --oneline -5`
2. `cd /Volumes/WorkSSD/src/omlx && git log --oneline -1 && git branch --show-current` — confirm Phase A is still at `0943c0e9` on `feat/slot-api-phase-a`
3. `mcp__penumbra__handoff_list_pending` and `mcp__penumbra__cost_quota_status` (parallel) — confirm clean handoff queue + quota windows reset
4. `bun test packages/core/` — confirm 457+ tests still green from yesterday's landings
5. **Address §4-A**: find the `worker_extras` config (start with `~/.penumbra/`, `~/.config/penumbra/`, then `packages/daemon/src/workers/config.ts`), add an entry for `omlx`, `daemon_reload_config`, smoke-test with a tiny dispatch like `chain_start({ initial_agent: "codex-acp-fast", task_class: "TRIVIAL", task_type: "unknown", caller_cwd: "/Volumes/WorkSSD/src/omlx", use_worktree: false, message: "reply ok" })`. If it doesn't 0s-resolve with `missing_adapter_lifecycle`, you've unblocked Phase B/C/D.
6. **Dispatch oMLX Phase B** per §4-B. After it commits + the user OKs, repeat for Phase C and D.
7. **Then Slice X.3** per §4-D.

If `worker_extras` turns out to be a more involved restructure, file a stumble (task_draft) and propose hand-implementing Phase B in-session instead — the spec is detailed enough.
