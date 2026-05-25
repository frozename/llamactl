# Maestro continuation — 2026-05-25 late

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, no AI/tool attribution. Delegate coding via `chain_start`; hand-code only when the worker/daemon won't boot.

**Execute the First moves checklist (§6) immediately in efficient order, batching independent calls in parallel — don't ask permission per item.** Only pause for items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity. The user authorized the checklist by handing it over.

---

## 1 — Where we ended (2026-05-25 evening)

This session shipped six tracks (A→F from the previous note's §5) and three new ones:

- **B (oMLX architecture-aware mcr=1 guard)** — `2bf929f5` on `feat/slot-api-phase-a` (pushed to `frozename/omlx`). Lets paged-cache models (Qwen / Gemma) run mcr>1 + `--slot-save-path` together; only `ChunkedKVCache` (Llama-4) still rejects. Live-validated at mcr=4 on `mlx-qwen36-35b-a3b-local`: 4 concurrent requests served truly in parallel (~11.5s wall, slot_api unchanged). Restored the 4× concurrent capacity yesterday's slot-v2 promotion gave up.
- **C (kv-warm-bench frontier label)** — `f66c9a8`. `--frontiers N` now means N model tokens (via `/v1/tokenize` probe + iterative builder), not N pseudo-words → ~6N tokens.
- **D+E (llamactl workload hygiene)** — `ec2443c` + `af175e6`. listWorkloads warns on duplicate `metadata.name`; `delete workload` now supports ModelHost.
- **Template alignment** — `745e40f`. `mlx-qwen36-35b-a3b-local.yaml` template now matches the promoted live state (was still `gains-host-35b-local` + mcr=4 + no slot-save-path).
- **Fleet placement scheduler spec + adversarial synth** — `716bb0c`. `docs/specs/2026-05-25-fleet-placement-scheduler.md` + `docs/notes/2026-05-25-fleet-placement-scheduler-synthesis.md` (5 personas: architect / simplifier / test-first / risk / integration).
- **Phase 1 — cross-node proxy routing** — `205de8c`. `packages/remote/src/config/cluster.ts` (config reader), `packages/core/src/workloadRuntime.ts` (`listClusterRoutes`, `PeerSnapshot`, `ClusterRoute`), `packages/core/src/openaiProxy.ts` (peer-aware proxy + CA agent + slot-op 400 + 502 cache invalidation). 25 tests, 0 fail; both tsc green.
- **Mac-mini :8197 slot canary killed** (PID 93970). Manifest moved aside on mac-mini. Freed ~3 GB initially but the box reabsorbed most of it within the hour — mac-mini at 16 GB total is genuinely full.
- **M4 fleet-supervisor plist re-sync** — live `~/Library/LaunchAgents/com.llamactl.fleet-supervisor.plist` was stale (still `gains-host-35b-local`). `cp + bootout + bootstrap` (kickstart -k alone doesn't reload plist). PID 15856 now correctly probing `mlx-qwen36-35b-a3b-local`.

## 2 — In flight at session end

**Phase 0+2 — fleet aggregator + observability** dispatch is running.

- handoff_id: `6577ffdd-8e87-4cdb-89a5-ad78dc725b12`
- conversation_id: `conv-43ac5fcc-3954-4d15-9ea4-046e46000c56`
- agent: codex-acp-deep (implement_substantial)
- started: 2026-05-25T20:47:21Z
- Scope per merged synth lines 106-178:
  - `packages/fleet-supervisor/src/aggregator.ts` — `FleetAggregator` with `pollNow/getSnapshot/getAll/start()`
  - `packages/fleet-supervisor/src/peer-fetch.ts` — `createPeerFetch(peer)` w/ `https.Agent` + CA from `caPemPath`
  - `packages/fleet-supervisor/src/aggregator-db.ts` — sqlite at `~/.llamactl/fleet/cluster.db`
  - `packages/remote/src/routes/fleet.ts` extend — `GET /v1/fleet/snapshot`
  - `packages/cli/src/commands/fleet.ts` new — `fleet snapshot [--all]` + `fleet status`
  - `packages/mcp/src/tools/fleet.ts` extend — `all` arg + `'fleet-placement'` to kinds enum (architect's FLAG-B preemptive fix)
  - `packages/fleet-supervisor/test/journalSchema.test.ts` — pre-condition for Phase 3

**First moves §6 includes a status check.** If the chain completed: verify the worktree (expect `feat/fleet-aggregator-phase02` or similar branch name — agent may pick its own due to namespace conflicts), `git log <base>..HEAD`, run the 5 new test files + tsc on each touched package, then land via `git merge --ff-only` + push (dispatch_land won't find the branch name; use manual ff merge — same pattern as Phase 1 land). If failed: read the `chain_get_response`, decide retry or split scope.

## 3 — Open follow-ups (post-Phase 0+2)

In dispatch order per the synth:

### A) Phase 3 — apply-time placement scheduler

- `packages/fleet-supervisor/src/placement.ts` — `scoreNodes` + `chooseBestNode` (pure functions).
- Manifest extension: `spec.node` optional or `'auto'`; new `spec.placement?: 'auto'|'pinned'`.
- Fix FLAG-A: `actionTier` in `packages/fleet-supervisor/src/types.ts` needs explicit cases for `place|move|drain` (already preemptively fixed via FLAG-B in Phase 0+2? confirm; if not, fold into Phase 3).
- Pre-condition: `journalSchema.test.ts` from Phase 0+2 must be green.

### B) Phase 4 — event-driven migration (HIGH risk)

- Gated behind `LLAMACTL_FLEET_MOVE_ENABLED=1`; off by default.
- `schedulerLease.holder` in `cluster.yaml` — leaseholder is sole emitter of `move` proposals.
- Make-before-break protocol (synth lines 270-283): launch on dest → health gate → evict source.
- Sticky window (10 ticks ≈ 5 min) to prevent ping-pong.
- Adversarial-review the diff before land.

### C) Phase 5 — `llamactl infra rollout`

- `llamactl infra install/activate/uninstall` already exist (sha-verified tarball + symlink flip). Phase 5 composes them.
- `llamactl infra rollout <pkg> --version --tarball-url --sha256 [--nodes <glob>] [--strategy one-at-a-time|all]` + `llamactl infra rollback`.
- Health gate between nodes via `/v1/fleet/snapshot` (from Phase 0+2).
- **Open Q: does `POST /v1/infra/install` already exist on the agent? If not, add it.** Synth flags this for confirmation before dispatch.

### D) Open Qs from the synth that need answers before Phase 4/5

1. Does `POST /v1/infra/install` already exist on the agent server?
2. Static vs dynamic `schedulerLease.holder` election when leaseholder is unreachable? (Plan assumes static for now.)
3. `spec.node: auto` default — should manifests with no `spec.node` field default to `auto`, or require explicit opt-in?

### E) Mac-mini reality check

- **16 GB total RAM**, currently ~4.6 GB free+inactive with 3 oMLX workloads (granite-3b / granite-8b / qwen3-8b, all mcr=4). User's earlier "headroom on mac-mini" intuition was overstated.
- Bench scripts at `~/.local/share/penumbra/packages/agentchat/scripts/bench-{fleet,grade}.ts` hit mac-mini's `:7843` directly with `/tmp/llamactl-mac-mini-ca.pem` — can switch to the proxy once Phase 0+2 + a cluster.yaml are in.

### F) Working-tree untracked cleanup (parked)

Many `docs/notes/maestro-continuation-*.md` + `docs/benchmarks/*.md` from prior sessions are untracked. User has not asked to clean them; leave alone unless asked.

### G) Upstream PR to `jundot/omlx` (parked)

User asked not to push upstream yet. B is on `frozename/omlx` `feat/slot-api-phase-a` only. Revisit after a few weeks of production miles on M4.

### H) Pre-existing diagnostics in penumbra `cycle.ts` (parked, not ours)

Earlier in-session a diagnostic surfaced TypeScript errors at `cycle.ts:134/637/653/658/671`. None of today's work touched penumbra `cycle.ts`. Pre-existing drift; route to a penumbra-side dispatch when convenient.

## 4 — Live runtime state at session end

| process | PID | role |
|---|---|---|
| `mlx-qwen36-35b-a3b-local` :8096 | 23766 | oMLX, mcr=**4**, slot v2, `--slot-save-path /Volumes/WorkSSD/cache/omlx-qwen36-35b-slots`. Architecture-aware guard (B) is active. |
| `granite41-3b-long-lived-local` :8083 | 72925 | llama.cpp granite-3b-Q8 long-lived |
| llamactl proxy :7944 | 65061 | exposes both local models. `cluster.yaml` not yet present → cross-node routing is a no-op until Phase 0+2 lands the fetcher |
| llamactl controller | 93358 | reconciler |
| llamactl fleet-supervisor | 15856 | freshly re-bootstrapped with correct plist |
| penumbra daemon | 18177 | `PENUMBRA_JUDGE_BASE_URL=http://127.0.0.1:7944` |
| penumbra worker | 21003 | |
| mac-mini :8194/5/6 | (remote) | granite-3b / granite-8b / qwen3-8b (oMLX, mcr=4 each) |

Mac-mini canary on :8197 killed mid-session.

## 5 — Conventions (carry over)

- Delegate substantive code via `chain_start`. Hand-implement only when the worker/daemon won't boot.
- Penumbra MCP for state; never query the live sqlite DB directly except for forensics.
- Search memory before non-trivial work — `mcp__penumbra__memory_search`.
- Repo text (commits, PR descriptions) is neutral; no AI/tool authorship attribution.
- For oMLX work, production is `mlx-qwen36-35b-a3b-local` :8096. mcr=4 + slot v2 + slot-save-path = live.
- All penumbra local-model traffic flows through the llamactl proxy at `http://127.0.0.1:7944`.
- `bun run typecheck` is a silent-pass no-op. Use real `bunx tsc -p <pkg>/tsconfig.json --noEmit`.
- `dispatch_land` only finds branches named `agent/<handoff_id>`. When agents use feature-branch names, land manually via `git merge --ff-only`.
- `launchctl kickstart -k` does NOT reload a plist. Use `bootout` + `bootstrap` when the plist file itself changed.

## 6 — First moves (next session)

1. Parallel: `git status --short && git log --oneline origin/main -8` (llamactl) + `git -C /Volumes/WorkSSD/repos/personal/penumbra log --oneline -3` + `git -C /Volumes/WorkSSD/src/omlx log --oneline -2 && git -C /Volumes/WorkSSD/src/omlx branch --show-current` + `launchctl list | grep -E "(penumbra|llamactl)"` + `mcp__penumbra__handoff_list_pending` + `mcp__penumbra__cost_quota_status`.
2. **`mcp__penumbra__chain_status` on `6577ffdd-8e87-4cdb-89a5-ad78dc725b12` (Phase 0+2 dispatch).** Three outcomes:
   - **completed + trustworthy** → `chain_get_response` for sha + diff; `cd <worktree> && git log <base>..HEAD && git diff --stat <base>..HEAD`; if all green: `git worktree remove --force <wt>` + `git merge --ff-only <branch>` + `git push origin main`. Mark task #14 complete.
   - **completed + `no_worktree_activity`** → false-positive trap (same as Phase 1). Same verification path; same manual ff-merge.
   - **failed / stale** → `chain_cancel`, read response for diagnosis, decide retry or split-scope.
3. Live probes: `curl -s http://127.0.0.1:8096/v1/slots/capabilities` (expect mcr=4), `curl -s http://127.0.0.1:7944/v1/models`, `curl -s http://127.0.0.1:8083/health`, `pgrep -fl "omlx serve" | head`, `ssh macmini.ai 'pgrep -fl "omlx serve" | wc -l; vm_stat | awk ...'`.
4. After Phase 0+2 lands:
   - Hand-write `~/.llamactl/cluster.yaml` with mac-mini peer entry (id: mac-mini, endpoint: https://macmini.ai:7843, caPemPath: ~/.llamactl/certs/mac-mini-ca.pem — copy `/tmp/llamactl-mac-mini-ca.pem` to that location first).
   - Smoke `llamactl fleet snapshot --all` → expect both nodes' free_mb + workload counts.
   - Smoke cross-node routing: `curl http://127.0.0.1:7944/v1/models` should now include mac-mini's qwen3-8b / granite-3b / granite-8b model ids. Try a chat completion against one.
   - Decide direction with the user: Phase 3 (placement scheduler), Phase 5 (infra-push), or polish/Phase-1-live-smoke first.

---
