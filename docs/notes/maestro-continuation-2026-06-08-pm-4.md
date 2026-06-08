# Maestro continuation — 2026-06-08 pm (part 4)

> Focus this session: stability/perf closeout (handoff pm-3) THEN a pivot to
> "make the mac-mini a productive free LLM + embedding node, behind our proxy
> for cache gains" (user directive). Neutral repo text; Penumbra MCP for state.

## What shipped / verified this session

### Stability (handoff pm-3 items)
- **Item 1 ✅** — refiner-90s-timeout (`penumbra@f2fb9bd0`) already LIVE in daemon
  (log: `dispatch-refine … timeoutMs:90000`); controller reconcile-clobber fix
  (`llamactl@41e724c`) ACTIVATED via controller restart (56971→64702). The
  controller runs `bun packages/cli/src/bin.ts controller serve` from source —
  no dist build; verified no stale `.js` shadow; concurrency test 5/5 green.
- **Item 2 ✅** — reconcile poison fixed. `granite41-3b-judge-mac-mini` was
  `enabled:true` in DevStorage spec but pointed at the DELETED atomic-fork binary
  + an absent model → `serverStart timed out` every pass (~4 min stall). Disabled
  it; **passes back to ~15 s**. The 41e724c fix holds (enabled:false didn't get
  clobbered). NOTE: later RE-ENABLED + re-pointed during the mac-mini rebuild.

### Embedding gains test (user: "migrate penumbra's model if gains")
- penumbra embeds with **all-MiniLM-L6-v2 (384d)** via fastembed
  (`packages/core/src/embedder/bundled.ts`, `EmbeddingModel.AllMiniLML6V2`,
  schema default `embeddingDim=384`). Remote-embedder path gated on
  `PENUMBRA_EMBEDDINGS_MODEL`.
- Stood up 3 embedders on mac-mini via unified `llama.cpp --embedding` + A/B on
  `packages/eval/corpora/memory-recall/v0/test.jsonl` (105 q, global 343-doc pool):
  | metric | MiniLM-L6 384d | bge-m3 1024d | bge-large-en-v1.5 1024d |
  |---|---|---|---|
  | MRR | **0.742** | 0.708 | 0.682 |
  | hit@1 | **0.686** | 0.610 | 0.591 |
  | nDCG@10 | **0.755** | 0.730 | 0.713 |
  | recall@5/10 | .805/.843 | .807/.841 | .804/.842 |
- **VERDICT: no migration.** Tiny MiniLM beats both 1024d models on rank metrics
  (short English memory snippets = MiniLM's domain). Keep penumbra on MiniLM.
  Eval script: `/tmp/embed_ab2.py` (hits :8098/:8099/:8100). bge-m3 kept as the
  fleet's general/RAG embedder.

### Mac-mini rebuild (user: "use it as free LLM node; rebuild; behind our proxy")
- **Hardware**: Apple M4 (base), 16 GB. Engines present: unified
  `llama.cpp` @ `/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server`
  (embedding-capable) + omlx (from-source venv).
- **Cleaned**: tore down 13–17-day ORPHAN omlx servers (ppid=1, on 8194/95/96/97)
  + the `iso` stress-supervisor (`launchctl bootout`+`disable com.llamactl.fleet-supervisor`;
  it auto-restarted omlx). Disabled all `*-mac-mini` ModelHost specs in DevStorage.
  RAM **39% → 90%**.
- **Serving now** (hand-started nohup via unified llama.cpp; GGUFs rsync'd M4→mini
  to `/Volumes/AI-MODELS/llama.cpp/models/`):
  - `:8086` **granite-3b Q8** alias `granite-mini-3b` (the model penumbra's
    memory-efficacy judge + its agentchat `granite-mini-3b` agent use).
  - `:8098` **bge-m3** embed (1024d).
- Qwen3-8B GGUF rsync'd (`Qwen3-8B-Q4_K_M.gguf`) but NOT yet brought up.

## THE BLOCKER — both routing gaps reduce to ONE keystone
penumbra's `agentchat.yaml` already has a `granite-mini-3b` agent
(`https://192.168.68.76:7843/v1`, via node-agent gateway) marked
"[broken — pending granite41-3b-judge-mac-mini workload restart]".

- **GAP 2 (keystone)**: the mac-mini **node-agent never registers the running
  server**. Controller's spawn logs `starting` but the node-agent never spawns
  (no proc/log/RAM); and a hand-started server isn't adopted —
  `core/src/server.ts:386 detectPortConflict` refuses (`"port … already bound
  (HTTP 200) — stop the foreign process"`) instead of adopting. Result: no
  `llama-server.pid`/state in `/Volumes/AI-DATA/ai-models/local-ai/workloads/
  granite41-3b-judge-mac-mini/` → absent from node-agent `/v1/models`.
  ModelHost ALREADY has adoption (`remote/src/server/modelhost.ts:146,211,364`);
  **ModelRun does not** — mirror it.
- **GAP 1 (proxy cross-node / cache gains)**: `openaiProxy.ts` already has peer
  routing (`listPeers`, `listClusterRoutes`) + the `cache-identity/canonical`
  prefix-cache. `listLocalRoutes` (workloadRuntime.ts:155) only surfaces
  workloads with a LIVE LOCAL pid; remote-node models route via PEER SNAPSHOTS
  (M4 fetches peer `/v1/models`). Because GAP 2 keeps granite out of the
  node-agent's `/v1/models`, there's no peer route → `granite-mini-3b` via
  :7944 falls back to the default endpoint → "upstream unreachable".
  **Fixing GAP 2 likely fixes GAP 1 via the existing peer mechanism.**

### Implementation plan (next session — needs LIVE verification, don't rush)
1. **Adoption in ModelRun** (`core/src/server.ts` startServer / `detectPortConflict`
   caller): if a 200 `/health` server at the endpoint serves the EXPECTED model
   (rel/alias match via `/v1/models` or `/props`), ADOPT — write `llama-server.pid`
   + server state (host/port/rel/aliases) so `listLocalRoutes` surfaces it,
   instead of erroring. Mirror `modelhost.ts` adoption. Add unit test.
2. **Verify M4→mac-mini peer path**: kubeconfig is at `/Users/acordeiro/DevStorage/config`
   (NON-standard shape; my probes hit `UNAUTHORIZED — invalid bearer token`).
   Confirm `listPeers()` returns mac-mini + the M4 Pro fetches its peer snapshot
   (TLS CA + token). CA `/tmp/llamactl-mac-mini-ca.pem` is MISSING (ephemeral) —
   regenerate from the mac-mini node-agent cert (`~/.llamactl-agent/agent.crt`).
3. After 1+2: `granite-mini-3b` should route via :7944 (peer route → mac-mini
   :7843 → :8086) WITH prefix-cache. Verify penumbra reaches it.
4. **Durability**: hand-started servers are nohup orphans (die on reboot). Once
   adoption works, the node-agent/controller manage them; else add launchd plists.
5. Bring up Qwen3-8B on the mac-mini (GGUF already present), same pattern.

## Other open / carried
- Controller still loops a benign port-conflict on `granite41-3b-judge-mac-mini`
  (~every 15s) since it can't adopt the hand-started server. Resolved by item 1.
- Item 3 (omlx orphan-on-stop in `packages/eval/src/matrix/lifecycle.ts`): needs
  process-group teardown (`detached:true` + `process.kill(-pid)`) — diagnosed,
  not done.
- Items 5/6 (atomic-fork refs in 7 eval specs + `templates/workloads/
  gemma4-e4b-vanilla-local.yaml`, AGENTS.md): re-point to unified binary. NOTE:
  system `grep` is `ugrep` — a naive `for f in $(grep -rl …)` mangled the list;
  use explicit file lists or `rg`.
- Items 7/8 (cost-quota false positives; gemma QAT ARC/GSM8K) — untouched.

## RESOLUTION (pm-4 final) — mac-mini is a productive node; penumbra path works

The chain was fixed end-to-end. **The node-agent's native llama-server spawn is
TCC-blocked** (launchd-reparented; can't read /Volumes/AI-MODELS), so the fix was
**server adoption**: hand-start the servers (interactive TCC) and the node-agent
adopts them.

Shipped (committed `cdf582b` + `bc0527c`):
- `tryAdoptExistingServer` in `core/src/server.ts` — adopts an already-bound
  healthy server serving OUR model (rel/basename/--alias), writing pid+state.
- `findListenerPid` port-only fallback — a `--host 0.0.0.0` server binds
  0.0.0.0:<port>, which the loopback `-iTCP@host:port` filter missed.
- Tests: `core/test/server-adoption.test.ts` 8/8 + 27/27 server.test, 0 tsc errors.

Deployed: rebuilt `llamactl-agent` (`bun run build:agent`) → scp to mac-mini →
swap (`.previous` kept) → restart via `start-agent.sh` (nohup; binds :7843 in
~4s, no launchd-hang). Then hand-start each server → controller `serverStart` →
node-agent **adopts** → registers → `unchanged`.

Live productive set (all adopted/registered, route by REL via node-agent :7843):
- granite-3b `:8086` alias granite-mini-3b → `granite-4.1-3b-GGUF/...Q8_0.gguf`
- Qwen3-8B  `:8090` alias qwen3-8b-mini → `Qwen3-8B-GGUF/...Q4_K_M.gguf`
- bge-m3    `:8098` embeddings (1024d)
- ~40-49% RAM free; fleet-supervisor running (journal → fleet snapshot).

penumbra: `granite-mini-3b` agent (agentchat.yaml) un-broken + verified
end-to-end (TLS cert refreshed, token, `model=rel` → "READY"). Cache gain is at
the node-agent's own prefix-caching proxy (:7843), which penumbra targets directly.

Durability: `~/.llamactl-agent/start-workloads.sh` (idempotent bring-up of all 3
+ supervisor) + `REGISTER-WORKLOADS-LOGIN-ITEM.sh`. Servers are nohup (survive
until reboot); **reboot-durability needs the user to run the REGISTER script from
the mac-mini GUI once** (System Events needs UI session; SSH can't).

### Central-proxy peer-routing — BUILT + cache-verified (2026-06-08 pm-5)
The M4 Pro :7944 proxy now routes peer-node (mac-mini) models with cache:
- **Production peer-snapshot poller** (`peer-snapshot-poller.ts`, wired into
  `startAgentServer` via `peerSnapshotPoll`): fetches each peer's
  `/v1/fleet/snapshot` and publishes via `openaiProxy.setPeerSnapshots`. Commits
  `160a4df` (poller+setter), `7a13a32` (retain-on-transient-failure),
  `c6ebe73` (two bugs: relative-vs-`@llamactl/core` module-instance mismatch →
  publish to a singleton the proxy never read; macOS `free_mb` always-low →
  every peer wrongly HIGH pressure → use free+inactive).
- **Link 4 (alias routing)** `7deba69` + node-agent redeploy: `listLocalRoutes`
  surfaces `--alias` as a first-class route. node-agent `/v1/models` lists both
  rel + `granite-mini-3b`. (Same adoption binary rebuilt; deploy = scp+swap+
  start-agent.sh, verified.)
- **Cache effectiveness verified**: prompt/prefix cache ~19× prefill speedup
  (1969ms→~100ms, 898/907 tokens reused) on the peer path; response cache now
  covers peer routes too (`9b3e674`) — identical deterministic request to the
  mac-mini 0.355s→0.011s (~33×). Peer response-cache epoch is synthetic
  (`peer:<node>:<model>`), so a model SWAP under the same peer alias needs a
  manual cache flush.

### Still open (non-blocking)
- **mac-mini embed via :7944 returns 501** — bge-m3 is hand-started without a
  ModelRun spec, so the node-agent can't route `gpustack/bge-m3-GGUF` (falls back
  to granite, no `--embeddings`). Fix = give the embed a spec/alias + adopt it
  (like granite). Reachable directly at :8098 meanwhile.
- **Reboot durability** still needs the one-time GUI step
  (`REGISTER-WORKLOADS-LOGIN-ITEM.sh` from the mac-mini console).
- **Peer response-cache unit test** — behavior verified live + 80 regression
  tests pass; a dedicated peer-epoch unit test would lock it.

## ORIGINAL DEEP DIAGNOSIS (superseded by RESOLUTION above) — the 4 broken links

Implemented + landed the keystone, then found the chain is longer than "adoption":

- **DONE: ModelRun server adoption** — `packages/core/src/server.ts` now adopts an
  already-bound healthy server that serves OUR model (rel / basename / `--alias`
  match) instead of failing `detectPortConflict` as a foreign process. New helpers
  `aliasesFromArgs`, `tryAdoptExistingServer` (injectable deps); wired into
  `startServer`. Test `packages/core/test/server-adoption.test.ts` **8/8 pass**,
  existing server.test 27/27, core typecheck 0 errors. **UNCOMMITTED** on main's
  working tree; the controller runs from source so it's already live (pid churned).

- **BROKEN LINK 1 — controller mis-targets remote ModelRun start.** The granite
  start hits **M4 Pro's :8086**, which is occupied by a LOCAL omlx ModelHost
  (`/Volumes/WorkSSD/src/omlx/.venv/bin/omlx serve`, pid varies) → persistent
  `port 127.0.0.1:8086 already bound (HTTP 200)`. Port 8086 collides between an M4
  Pro omlx workload and the mac-mini granite spec, and the conflict check fires on
  the wrong node. `applyOne` (apply.ts:656) uses `getClient(spec.node)` + a
  `resolveNodeIdentity` port preflight — suspect the remote ModelRun dispatch runs
  startServer locally / aliases mac-mini→local. NEEDS: confirm getClient('mac-mini')
  returns a real remote node-agent client; give granite a port free on BOTH nodes
  (e.g. 8186) OR fix the local-vs-remote dispatch.

- **BROKEN LINK 2 — node-agent doesn't register hand-started servers.** Adoption
  (link fixed in code) must run IN the mac-mini node-agent's startServer, but the
  node-agent is a **compiled binary from May 25** (`~/.local/bin/llamactl-agent`,
  predates adoption + 2 weeks of main). Deploy needs `bun run packages/cli/src/bin.ts
  artifacts build-agent` → push (agent-update or scp). HAZARD: bun-compiled agent
  hangs on launchd respawn (see [[reference_launchd_respawn_bun_compiled_hang]]) —
  use the disable-launchd / scp / nohup-start workaround.

- **BROKEN LINK 3 — /v1/fleet/snapshot is frozen.** Served by the node-agent but
  generated by the iso-supervisor (`--node=mac-mini-iso`) I tore down → frozen at
  18:28:43Z listing the dead `granite-3b-mlx`/`granite-8b-nvfp4`/`qwen3-8b-mlx`.
  The M4 Pro peer-snapshot fetcher (`infra-client.ts:70` polls `/v1/fleet/snapshot`)
  only uses it if `every workload reachable` — so stale+dead = no usable peer route.
  NEEDS: a productive supervisor (`supervisor serve --workload=granite-mini-3b@...8086
  --workload=...8098`) OR node-agent-generated live snapshot.

- **BROKEN LINK 4 — final peer hop.** Even with a fresh peer snapshot, peer routes
  forward to `peer.endpoint` (node-agent :7843), whose openaiProxy routes by model
  from `listLocalRoutes` — so granite must ALSO be registered locally on the node-agent
  (= link 2). Two registrations needed: snapshot (M4→peer) + local route (peer→:8086).

### Current live state (working, hand-managed)
- mac-mini: granite-3b `:8086` (alias granite-mini-3b) + bge-m3 `:8098`, both
  hand-started nohup (ppid=1 — DIE ON REBOOT). Node-agent + memory-cleanup launchd
  intact; iso-supervisor + fleet-supervisor booted out.
- M4 Pro controller (pid churns) loops a benign `port already bound` on granite every
  ~15s (link 1) — left enabled so the spec stays registered for the eventual fix.
- M4→mac-mini auth WORKS: kubeconfig `/Users/acordeiro/DevStorage/config` has the
  mac-mini cert + token `ll_agt_…RRy5P`; `curl -sk https://192.168.68.76:7843/v1/models
  -H "Authorization: Bearer <tok>"` → 200 `{"data":[]}` (empty = nothing registered).

## First moves (next session)
1. `git -C /Volumes/WorkSSD/repos/personal/llamactl log --oneline -1` (cef3bb4 == origin);
   `launchctl list | grep -E 'llamactl|penumbra'`; `mcp__penumbra__handoff_list_pending`.
2. mac-mini health: `ssh macmini.ai 'for p in 8086 8098; do curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$p/health; done'`
   (granite-3b + bge-m3 — may be down if mac-mini rebooted; re-launch via the
   hand-start commands or implement adoption).
3. Implement the GAP-2 adoption keystone (plan above) — this is the unlock for
   "penumbra uses the mac-mini behind our proxy for cache gains."
