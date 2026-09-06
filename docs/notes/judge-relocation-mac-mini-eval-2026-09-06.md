# Judge relocation to mac-mini — evaluation (2026-09-06)

**Verdict: DO NOT PROCEED** with moving the three judge seats to `mac-mini`.
The routing and remote-execution machinery the proposal depends on is real and
already in production — the blocker is purely capacity, and it fails at both
layers of accounting:

- **Reservation arithmetic**: mac-mini's true budget is `16 GiB × 0.75 = 12.0 GiB`.
  It already carries **9.0 GiB** of reservations (granite judge 7 + bge-m3
  embedder 2). Headroom is **3.0 GiB** — not even one of the three 4-GiB judge
  seats fits; all three need 12 GiB, i.e. the node's entire budget.
- **Physical arithmetic**: mac-mini reports `free 136 MB + inactive 6,694 MB
  ≈ 6.7 GiB` of theoretically reclaimable memory, with nonzero swap counters.
  Loading 12 GiB of additional models is physically impossible; even one
  4-GiB seat would push the node deep into swap.
- **The trap**: llamactl's admission *would not stop this*. Budget checks for a
  `spec.node: mac-mini` manifest applied on the control plane are computed from
  the **control plane's** RAM (36 GiB) or bypassed entirely (+∞). The applies
  would succeed cleanly and the node would thrash. See "Admission gap" below.

The single most decisive fact: **mac-mini already hosts a running judge**
(`granite41-3b-judge-mac-mini`, 7 GiB, 64k ctx) plus the fleet's embedding
seat, leaving 3 GiB of headroom — the proposal asks it to absorb 12 GiB.

A cheaper partial alternative exists and is covered under "Recommendation":
the local granite judge's role substantially overlaps the already-running
mac-mini granite seat, so ~4 GiB can be freed on `local` by retargeting
consumers rather than by adding capacity anywhere.

---

## Q1 — mac-mini's actual memory, profile, and budget

**CONFIRMED — 16 GiB, profile `mac-mini-16g`, budget 12.0 GiB.**

Auth mechanism (CONFIRMED, source): the fleet kubeconfig lives at
`$DEV_STORAGE/config` (resolved via `llamactlHome()` → `$DEV_STORAGE` or
`~/.llamactl`; here `/Volumes/WorkSSD/config`). The `mac-mini` node entry
carries an inline `certificate` + `certificateFingerprint` (pinned TLS), and
the context's user (`me`) carries a literal `token` — `resolveToken()` also
supports `tokenRef` via `resolveSecret` (`env:` / `keychain:` / `file:`) for
users that don't inline it.

- `packages/core/src/config/env.ts:22-24` — `llamactlHome`
- `packages/core/src/config/kubeconfig.ts:28-33` — `defaultConfigPath` = `<home>/config`
- `packages/core/src/config/kubeconfig.ts:276-282` — `resolveToken`
- `packages/core/src/config/peers.ts:34-44` — the same user token is what peer
  calls present to remote agents

Authenticated query (CONFIRMED, command output). The kubeconfig token +
pinned cert against `https://192.168.68.76:7843/trpc/nodeFacts` returned:

```json
{"nodeName":"macmini-ai-83.local","profile":"mac-mini-16g",
 "memBytes":17179869184,"os":"darwin","arch":"arm64",
 "gpu":{"kind":"metal","name":"Apple M4"},
 "versions":{"llamactl":"0.0.0","bun":"1.3.14","llamaCppSrcRev":"97f06e9ee…"},
 "startedAt":"2026-08-18T10:09:57.685Z"}
```

`memBytes = 17,179,869,184` = exactly 16 GiB. The `mac-mini-16g` profile name
is not just a hint — it is what the node itself reports.

Budget (CONFIRMED, source): `defaultNodeBudgetGiB` =
`totalmem() / 1024³ × 0.75` when no NodeRun overrides it —
`packages/remote/src/workload/admission.ts:57-60`. On mac-mini that is
`16 × 0.75 = 12.0 GiB`. The node's own agent confirms it directly:
`GET /trpc/nodeBudget {"node":"mac-mini"}` on mac-mini returned
`{"budget":12, …}`.

## Q2 — What is already running/reserved on mac-mini

**CONFIRMED — 9.0 GiB of 12.0 GiB reserved; headroom 3.0 GiB.**

Control-plane manifest store (`/Volumes/WorkSSD/workloads/`, =
`$DEV_STORAGE/workloads` per `packages/remote/src/workload/store.ts:13-17`),
entries with `spec.node: mac-mini` and `enabled: true`:

| Workload | Kind | Reserved | Phase |
|---|---|---|---|
| `granite41-3b-judge-mac-mini` | ModelRun | 7 GiB | Running (:8086, alias `granite-mini-3b`, ctx 65536) |
| `bge-m3-embed-mac-mini` | ModelRun | 2 GiB | Running (:8098, model `bge-m3`) |

Five further mac-mini manifests exist but are `enabled: false` (zero
reservation): `mlx-granite-3b-iso`, `mlx-granite-3b-slot-canary`,
`mlx-granite-8b-iso`, `mlx-qwen3-8b-iso`, `mlx-qwen3-8b-mac-mini`.

Live corroboration (CONFIRMED): `GET https://192.168.68.76:7843/v1/models`
lists `granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf`, `granite-mini-3b`,
`bge-m3`, `bge-m3-GGUF/bge-m3-FP16.gguf`. `GET /v1/fleet/snapshot` returned
both workloads `reachable: true` plus:

```json
"node_mem":{"free_mb":136,"active_mb":6710,"inactive_mb":6694,
            "wired_mb":1351,"compressor_mb":949,
            "swap_in":54716,"swap_out":86240}
```

INFERRED: `swap_in`/`swap_out` are cumulative counters since boot
(`startedAt` 2026-08-18, ~19 days uptime) — the node *has* swapped but the
current swap rate is not knowable from one snapshot. Free+inactive ≈ 6.7 GiB
is the ceiling on what a new workload could physically occupy, before macOS
pressure behavior.

Caveat (CONFIRMED divergence): mac-mini's *own* manifest store disagrees with
the control plane's — its `nodeBudget` reports `reserved: 87` across
enabled-but-Stopped stale manifests (stress-fleet + mlx leftovers). This only
matters for a direct `llamactl --node mac-mini apply`, which writes to the
remote store; control-plane applies use the local store. The two stores are
not synchronized.

## Q3 — Do the three judges fit?

**CONFIRMED: none of them fit under correct accounting — and llamactl would
admit them anyway.**

- Needed: 3 × `expectedMemoryGiB: 4` = **12 GiB** (all three local manifests
  declare 4; verified in `gemma-e4b-judge-local.yaml`,
  `granite41-3b-judge-local.yaml`, `qwen35-4b-judge-local.yaml`).
- Headroom: 12.0 − 9.0 = **3.0 GiB** → zero seats fit. Even a single 4-GiB
  seat exceeds headroom, and `--force` does not bypass the budget
  (`admission.ts:86` — `forceAdmit` short-circuits before the check, but the
  CLI's force flag is a different mechanism; the admission error message
  itself states `--force does not bypass the budget`).
- Best combination: **none**. The only way to free reservation room is to
  evict `bge-m3-embed-mac-mini` (2 GiB) — which breaks the fleet's embedding
  path — and even then headroom is 5 GiB, fitting exactly **one** judge by
  reservation while leaving ~6.7 GiB physical to hold a ~4 GiB process plus
  everything else already resident.

**Admission gap (CONFIRMED, source):** remote-node budget enforcement is
effectively absent today.

- `workloadApply` (router) calls `applyManifest` with only `manifest` +
  `getClient` — `getNodeBudgetGiB` is never wired —
  `packages/remote/src/router.ts:1689-1693`. For ModelRuns, `admitServerBudget`
  then falls back to `Number.POSITIVE_INFINITY` —
  `packages/remote/src/workload/apply.ts:968`. For ModelHosts the fallback is
  `defaultNodeBudgetGiB()` = **the control plane's own** `totalmem × 0.75`
  (36 GiB here) — `apply.ts:401`.
- The reconcile path does wire `getNodeBudgetGiB`, but only from NodeRun
  manifests (`reconciler.ts:107-112,158,271`). CONFIRMED: no `kind: NodeRun`
  manifest exists in `/Volumes/WorkSSD/workloads/`, so every node falls back
  to local `totalmem` — the control-plane `nodeBudget` query even reported
  `budget:36` *for mac-mini* for this reason.

Net: a `llamactl apply` of the three judges with `spec.node: mac-mini` would
mechanically succeed (9 + 12 = 21 < the phantom 36-GiB budget), spawn three
llama-servers on a node with ~6.7 GiB reclaimable, and thrash. This gap is
worth fixing independently of this proposal.

## Q4 — Can llamactl run remote ModelRuns, and can :7944 route to them?

**CONFIRMED: yes to both — this capability is already in production today.**

Remote execution: `spec.node` drives dispatch — `clientForNode(cfg, nodeName)`
returns a pinned-TLS tRPC `NodeClient` for remote nodes, and `applyOne` issues
`client.serverStart.subscribe(...)` on the remote agent
(`packages/remote/src/router.ts:1499-1505, 1678-1693`;
`packages/remote/src/workload/apply.ts` `ConvergeServerContext`/`startCoordinator`).
Proof: `granite41-3b-judge-mac-mini` is `Running` on mac-mini right now via
exactly this path.

Proxy routing: the `:7944` proxy is a dedicated second
`agent serve --port=7944 --no-auth --bind=127.0.0.1` process
(`scripts/launchd/com.llamactl.internal-proxy.plist`). Its route table is **not**
`listLocalRoutes`-only: `listRoutesForProxy` merges local routes with
`listClusterRoutes(localRoutes, productionPeerSnapshots, {peers: listPeers()})`
— `packages/core/src/openaiProxy.ts:122-130`. The peer-snapshot poller (enabled
unconditionally by `agent serve` — `packages/cli/src/commands/agent.ts:546-548`
→ `packages/remote/src/server/serve.ts:660-662`) fetches each peer's
`GET /v1/fleet/snapshot` every 15 s with an 8 s timeout
(`packages/remote/src/server/peer-snapshot-poller.ts:41,100,190`).

Peer forwarding: a peer route targets `${peerEndpoint}/v1/chat/completions`
— i.e. `https://192.168.68.76:7843` — attaching `Authorization: Bearer <token>`
and pinning TLS to the node's `certificate`
(`openaiProxy.ts:246-249, 1959-1962`; `peerTlsForRoute` at :223-226). The remote
agent's own `/v1/*` proxy then routes by model id to its loopback workload
(`serve.ts:454-456` → `handleOpenAIRoute` → `openaiProxy.proxyOpenAI`).

Live proof (CONFIRMED): `curl http://127.0.0.1:7944/v1/models` **today** lists
`granite-mini-3b` and `bge-m3` with `created:0` — the marker `createdAtForRoute`
emits for peer routes (`openaiProxy.ts:110-111`).

Gating caveats (CONFIRMED): a peer route exists only while its snapshot is
fresh — dropped when `now − fetchedAt > 30 s` (`workloadRuntime.ts:71,128`),
when the peer reports HIGH pressure (free+inactive < 768 MB —
`peer-snapshot-poller.ts:40,71-77`; mac-mini is at ~6,830 MB today, clear), or
when a local route advertises the same model id (local wins —
`workloadRuntime.ts:122` seeds `seenModels` with local models and
`appendPeerRoutes` skips collisions).

## Q5 — Latency

**CONFIRMED immaterial.** Measured this session: a full TLS request to
`https://192.168.68.76:7843/health` costs ~15–19 ms end-to-end (TCP ~5–7 ms,
TLS handshake to ~12 ms); loopback to the local agent is ~1 ms. So a remote
judge call adds roughly **+15 ms** over loopback (one round trip plus
amortized TLS; keep-alive connections shave the handshake). Judge calls are
seconds-scale — prefill plus decode on 3–4B models at 8k–32k ctx — so the hop
is on the order of 1% or less per call. The 6.7 ms RTT figure in the brief is
consistent with the measured ~5–7 ms connect time. Not a deciding factor.

## Q6 — Fallback design

**CONFIRMED: no existing mechanism performs "remote primary → local standby"
failover for these workloads. The naive version doesn't work, and the default
failure mode is a loud error only by accident.**

What exists, and why none of it is the answer:

- **Alias duplication is a hijack, not a fallback.** Keeping a same-alias
  standby on `local` does not express "prefer mac-mini, fall back to local":
  `listClusterRoutes` seeds `seenModels` with *local* routes first, so the
  local seat wins every collision while it is alive — all judge traffic stays
  local, defeating the move entirely
  (`packages/core/src/workloadRuntime.ts:121-129`).
- **The no-route path is not failover-aware.** When mac-mini's snapshot goes
  stale (>30 s) the peer route vanishes; a request for `model:
  gemma-e4b-judge` then finds no route and `proxyOpenAI` keeps the default
  target `llamaEndpoint(resolved)` = `LLAMA_CPP_HOST:LLAMA_CPP_PORT` —
  `127.0.0.1:8080` unless overridden (`openaiProxy.ts:627, 1880-1893`;
  `env.ts:163-164`; `server.ts:96-103`). Named failure mode: for the first
  ~30–45 s after mac-mini dies, requests still route at the dead peer and fail
  with upstream errors; after that they hit the default endpoint — a
  connection-refused today (INFERRED: no listener was found on :8080, `lsof`
  returned nothing) — and if anything ever *does* listen on :8080, the call is
  **silently answered by the wrong model**, because llama.cpp does not
  validate the request's `model` field against the loaded weights. Loud today,
  silently-wrong by construction.
- **The MigrationController doesn't cover this.** It exists and is real
  (`packages/fleet-supervisor/src/migration-controller.ts`) but it only
  *evacuates workloads off a HIGH-pressure source node* —
  `evaluateMove` returns `null` unless `snapshot.pressureState === "HIGH"`
  (line 268) — and it needs a fresh snapshot of the source node. A dead or
  partitioned mac-mini produces no snapshot, so its workloads are never
  evaluated. It is also a minutes-scale rebalance (30 s ticks, 5 min health
  timeout, lease-gated — lines 90-96, 269-278), not per-request failover.
- **`llamactl agent heal`** is propose-only by default and has no judge-
  fallback runbook today.

What would need building: the cheap version is a watchdog rule in the
supervisor (or a healer runbook): "if mac-mini's snapshot is stale/absent for
N consecutive ticks, `enable` the three `*-judge-local` manifests (kept on
disk, `enabled: false`); re-disable when the peer returns." All primitives
exist — enable flips a manifest, the 15 s controller reconcile restarts the
seats, and `listLocalRoutes` re-advertises the aliases. Estimate ~100–300 LoC
plus tests. The principled version is an ordered per-model fallback list in
the route layer (peer route preferred, local route on peer-stale/fetch-5xx) —
a moderate change to `listClusterRoutes` ordering plus retry-on-failure in
`proxyOpenAI`.

A fallback that "silently does nothing" is already the default absent any of
this: routes disappear and judge calls error out (or worse, hit :8080). Any
migration should at minimum keep the disabled local manifests and a documented
manual `llamactl enable <name>` path.

## Q7 — Recommendation

**Do not proceed** with moving the three judge seats to mac-mini. The single
most influential fact: **mac-mini's headroom is 3 GiB reserved / ~6.7 GiB
physical against a 12 GiB request** — it cannot absorb even one 4-GiB seat
without evicting workloads it already needs (its own granite judge and the
fleet's `bge-m3` embedder). Capability is not the blocker; the :7944 →
peer-route path is proven in production today.

What can be done instead, in increasing order of effort:

1. **Free ~4 GiB on `local` now by consolidating the granite judge.**
   mac-mini already runs a granite-4.1-3B Q8_0 judge at 64k ctx — a strict
   superset of the local seat's 32k ctx. If the `memory-efficacy` consumers of
   `granite41-3b-judge-local` (model ids `local` and the rel
   `granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf`) can retarget to
   `granite-mini-3b` — already reachable through `:7944` with no new infra —
   then disabling `granite41-3b-judge-local` frees 4 GiB of real RAM plus
   4 GiB of reservation. Collision note: the shared rel id is advertised by
   both seats today and local wins; once the local seat stops, the peer route
   takes over the same id transparently.
   Steps: retarget consumers → verify a real
   `POST :7944/v1/chat/completions {"model":"granite-mini-3b", …}` round-trip
   → `llamactl disable granite41-3b-judge-local`. Keep the manifest on disk,
   disabled, as the manual fallback (`llamactl enable` + one reconcile pass).
   To reverse: re-enable and retarget back.
2. **Shrink the remaining seats' real footprint** (quant step-down, ctx
   reduction — the gemma/qwen seats already run 8k ctx) if the oMLX seat needs
   more than the ~4 GiB step 1 yields. Re-measure actual RSS first: the
   declared `expectedMemoryGiB: 4` is a reservation, and what the oMLX
   watermark needs is real memory, not budget arithmetic.
3. **Only then consider new capacity**: a different destination node, or
   accepting fewer concurrent judge seats.

If a remote move is ever attempted anyway, the prerequisites are: judge GGUFs
present under mac-mini's model root (unverified — CONFIRMED only that the
granite Q8_0 and bge-m3 rels exist there), per-node `binary` paths in each
manifest (the local manifests point at `/Users/acordeiro/DevStorage/…`; the
mac-mini manifest uses `/Volumes/AI-DATA/…`), and awareness that control-plane
admission will not protect the destination (Q3 gap). Reversal is trivial —
re-enable the local manifests — provided they are kept and the fallback
failure mode above is understood.

---

### Evidence index

- `packages/remote/src/workload/admission.ts:57-60` — budget = `totalmem × 0.75`
- `packages/remote/src/workload/apply.ts:401,968` — ModelHost budget falls back
  to *local* `defaultNodeBudgetGiB()`; ModelRun falls back to +∞
- `packages/remote/src/workload/reconciler.ts:107-112,158,271` — NodeRun-only
  budget overrides; none exist on disk
- `packages/remote/src/router.ts:1622-1660,1689-1693` — `nodeBudget` query;
  `workloadApply` without `getNodeBudgetGiB`
- `packages/core/src/openaiProxy.ts:122-130,223-226,627,1880-1893,1959-1962` —
  cluster routes, peer TLS/token, default-endpoint fallback, peer forward auth
- `packages/core/src/workloadRuntime.ts:71,115-133` — `listClusterRoutes`:
  local-wins, 30 s staleness, HIGH-pressure drop
- `packages/remote/src/server/peer-snapshot-poller.ts:40-41,71-77,100,189-265` —
  15 s poll, 8 s fetch timeout, <768 MB available → HIGH
- `packages/remote/src/server/serve.ts:443-456` — agent mounts `/v1/fleet/snapshot`
  + `/v1/*` proxy
- `packages/cli/src/commands/agent.ts:546-548` — `peerSnapshotPoll: true` always
- `packages/cli/src/dispatcher.ts` — `--node` → NodeClient; `--node all` fan-out
- `packages/fleet-supervisor/src/migration-controller.ts:259-298` — HIGH-pressure
  -only evacuation, lease-gated
- `packages/core/src/config/peers.ts:46-88` — peers from kubeconfig nodes,
  shared context token
- `packages/core/src/config/kubeconfig.ts:28-33,276-282` — config path, token
  resolution
- `scripts/launchd/com.llamactl.internal-proxy.plist` — `:7944` = `agent serve
  --no-auth`
- Live queries (this session, read-only): `/trpc/nodeFacts`, `/trpc/nodeBudget`,
  `/v1/models`, `/v1/fleet/snapshot` on `https://192.168.68.76:7843`;
  `/trpc/nodeBudget` on `https://127.0.0.1:7843` (local 36/36 confirmed);
  `http://127.0.0.1:7944/v1/models` (peer routes live); TLS timing to mac-mini.
- Manifests: `/Volumes/WorkSSD/workloads/{gemma-e4b,granite41-3b,qwen35-4b}-judge-local.yaml`,
  `granite41-3b-judge-mac-mini.yaml`, `bge-m3-embed-mac-mini.yaml`.
