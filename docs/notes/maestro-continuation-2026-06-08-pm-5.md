# Maestro continuation — 2026-06-08 pm (part 5)

> Paste into the next session. You are taking over as maestro in
> `/Volumes/WorkSSD/repos/personal/llamactl`. Follow `AGENTS.md`. Repo text is
> neutral (no AI-tool attribution). Use Penumbra MCP for chain/state; never query
> the live sqlite directly. Delegate coding via `chain_start`; hand-code for
> correctness-critical / live-infra work (this session was almost entirely live
> infra on the mac-mini + the M4 Pro proxy, so it was hand-done).
>
> Execute the **First moves** (§6) immediately in efficient order, batching
> independent calls — don't ask per item. Pause only for user-visible blast radius
> (push, dispatch_land, restart hosted services, external messages) or genuine
> ambiguity. **Deep detail for everything below lives in
> `docs/notes/maestro-continuation-2026-06-08-pm-4.md`** — read it before touching
> the mac-mini routing/cache code.

## Theme of this session
Turned the **mac-mini (M4, 16 GB) into a productive, proxy-routed LLM + embedding
node** for the fleet, behind the M4 Pro `:7944` central proxy with verified cache
gains. Plus the original pm-3 stability items (1 + 2) at the start.

## What shipped (commits since `cef3bb4`, all hand-coded)
- `cdf582b` + `bc0527c` — **ModelRun server adoption** in `core/src/server.ts`.
  The mac-mini node-agent's native llama-server spawn is **TCC-blocked**
  (launchd-reparented, can't read `/Volumes/AI-MODELS`), so the fix is: hand-start
  the server (interactive-session TCC) and the node-agent **adopts** it on the
  controller's `serverStart` (writes pid+state instead of erroring "foreign
  process"). `bc0527c` fixes the lsof lookup to find `--host 0.0.0.0` listeners
  (port-only fallback). Tests: `core/test/server-adoption.test.ts` 8/8.
- `7deba69` — **route ModelRun by `--alias` as well as rel** in
  `workloadRuntime.ts:listLocalRoutes` (link 4). Servers advertise the alias on
  `/v1/models`; without this the alias fell through to the node default endpoint.
- `160a4df` `7a13a32` `c6ebe73` — **production peer-snapshot poller**
  (`remote/src/server/peer-snapshot-poller.ts`, wired into `startAgentServer` via
  `peerSnapshotPoll`, enabled by `agent serve`). Polls each peer's
  `/v1/fleet/snapshot` → `openaiProxy.setPeerSnapshots`. Two bugs chased here are
  worth remembering (see Memories): **module-instance mismatch** (relative core
  import ≠ `@llamactl/core` under bun → published to a singleton the proxy never
  read) and **macOS `free_mb` always-low** → every peer wrongly HIGH pressure.
- `9b3e674` — **response cache for peer routes**. `maybeResponseCacheLookup` keyed
  via the local-only `resolveRouteKvMetadata`; gave it its own peer epoch
  (`peer:<node>:<model>`), keeping the KV *slot* path local. Identical
  deterministic request to the mac-mini 0.355 s → 0.011 s (~33×).
- `b004a61` `40721ca` `8b3c142` — notes.

## Live-infra work NOT in git (mac-mini + M4 Pro, all verified)
- **Stability items 1+2 (pm-3)**: controller reconcile-clobber fix activated
  (controller runs `bun bin.ts` from source — restart, no dist). Disabled the dead
  `granite41-3b-judge-mac-mini` (it pointed at the deleted atomic binary) →
  reconcile passes ~4 min → ~15 s. Refiner 90 s timeout already live in daemon.
- **mac-mini cleaned**: tore down 13–17-day orphan omlx servers + the `iso`
  stress-supervisor (`launchctl bootout`+`disable com.llamactl.fleet-supervisor`).
- **Embedding gains test (your "migrate if gains")**: 3-way A/B (MiniLM-L6 vs
  bge-m3 vs bge-large-en) on `packages/eval/corpora/memory-recall/v0/test.jsonl`.
  **MiniLM-L6 wins → NO penumbra embedding migration** (penumbra keeps bundled
  all-MiniLM-L6-v2 / fastembed).
- **Productive mac-mini workloads** (hand-started, node-agent-adopted, registered
  in DevStorage workloads, route by rel + alias):
  - granite-3b `:8086` alias `granite-mini-3b` (Q8 GGUF) — penumbra judge model.
  - bge-m3 embed `:8098` alias `bge-m3` (FP16, 1024-dim). Symlinked the cached
    GGUF into `models/bge-m3-GGUF/bge-m3-FP16.gguf` so the spec target resolves.
  - Qwen3-8B was brought up then **dropped** (you asked) — 3 LLMs OOM'd the 16 GB
    box; `qwen3-8b-mac-mini` spec is `enabled:false`.
- **node-agent on the mac-mini was rebuilt + redeployed** (adoption + link4 + the
  0.0.0.0 fix): `bun run build:agent` → scp `…/artifacts/agent/darwin-arm64/
  llamactl-agent` → `pkill agent serve` → swap (`.previous` kept) → run
  `~/.llamactl-agent/start-agent.sh` (nohup; NOT launchctl — avoids the bun
  respawn hang). Binds `:7843` in ~4 s.
- **Productive fleet-supervisor** runs on the mac-mini (watches granite + embed,
  writes the fleet-snapshot journal the M4 Pro poller reads).
- **penumbra `agentchat.yaml` `granite-mini-3b` agent un-broken** + verified
  (TLS cert refreshed at `~/.llamactl/certs/mac-mini.pem`, token, model=rel →
  "READY"). It targets `https://192.168.68.76:7843/v1` directly.
- **Durability scripts on the mac-mini**: `~/.llamactl-agent/start-workloads.sh`
  (idempotent bring-up of granite + embed + supervisor) and
  `REGISTER-WORKLOADS-LOGIN-ITEM.sh`. Servers are nohup (survive until reboot);
  reboot-durability needs the REGISTER script run **once from the mac-mini GUI**
  (System Events needs a UI session; SSH can't).

## Cache effectiveness (verified through :7944 → mac-mini)
- **Prompt/prefix cache** (llama-server `--cache-reuse`): 907-token system prompt
  prefill **1969 ms → ~100 ms (~19×)**, 898/907 tokens reused. The big win for a
  fixed-system-prompt judge.
- **Response cache** (proxy): identical deterministic request ~33× (0.355→0.011 s),
  now covers peer routes too.

## Live state (end of session, UTC 22:11Z)
- M4 Pro launchd: controller pid 61122, node-agent 45245, **internal-proxy 86507
  (:7944, runs `agent serve` from source — restart picks up core/remote edits)**,
  fleet-supervisor 39444, penumbra daemon 17296. All up.
- mac-mini: granite :8086 ✅, bge-m3 :8098 ✅, supervisor ✅, node-agent :7843 ✅,
  ~56 % free RAM.
- Cluster token (kubeconfig `/Users/acordeiro/DevStorage/config`, user `me`):
  `ll_agt_hhMIvwSymXSysUkGE4g_azFFX1GRRy5P`. mac-mini cert pinned in that config +
  at `~/.llamactl/certs/mac-mini.pem`.
- Tree clean except untracked `docs/notes/*`. `main == origin` was true at session
  start; **this session's commits are local-only (not pushed)** — main is
  PR-protected (admin-bypass pushes). Ask before pushing.

## Open follow-ups (non-blocking)
1. **Push this session's 7 code/doc commits** (`cdf582b..8b3c142`) — local only.
   Needs admin-bypass or a PR; ask the user first.
2. **Reboot durability** — run `~/.llamactl-agent/REGISTER-WORKLOADS-LOGIN-ITEM.sh`
   from a terminal **on the mac-mini GUI** (can't be done over SSH).
3. **Peer response-cache unit test** — behavior verified live + 80 regression
   tests pass; a dedicated `peer:<node>:<model>` epoch unit test in
   `core/test/responsecache/` would lock it. Note the documented trade-off: a
   model SWAP under the same peer alias needs a manual cache flush.
4. **Lower-priority carried items** (from pm-3, untouched): item 3 omlx
   orphan-on-stop in `packages/eval/src/matrix/lifecycle.ts` (process-group
   teardown); items 5/6 stale atomic-fork refs in `packages/eval/specs/*.json` +
   `templates/workloads/gemma4-e4b-vanilla-local.yaml` + `AGENTS.md`
   (re-point to `/Volumes/WorkSSD/src/llama.cpp/build/bin/llama-server`; note
   system `grep` is `ugrep` — use `rg` or explicit file lists); item 7 cost-quota
   false positives; item 8 gemma QAT ARC/GSM8K.

## Memories worth reading
- `docs/notes/maestro-continuation-2026-06-08-pm-4.md` (this session's deep log).
- `reference_launchd_respawn_bun_compiled_hang_2026-05-25` + `reference_mac_mini_launchd_bun_env` — mac-mini agent deploy hazards.
- `project-launchd-getcwd-hang-after-bootouts` — TCC/launchd spawn breakage (the root of the adoption need).
- `feedback_mac_mini_ram_admission_underestimate_2026-05-17` + `llamactl-single-workload-per-node-oom-2026-05-13` — why 3 LLMs OOM'd 16 GB.
- `reference_mac_mini_ssh_alias` — `ssh macmini.ai`, paths.

## First moves
1. `git -C /Volumes/WorkSSD/repos/personal/llamactl log --oneline -1` (8b3c142);
   `git status --short`; `launchctl list | grep -E 'llamactl|penumbra'`;
   `mcp__penumbra__handoff_list_pending`.
2. mac-mini health + routing through the proxy:
   `ssh macmini.ai 'for p in 8086 8098; do curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$p/health; done'`
   then `curl -s http://127.0.0.1:7944/v1/models` (expect `granite-mini-3b` + `bge-m3` among the ids).
3. Confirm cache still routes: `curl -s http://127.0.0.1:7944/v1/chat/completions -H 'content-type: application/json' -d '{"model":"granite-mini-3b","messages":[{"role":"user","content":"hi"}],"max_tokens":4}'` (served fp `b172…` = mac-mini).
4. Pick direction with the user from Open follow-ups — likely push the commits (#1) or close the embed/cache unit-test (#3).
