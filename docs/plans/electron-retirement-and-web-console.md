# llamactl #410: retire Electron for a focused Bun-served web console (phased plan)

- Issue: frozename/llamactl#410, "Retire the Electron dashboard or replace it with a focused Bun-served web console" (OPEN)
- llamactl base: `origin/main` @ `f71ec4dd`. The previous draft used `634d3867`; the two commits since (#416, #418) touch only `packages/core/src/engines/state.ts`, its test and a `packages/train` test, none of which this plan cites.
- Penumbra reference: `origin/main` @ `e20d31a70`. The issue reviewed `9933b56eb`; the files cited below are the same paths at the newer tip.
- Plan status: P1 to P6 are authorized by the issue. **P6 is a hard stop for an operator decision.** P7 runs only after that decision is recorded on the issue.
- Toolchain: `BUN=/Volumes/AI-DATA/maestro/bench/m4pro-qualification-20261029/engines/bun-1.4.3/bun` (CI pins Bun 1.4.3 too). Each focused check below runs in one package. The controller runs broad gates (repo typecheck, lint, every package's tests) serially before landing. Fleet workers do not.

**Revision notes (this draft).** Allowlisted responses are now projected and redacted on the server (§0.11, P2b). The console mount fails closed from its first PR, and no mutation is exposed until P5a (§0.6, P2b). Node selection now has a single tab-scoped model that streams and the stop action actually exercise (§0.13, P3, P5a). The allowlist is tested against tRPC batching (§0.12). P2 and P5 are each split in two. P7-A gains a measured-reduction step. The P7 file lists are complete. §0.2 is corrected. The P1 import guard catches type-only imports. Cookies are scoped by port. The node selector is restricted to dispatchable nodes. The stop action covers multi-node ModelRuns and `stopped:false`.

---

## 0. Substrate facts checked for this plan (origin/main)

These were checked directly. They correct or sharpen the inventory where noted.

1. **The renderer fails at import time without Electron.** `packages/app/src/lib/trpc.ts` calls `trpc.createClient({ links: [ipcLink()] })` at module scope. `ipcLink()` runs `new IPCClient()` immediately (`ipc-link.ts`), and its `getBridge()` throws when `globalThis.electronTRPC` is missing. Any web build that imports `@/lib/trpc` therefore crashes on load. 58 files under `packages/app/src` import it.
2. **The `electronTRPC` stub is not a global preload.** `packages/app` has no `bunfig.toml` (only `packages/cli` and `packages/remote` have one). Individual tests import `test/setup.ts` themselves (`test/dispatcher.test.ts`, `test/use-ops-session.test.ts`, `test/modules/pipelines/use-pipelines.test.ts`), and it sets `globalThis.electronTRPC`. `bun test` runs every file in one process, so whether the stub exists when a given file runs depends on file order, and a module may already be cached. Boundary tests that need "no Electron" must therefore run in a **fresh subprocess** (P1 RED 1). Deleting the global in-process is not enough.
3. **The router types come from Electron.** `src/lib/trpc.ts` imports `AppRouter, UIRouter` from `../../electron/trpc/router`, and line 4 is a type import. `AppRouter` is only a re-export of `@llamactl/remote`. `UIRouter` is the dispatcher's UI sub-router, which holds `uiCrossNodeOpsSessionSearch`, `uiCrossNodeLogsSearch`, `uiSetActiveNode`, `uiGetActiveNode`, `uiPickDirectory` and `uiScanGitRepos`. `packages/app/tsconfig.web.json` explicitly includes `electron/trpc/{router,dispatcher,cross-node-fan-out,node-pinned-fetch}.ts`, so the renderer typecheck compiles Electron-side code today.
4. **No transformer is in use.** `router.ts:603` notes that superjson is not used, so an HTTP link needs no transformer config.
5. **Today's active node is not a real per-window selection.** The only caller of `uiSetActiveNode` is `shell/node-selection.ts:35`. It resets a stale persisted selection to `"local"` once at startup. There is no live node picker. In practice, non-control-plane calls go to `kubeconfig.defaultNode`, unless a stale selection existed at startup, in which case they go to `local` for the whole session. The console therefore _introduces_ explicit node selection. It does not port an existing picker.
6. **The dispatcher fails open.** `resolveDispatchTarget` (`dispatcher.ts:543-570`) returns `{kind:"local"}` when the kubeconfig is unreadable, the context or node is missing, the user is missing, or `resolveToken` throws. In a web console, that would silently run a node-routed call (including a mutation) on the control plane when the operator asked for another node. **The console mount uses fail-closed resolution from its first PR (P2b).** Electron keeps the fail-open mode until P7.
7. **The `CONTROL_PLANE_ONLY` set** (`dispatcher.ts:164-247`) matches the inventory: node CRUD and test (`nodeList`, `nodeTest`), `nodeModels`, `chatComplete`/`chatStream`, all `workload*` (`workloadList`, `workloadsDir`, `workloadDescribe`), all `reconciler*`, all `benchSchedule*`/`benchScheduler*`, Ops Chat, all `project*`, cost, and the `ui*` procedures. `env`, `nodeFacts`, `serverStatus`, `serverLogs` and `serverStop` are node-routed.
8. **Server-side building blocks already exist in `@llamactl/remote`.** `buildPinnedLinks` and the Bun-native `makePinnedFetch` are in `client/links.ts`, and `serve.ts` already mounts the router with `fetchRequestHandler` behind bearer auth. Electron uses the undici `makeNodePinnedFetch` only because Electron main runs on Node. The Bun console does not need undici.
9. **Playwright is not a dependency** anywhere in llamactl today. Adding it counts against the P6 footprint metric.
10. **CI:** `check.yml` runs on a macOS + Ubuntu matrix and has a "Test packages/app" step (`bun test` in `llamactl/packages/app`). `cross-repo-smoke.yml` has a "Run llamactl tier (packages/app)" step. The root `typecheck` script runs `bun run --cwd packages/app typecheck`, and `typecheck:strict` runs `tsc -p tsconfig.eslint.json`, which includes `packages/app/electron/**/*.ts` and `packages/app/electron.vite.config.ts`. `eslint.config.mjs` has `appRendererFiles` (`packages/app/src/**`) and a Node-globals block for `packages/app/electron/**/*.ts`, `electron.vite.config.ts` and `vite.config.ts` (lines 228-239). Three workflows (`ui-audit`, `ui-tier-a`, `ui-flows-nightly`) check out `frozename/electron-mcp`. `scripts/audit.sh`, `scripts/smoke-tier-a.sh`, `scripts/smoke-ui-flows.sh`, `docs/ui-audit.md` and `tests/ui-flows/**` also reference it. `scripts/check-ui-audit-functional-report.ts` belongs to the same audit chain. #369 ("Make the macOS screenshot audit reproducible…") is OPEN.
11. **Allowlisted procedures return credentials in their bodies.** `env` (`router.ts:1111`) returns `resolveEnv()`. With `provider=lmstudio`, `LOCAL_AI_API_KEY` and `OPENAI_API_KEY` are set to `LM_API_TOKEN` (`core/src/env.ts:212-216, 380-384`). `nodeList` (`router.ts:1123`) spreads raw `ClusterNode` objects: a RAG binding's `endpoint` (`schema.ts:198`, for example a pgvector `postgres://user:pass@…` URL) can carry an inline password, and `cli[].env` values (`schema.ts:111`) may be literal secrets. `workloadDescribe` (`router.ts:1830`) returns the whole manifest, including free-form `extraArgs` (`workload/schema.ts:39,47`, for example `--api-key <secret>`), plus a live status. A cookie-and-origin guard alone does not keep these out of the DOM or HAR captures. **Every allowlisted response must be projected on the server (P2b).**
12. **tRPC batches by comma.** `httpBatchLink` sends `/api/trpc/serverStatus,keepAliveStart?batch=1`, and `fetchRequestHandler` runs every comma-separated path. An allowlist that matches a prefix or the first segment lets a non-allowlisted procedure through. One that compares the whole string rejects every legitimate batch. The guard must URL-decode the path, split it on `,`, and check every segment (P2b).
13. **`nodeList` returns non-dispatchable nodes.** Alongside persisted agent nodes, it returns gateway and RAG nodes and synthesized `<gateway>.<provider>` provider nodes (`effectiveKind: "provider"`, not in `cluster.nodes`). None of these is a valid dispatch target for `serverStatus`/`serverLogs`/`serverStop`. `nodeList` also returns `defaultNode`, which is what the CLI targets.
14. **`serverStop` stops only one process and can refuse.** `serverStop` (`router.ts:2460`) calls `stopServer({ key: { name } })` on the node it is dispatched to. It does not stop a ModelRun's `spec.workers` rpc-servers. `stopWorkloadForDelete` (`router.ts:365-395`) shows the full sequence: coordinator `serverStop`, then `rpcServerStop` per worker in reverse. `stopServer` (`core/src/server.ts:1459-1517`) returns `{stopped:false}` when it cannot verify the recorded PID's identity, sometimes after SIGTERM has already been sent. That result is not a success.

---

## 1. Module inventory (all 22 registry entries)

Key: **keep** = in the prototype (trimmed). **defer** = not ported now; revisit after P6. **retire** = intentional UI loss, with CLI/MCP as the replacement.

| Module                   | Rec.                                                            | CLI / MCP alternative                                                                                                                                                                                                                                              | UI-only losses if not ported                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dashboard`              | **keep** (trimmed)                                              | `node ls`, `get workloads`, `expose`/`apply -f`, `catalog list`, `env`, `bench compare`, `catalog promotions`, `server status`; MCP `node.ls`, `fleet.snapshot`, `workload.list/apply`, `catalog.list`, `env`, `bench.compare`, `promotions.list`, `server.status` | Topology map (no CLI equivalent), the single at-a-glance page (~5 CLI calls), clickable endpoints, rel autocomplete. The prototype keeps only the legacy NodeMap, the env/active-model cards (redacted, for the tab's node) and the exposed-workloads list. It drops the themed map variants and `NodeMapPreviews`, and leaves bench, promotions and the unconfirmed Expose form out of the first cut. |
| `chat`                   | defer                                                           | `rag ask` (single-shot RAG), MCP `rag.search`, `server start`, `catalog list`. No generic chat in CLI or MCP.                                                                                                                                                      | Streaming multi-turn chat, A/B compare, per-turn RAG with provenance, capability tags, `nodeModels` dropdown (no CLI/MCP), local history                                                                                                                                                                                                                                                               |
| `ops-chat`               | defer                                                           | MCP `operator.plan` + 13 catalog tools with dryRun/audit; `plan run` (plan only); audit JSONL by hand                                                                                                                                                              | Iterative re-plan loop, safety-tier confirm UX, audit-tail panel, planner-on-fleet-node. Its type-the-name confirm is the reference for P5a's action.                                                                                                                                                                                                                                                  |
| `ops-sessions`           | defer (follows ops-chat)                                        | none (manual journal dir)                                                                                                                                                                                                                                          | Session browsing, guarded delete that refuses in-flight sessions. Retire together with ops-chat; optionally add `ops sessions list\|rm` first.                                                                                                                                                                                                                                                         |
| `plan`                   | retire                                                          | `plan run`, MCP `operator.plan` (with `history`)                                                                                                                                                                                                                   | Conversational refine; picking the executor by fleet node with server-side creds (gap fix: `--node`/`nodeId` reusing `resolvePlannerProvider`)                                                                                                                                                                                                                                                         |
| `projects`               | retire                                                          | `project list/get/route/add/apply/index/rm`; MCP `project.*`                                                                                                                                                                                                       | Live routing-journal view (gap fix: `project journal [--follow]`), heatmap, native folder picker, git-repo chips, rag-node dropdown                                                                                                                                                                                                                                                                    |
| `knowledge.retrieval`    | defer                                                           | MCP `rag.search/store/listCollections/pipeline.*/bench`; CLI `rag pipeline *`, `rag bench`, `rag ask`, `node add-rag`                                                                                                                                              | Collection browsing, ad-hoc paste-and-store (MCP only), in-place embedder rebind, merged running/orphan pipeline view                                                                                                                                                                                                                                                                                  |
| `knowledge.pipelines`    | retire                                                          | Exported stubs keep running as MCP `llamactl.pipeline.<slug>`                                                                                                                                                                                                      | Visual stage editor, streamed per-stage runs, one-click export. Unexported drafts in localStorage are lost: warn operators before P7.                                                                                                                                                                                                                                                                  |
| `workloads` (group leaf) | **keep** (same list component as below)                         | `get workloads`, `describe workload`, `apply -f`, `delete workload [--keep-running]`, `controller serve [--once]`; MCP `workload.list/apply/delete`, `reconciler.kick`                                                                                             | Template generator, validate-then-apply, reconciler status, in-process Start/Stop (should not move into a long-lived server)                                                                                                                                                                                                                                                                           |
| `workloads.model-runs`   | **keep** (list + Describe, scoped to the tab's node; read-only) | as above                                                                                                                                                                                                                                                           | as above. The Apply/Template/Validate editor and reconciler Start/Stop are deferred or dropped.                                                                                                                                                                                                                                                                                                        |
| `workloads.composites`   | defer                                                           | `composite apply/destroy/list/get/status`; MCP `composite.*` (no streaming status)                                                                                                                                                                                 | Dry-run-gated editor, component tree, typed-name destroy, deep links. Must first decide whether composites are control-plane-scoped or node-scoped (they currently follow the active node).                                                                                                                                                                                                            |
| `models.catalog`         | defer                                                           | `catalog list/status`, `uninstall [--force]`; MCP `catalog.list` (no uninstall)                                                                                                                                                                                    | One view of all rows with an installed flag, inline uninstall confirm. Gap: MCP uninstall.                                                                                                                                                                                                                                                                                                             |
| `models.presets`         | retire                                                          | `catalog promote/promotions`, `bench compare`; MCP `catalog.promote/promoteDelete`, `promotions.list`                                                                                                                                                              | Joined matrix, client filters, one-click promote. Gap fix: `catalog unpromote`.                                                                                                                                                                                                                                                                                                                        |
| `models.pulls`           | retire                                                          | `pull file\|candidate`, `candidate test` (more options than the UI); no MCP                                                                                                                                                                                        | Concurrent per-card pulls with logs and cancel                                                                                                                                                                                                                                                                                                                                                         |
| `models.bench`           | defer (**blocks P7**)                                           | `bench preset\|vision\|history\|show\|compare`; MCP `bench.history/compare`                                                                                                                                                                                        | **The bench scheduler is a real capability loss.** Schedule CRUD and the loop start/stop/kick/status exist only in the UI, and the loop lives in Electron main's memory. P7 needs a disposition first.                                                                                                                                                                                                 |
| `models.lmstudio`        | retire                                                          | `lmstudio scan`, `lmstudio import [--apply] [--no-link]`                                                                                                                                                                                                           | Formatted plan table, auto-refresh                                                                                                                                                                                                                                                                                                                                                                     |
| `models.server`          | retire (salvage parts)                                          | `server status/start/stop/logs`, `keep-alive *`; MCP `server.status/stop`                                                                                                                                                                                          | Live status cards, start form. **Salvaged into P5a:** `ServerStatusCards` rendering and `serverStop` as the confirmed action.                                                                                                                                                                                                                                                                          |
| `nodes`                  | **keep** (read path)                                            | `node ls/test/rm/add/add-cloud`; MCP `node.ls/remove/add`                                                                                                                                                                                                          | Live reachability dots, mDNS discover (no CLI/MCP), OpenAI-config reveal (sends a raw token to the browser, so not ported), register forms (retired)                                                                                                                                                                                                                                                   |
| `logs`                   | **keep** (tab node)                                             | `server logs [-f] [--lines] [--node]`; MCP: none                                                                                                                                                                                                                   | Always-on pane, bounded scrollback, connection state. Gap: MCP `server.logs`.                                                                                                                                                                                                                                                                                                                          |
| `cost`                   | defer                                                           | MCP `cost.snapshot`; `cost-guardian tick --skip-journal` (acts, not a pure read); journal file                                                                                                                                                                     | Gauges and tier badge, read-only status, journal tail. Gaps: `cost-guardian status/journal`.                                                                                                                                                                                                                                                                                                           |
| `settings`               | retire                                                          | `env --json`, MCP `env`; `catalog promote/promotions`; MCP `promoteDelete`                                                                                                                                                                                         | Grouped env table, project scan roots (only useful if projects is kept), CLI unpromote gap                                                                                                                                                                                                                                                                                                             |
| `ui-primitives`          | retire                                                          | not applicable (dev sandbox)                                                                                                                                                                                                                                       | Nothing for operators. Update `search-view.test.ts` alias case and the smoke-affordance list.                                                                                                                                                                                                                                                                                                          |

**Prototype allowlist (deny-by-default, enforced by the console server).**

- **From P2b, queries and one subscription only:** `nodeList`, `nodeTest`, `env`, `nodeFacts`, `serverStatus`, `workloadList`, `workloadDescribe`, `workloadsDir`, and the read-only subscription `serverLogs`.
- **From P5a, one mutation:** `serverStop`. It is added in the same PR as its confirm dialog and its server-side precheck, so no build of `main` exposes a mutation without both.
- Everything else returns `404 procedure_not_exposed`. That includes `keepAliveStart` (privileged detached spawn), every `pull*`/`bench*Run` (side-effecting subscriptions sent over GET), `nodeOpenAIConfig` (raw token), `reconciler*` (in-process loop) and every `ui*`.
- Each entry also declares a **server-side response projection** (§0.11, P2b). Nothing reaches the browser unprojected.

**Node model (one model, used everywhere).** Each tab has exactly one node, the _tab node_. Every node-routed call the tab makes goes to `/api/n/<tabNode>/trpc`, which covers `env`, `nodeFacts`, `serverStatus`, `serverLogs` and `serverStop`. The Workloads and Logs views show only workloads whose `spec.node` equals the tab node, and the stop action is offered only for those workloads. The server re-checks that before it forwards a stop. The Fleet and Nodes views list every node, because `nodeList`/`nodeTest` are control-plane reads, and they offer "open in a new tab on <node>". There is no `clientForNode(workload.node)` side channel. A workload on another node is reached by switching the tab node.

**The one confirmed lifecycle action is `serverStop {workload, graceSeconds: 5}` on the tab node.** It is offered only for a `ModelRun` whose `spec.node` is the tab node and whose `spec.workers` is empty. Reasons:

- It is reversible (`llamactl server start`).
- MCP already exposes it with dryRun and audit.
- It is node-routed (not control-plane-only), so it is the mutation that actually proves tab-scoped targeting.

Multi-node ModelRuns, whose workers' rpc-servers `serverStop` would leave running (§0.14), and ModelHost workloads are out of scope for the prototype. The dialog explains why and points to `llamactl delete workload` / `llamactl server stop`.

Other candidates and why they lost:

- `workloadDelete` is control-plane-only, so it proves less routing, and it is less reversible.
- `nodeRemove` is destructive to kubeconfig.
- Composite destroy and pulls are too heavy.

If the operator prefers `workloadDelete` at P5a kickoff, swap the allowlist entry, the precheck and the lifecycle spec. Nothing else changes.

---

## 2. Penumbra → llamactl mapping

| Area                           | Penumbra source                                                                                                               | Disposition                             | What llamactl does and why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console launcher               | `packages/cli/src/commands/console.ts` (`prepareConsoleServer`, `runConsole`, `openBrowser`, `resolveDistPath`)               | **Adapted**                             | `llamactl console [--port] [--no-open] [--dist]` in `packages/cli/src/commands/console.ts`, a thin wrapper over a server module in `@llamactl/remote`. **Reused:** loopback-only bind (`127.0.0.1`), random 32-byte session nonce per start, dist resolution order (flag → `LLAMACTL_CONSOLE_DIST` → repo checkout), open-browser fallback message, SIGINT/SIGTERM stop, `_testReturnImmediately`-style test hook. **Key difference:** Penumbra is a separate launcher that reverse-proxies `/api` to a daemon with a server-held bearer. llamactl has no control-plane daemon to proxy to, so the console process **hosts the dispatch router in-process** through `fetchRequestHandler`, the same way Electron main does today. The daemon token file read, refresh and retry-on-401 logic is **omitted** (there is no upstream daemon).                                                                                                                                                                                                                                                                                                        |
| Same-origin API guard          | `handleApiRequest`, `buildServeOptions`, `strictIndexCsp`, `SECURITY_HEADERS`, `safeJoin`, `filterUpstreamHeaders`            | **Reused + hardened**                   | **Reused:** HttpOnly `SameSite=Strict` `Path=/` session cookie set only on `index.html`; `Sec-Fetch-Site: same-origin` + exact `Origin` check on mutating methods; `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`; CSP `connect-src 'self'`; `safeJoin` traversal guard; SPA fallback; `req.signal` passed to the handler. **Added for llamactl:** (a) a **Host allowlist** (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`) against DNS rebinding, because Penumbra's origin check compares against `url.host`, which a rebinding attacker controls; (b) `Sec-Fetch-Site: same-origin` required on **every** `/api` request, because tRPC subscriptions (`serverStart`, `pullFile`) are side-effecting GETs; (c) the deny-by-default **procedure allowlist**, checked per batch segment; (d) a **per-procedure response projection** that redacts credentials; (e) a **port-scoped cookie name** (`llamactl_console_<port>`), because browsers do not isolate cookies by port; (f) inbound `Authorization`/`Cookie` never reach procedures, and fleet tokens are resolved per request from kubeconfig on the server. |
| Browser config / auth boundary | `src/api/config.ts` (`loadPenumbraConfig`)                                                                                    | **Reused (prod) / omitted (dev token)** | Production: `baseUrl = "/api"`, no token, cookie only. **Dev:** no token is injected into the browser bundle. Penumbra's dev path is omitted on purpose. Vite `server.proxy` sends `/api` to a running `llamactl console --no-open`, so dev and prod use the same auth model and kubeconfig tokens never enter a Vite env.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| API transport                  | `src/api/transport.ts` (`DaemonTransport`, zod validation, `DaemonHttpError`/`DaemonContractError`)                           | **Adapted (patterns only)**             | llamactl keeps **tRPC v11** (`httpBatchLink` + `httpSubscriptionLink`) and its existing router types. No REST or contract migration, as the issue says. Borrowed: error classification into network (status 0), invalid session (401 → banner), forbidden (403 → bug), `procedure_not_exposed`/`unknown_node`/`node_not_dispatchable` (terminal), workload refusals (409, inline) and procedure errors (inline), plus `credentials: "include"`. Zod response validation is omitted because tRPC types are end-to-end. The projected output types are declared in `allowlist.ts`, so the browser is typed against what it actually receives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Streams                        | `src/api/streams.ts` (+ `event-source-shim.ts`)                                                                               | **Adapted**                             | Borrowed: backoff `[1,2,4,8,16,30]s`; `HEALTH_CONFIRM_MS = 2000` before resetting backoff (accept-then-die loops); synthetic `__reconnect__` message so consumers reset their buffers; bounded ring (Logs keeps its existing 2000 lines); full teardown on unsubscribe; a fetch-based EventSource so HTTP status is visible. llamactl already depends on `eventsource@4.1.0`, which accepts a `fetch` override. Omitted: Penumbra's topic registry and 30 s linger/refcount sharing. The prototype has one stream type (`serverLogs`), so sharing adds nothing yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Shell / navigation             | `src/shell/Shell.tsx` (Titlebar, Rail, Explorer, Statusbar, `ConfirmDialogProvider`, `ToastProvider`, `SessionInvalidBanner`) | **Adapted**                             | The composition pattern is reused in a new `ConsoleShell` built from **llamactl's own `@/ui` primitives**: titlebar with tab node selector and stream state, rail, surface, statusbar, confirm and toast providers, invalid-session banner. Explorer is **omitted** because four modules need no tree. No components are copied across repos, and there is no shared package (the issue rules this out).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Module manifest / router       | `src/modules/manifest.ts`, `src/router.tsx`                                                                                   | **Adapted**                             | A static `console-manifest.ts` (`{id, path, label, icon, available}`) with four entries: fleet, workloads, nodes, logs. Deep links `/fleet`, `/workloads/:name?node=`, `/nodes/:name`, `/logs?workload=&node=`. **react-router-dom is omitted** to keep the dependency footprint small: a ~60-line `history`/`URLSearchParams` router is enough for four routes. llamactl already uses `history.replaceState` for composites. Add react-router-dom only if P5a shows the small router is not enough.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Visual tokens                  | `src/themes/tokens.css`                                                                                                       | **Adapted**                             | One llamactl theme in the console build, with tokens aligned to Penumbra's operator palette and density for consistency. The four theme families and `mapVariant` switching are **omitted** (visual-only maintenance surface).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Test harness                   | `playwright.config.ts`, `e2e/harness/{server,router,fixtures}`, `parity.spec.ts`, Storybook                                   | **Adapted / partly omitted**            | **Reused:** Playwright, chromium only, `workers: 1`, `fullyParallel: false`, `forbidOnly` on CI, `trace: retain-on-failure`, a fixture backend that records calls. **Changed:** `retries: 0`. The #369 lesson is that "passes on rerun" hides nondeterminism. The fixture backend plugs in _under_ the real console server's guards, allowlist, projections and stop precheck, so the specs exercise that layer. **Omitted:** pixel or visual parity snapshots (the #369 failure class), Storybook, and the visual config. These can be added later if operators ask.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## 3. Phases

General rules for every phase:

- One PR per phase. P2 and P5 are split into **a/b** PRs, each landed separately.
- Write the RED tests first, commit them failing, then make them GREEN.
- No phase deletes Electron code before P7. Electron keeps working through P1 to P6. The existing `packages/app` tests stay green as the parity guard: `test/dispatcher.test.ts`, `test/electron/trpc/{cross-node-fan-out,dispatcher-cross-node,node-pinned-fetch}.test.ts` and `test/electron/ipc-origin-guard.test.ts`.
- Order: P1 → P2a → P2b → P3 → P4 → P5a → P5b → P6 (stop) → P7-A or P7-B.

### P1: Transport-neutral client boundary

**Goal:** no file reachable from the web entry references `electronTRPC`, `ipc-link`, `electron-trpc` or `electron/**`, including through type-only imports. Electron keeps using IPC.

**Files**

- `packages/app/src/lib/trpc.ts`: no links at module scope. It exports the `trpc` React instance and `createAppClient(links)`. `AppRouter` is a type-only import from `@llamactl/remote`. The `../../electron/trpc/router` import (including the `import type` on line 4) is removed.
- `packages/app/src/lib/transport/http.ts` (new): `buildHttpLinks({ baseUrl })` = `splitLink(subscription → httpSubscriptionLink, else → httpBatchLink)`, `credentials: "include"`, no Authorization header.
- `packages/app/src/lib/transport/ipc.ts` (new; it now holds `ipc-link.ts`, moved): imported only by the Electron entry.
- `packages/app/src/lib/ui-client.ts` (new): a hand-written `UIClient` interface listing only the methods the renderer calls, with no import from `electron/**`, plus `getUIClient(): UIClient | null` (`null` on web).
- `packages/app/src/lib/ui-client.electron.ts` (new, imported only by `main.tsx`): builds the real client from `UIRouter` and registers it. A compile-time `satisfies UIClient` check keeps the interface honest. P7 deletes this file.
- `packages/app/src/main.tsx` (Electron entry: injects IPC links and the UI client) and `packages/app/src/main.web.tsx` + `src/index.web.html` (new web entry: injects HTTP links, mounts the existing App for now).
- `packages/app/src/shell/node-selection.ts`, `shell/beacon/search-view.tsx`, `modules/projects/{components.tsx,hooks.ts}`: go through `getUIClient()`. On web they degrade gracefully: no startup reset, search across nodes disabled, projects picker hidden.
- `packages/app/tsconfig.console.json` (new): `"files": ["src/main.web.tsx"]`, the same compiler options as `tsconfig.web.json`, and **no** `electron/**` includes. It is added to the package `typecheck` script. `tsconfig.web.json` keeps its `electron/trpc/*` includes for the Electron renderer until P7.
- `packages/app/vite.web.config.ts` (new): build to `dist-web/`, alias `@`. Script `build:web`.
- Tests: `packages/app/test/lib/transport/http-links.test.ts`, `packages/app/test/web-entry-boundary.test.ts`.

**RED cases**

1. Fresh process, no stub: `Bun.spawn([process.execPath, "-e", 'await import("./src/lib/trpc.ts")'], { cwd: <packages/app>, env: <env without anything that sets electronTRPC> })` exits 0, and its stderr does not mention `electronTRPC` or `getBridge`. Today it throws from `getBridge()` (§0.1). The subprocess avoids the order-dependent in-process stub (§0.2).
2. Import-graph guard, in three layers:
   - (a) Runtime graph: walking static imports from `src/main.web.tsx` with `Bun.Transpiler#scanImports` reaches no specifier matching `ipc-link|transport/ipc|ui-client\.electron|electron-trpc|^electron$|/electron/`.
   - (b) Text check, which catches type-only imports that `scanImports` drops: no file reached in (a) contains `from ["'][^"']*(electron/|electron-trpc|ipc-link)` or `import type` of such a specifier, and none contains the identifier `electronTRPC`.
   - (c) Type graph: `tsc -p tsconfig.console.json --listFilesOnly` lists no path under `packages/app/electron/` and none under `node_modules/electron-trpc`.
3. `buildHttpLinks({ baseUrl: "/api" })`: a subscription op goes to the SSE link at `/api/trpc`; queries and mutations go to the batch link; the fetch is called with `credentials: "include"` and **no** `authorization` header.
4. `getUIClient()` returns `null` when no Electron client was registered; `useSyncActiveNode` makes no call on web.
5. Existing Electron tests are unchanged and still green (regression guard, not new).

**GREEN:** move link construction behind the two entries, inject links through a `TrpcProvider` prop, make the UI client an optional capability behind the hand-written interface, and add the console tsconfig and web Vite config.

**Focused check (packages/app):**
`cd packages/app && $BUN test test/lib/transport test/web-entry-boundary.test.ts test/renderer-no-bun.test.ts test/dispatcher.test.ts && $BUN run typecheck && $BUN x vite build -c vite.web.config.ts && ! grep -rl electronTRPC dist-web`

**Risks:** the merged-router type portability problem noted in `trpc.ts` comes back if `UIRouter` is merged into `AppRouter`; keep it separate. The hand-written `UIClient` interface can drift from `UIRouter`; the `satisfies` check in `ui-client.electron.ts` makes drift a type error. The Electron dev path (`electron-vite dev`) is not covered by CI, so do one manual smoke on the PR. `vite build` also compiles every lazily registered module; the web registry pruning lands in P5a, so the web bundle is large until then.

### P2a: Extract the dispatcher into `@llamactl/remote` (Electron behaviour unchanged)

**Goal:** a single dispatch implementation in `@llamactl/remote` with an explicit resolution mode. Electron uses it in `"local"` (today's fail-open) mode and behaves exactly as before. Nothing new is served.

**Files**

- `packages/remote/src/dispatch/router.ts` (new): extracted from `packages/app/electron/trpc/dispatcher.ts`. Contains:
  - `CONTROL_PLANE_ONLY`
  - `resolveDispatchTarget(path, nodeName, { onUnresolvable: "local" | "error" })`. In `"error"` mode it throws a `DispatchResolutionError` with code `kubeconfig_unreadable | no_current_context | unknown_node | node_not_dispatchable | user_missing | node_credentials_unavailable` instead of returning `{kind:"local"}`. Control-plane-only paths are local in both modes.
  - `wrapQueryOrMutation`, `wrapSubscription`, `runLocalSubscription`/`runRemoteSubscription`, the client cache
  - `buildDispatchRouter({ fetchFactory, nodeFromCtx, onUnresolvable })`, which uses `initTRPC.context<{ node: string | null }>().create({ sse: { ping: { enabled: true, intervalMs: 10_000 } } })`
- `packages/remote/src/index.ts`: exports.
- `packages/app/electron/trpc/dispatcher.ts`: becomes a thin adapter. It keeps the module-global override (`nodeFromCtx = () => activeNodeOverride`), the UI sub-router, the cross-node fan-out, the v10 observable shim and the undici fetch factory. It passes `onUnresolvable: "local"`.
- Tests: `packages/remote/test/dispatch/{resolve-target,routing-parity}.test.ts`.

**RED cases**

1. `"local"` mode, table-driven: each of the six fallbacks in §0.6 (unreadable kubeconfig, missing context, missing node, local endpoint, missing user, `resolveToken` throws) returns `{kind:"local"}`, exactly as `dispatcher.ts:543-570` does today.
2. `"error"` mode, same table: each case throws its typed code, and the local procedure spy records zero calls. The local-endpoint node is still `{kind:"local"}` (that is a real target, not a fallback). A `CONTROL_PLANE_ONLY` path is local regardless.
3. Routing parity through the **Electron adapter**: real `router`, a temp `LLAMACTL_TEST_PROFILE` kubeconfig, a real `serve()` remote agent on loopback with a self-signed cert. With `defaultNode = remote1`, `workloadList` runs locally (the remote records 0 calls) and `serverStatus` is forwarded to the remote over pinned TLS.
4. Parity guard: `packages/app/test/dispatcher.test.ts` and `packages/app/test/electron/**` pass with **no assertion changes**. Import-path-only edits are allowed and listed in the PR description.

**GREEN:** move the code, parameterize the resolution mode, and point the Electron adapter at it.

**Focused check (packages/remote):** `cd packages/remote && $BUN test test/dispatch`
(Controller regression, second package: `cd packages/app && $BUN test test/dispatcher.test.ts test/electron && $BUN run typecheck`.)

**Risks:** this is the largest regression surface in the plan, which is why it lands alone. The cross-node fan-out and the v10 shim stay in the Electron adapter. Do one manual Electron smoke (node override, logs stream, a remote `serverStatus`) on the PR.

### P2b: Bun console launcher + guarded same-origin server (read-only, fail-closed)

**Goal:** `llamactl console` serves `dist-web` and a guarded `/api/trpc` that runs the P2a dispatcher in **`"error"` mode**. Credentials, pinned TLS and node routing stay on the server. The node is kubeconfig `defaultNode` here; P3 makes it per request. **No mutation is exposed** (allowlist ∩ mutations = ∅).

**Files**

- `packages/remote/src/console/server.ts`: `startConsoleServer({ port, distPath, hostname: "127.0.0.1", backend?, lookupWorkload? })`. `backend` and `lookupWorkload` are test-only injection seams with no CLI flag. The guards, allowlist, projections and (from P5a) prechecks always wrap whatever backend is used.
- `packages/remote/src/console/guards.ts`: Host, `Sec-Fetch-Site`, `Origin`, cookie, and the **batch-aware path guard**. The guard takes the pathname after the endpoint prefix, `decodeURIComponent`s it, and splits it on `,`. It rejects an empty segment (leading, trailing or double comma), a duplicate segment or more than 16 segments with `400 bad_batch`. It rejects any segment not in the allowlist with `404 procedure_not_exposed`. All of this happens before tRPC runs, so nothing in a rejected batch executes.
- `packages/remote/src/console/session.ts`: nonce and cookie. The cookie name is `llamactl_console_<port>`. The server reads only its own name and ignores any other `llamactl_console_*` cookie.
- `packages/remote/src/console/static.ts`.
- `packages/remote/src/console/allowlist.ts`: one entry per exposed procedure, `{ type: "query" | "subscription" | "mutation", project: (out) => Projected, precheck?: (ctx, input) => Promise<void> }`. The console router is **built from these entries**: each is a pass-through procedure that calls the inner dispatch router through `createCaller({ node })` and returns `project(result)`, or maps `project` over each yielded item for a subscription. A procedure that is not in the list does not exist in the console router at all.
- `packages/remote/src/console/redact.ts`: `redactDeep(value)` plus per-procedure projections.
  - `env`: any key matching `/(API_KEY|TOKEN|SECRET|PASSWORD)$/i` (including `LOCAL_AI_API_KEY`, `OPENAI_API_KEY`, `LM_API_TOKEN`, `HF_TOKEN`) gets the value `"[redacted]"` when it is non-empty. The key is kept so the UI can show "set".
  - `nodeList` / `nodeTest`: the userinfo is stripped from every URL-valued string (`endpoint`, `rag.endpoint`, `cloud.baseUrl`, `advertisedEndpoint`). Every `cli[].env` value is replaced with `"[redacted]"`. Any field whose key matches `/(key|token|secret|password)/i` is masked, except public certificate material (`certificate`, `certificateFingerprint`).
  - `workloadList` / `workloadDescribe` / `serverStatus`: in every string array that looks like argv (`extraArgs`, args/cmdline fields), the value after a flag matching `/(api-key|token|secret|password)/i` (for example `--api-key`, `--hf-token`, `-hft`) is masked, as is the value of `--flag=value` forms. Env maps get the `env` rule. URL userinfo is stripped.
  - `serverLogs`: each line gets the argv rule and the URL-userinfo rule, plus `Bearer <x>` → `Bearer [redacted]`.
  - `redactDeep` applies the URL, key-name and `Bearer` rules to every allowlisted output, as a backstop for fields not named above.
- `packages/remote/src/index.ts`: exports.
- `packages/cli/src/commands/console.ts` (new), `packages/cli/src/bin.ts` (`case "console"` + USAGE).
- Tests: `packages/remote/test/console/{guards,batch,session,static,redaction,fail-closed,dispatch-parity,sse-teardown}.test.ts`, `packages/cli/test/console.test.ts`.

**RED cases (packages/remote unless noted)**

1. `GET /api/trpc/nodeList` without the cookie → `401 {"error":"invalid_session"}`.
2. `GET /` → `Set-Cookie: llamactl_console_<port>=<64 hex>; Path=/; HttpOnly; SameSite=Strict`. The nonce differs between two server starts. `index.html` has `connect-src 'self'` and `cache-control: no-store`.
3. Two concurrent servers A and B on different ports: the cookie names differ. A request that carries both cookies is accepted by A and by B, each validating only its own name. A's nonce presented under B's cookie name → 401 on B.
4. Valid cookie but `Host: evil.test:<port>` → `421`/`403`, procedure not called (spy backend).
5. `POST` with `Origin: http://evil.test` or `Sec-Fetch-Site: cross-site` → `403 cross_site_request_forbidden`. A **GET** subscription with `Sec-Fetch-Site: cross-site` → 403. A request with `Sec-Fetch-Site` missing → 403.
6. Allowlist, single path: `keepAliveStart`, `pullFile`, `nodeOpenAIConfig`, `reconcilerStart`, `uiPickDirectory`, `serverStop` → `404 procedure_not_exposed`, backend never called. Snapshot test: allowlist ∩ mutations = `∅` exactly; allowlisted subscriptions = `{serverLogs}` exactly; every entry has a `project` function.
7. Allowlist, batched (§0.12); the backend spy records **zero** calls for every rejected case:
   - `GET /api/trpc/serverStatus,keepAliveStart?batch=1&input=…` → 404 `procedure_not_exposed`. `serverStatus` is not run either.
   - `POST /api/trpc/workloadList,nodeOpenAIConfig?batch=1` → 404.
   - The same batch with the separator encoded as `%2C` → 404.
   - `nodeList,,env`, `,env` and `env,` → 400 `bad_batch`.
   - `env,env` → 400 `bad_batch`, as is a batch of 17 allowlisted segments.
   - `GET /api/trpc/nodeList,env,workloadList?batch=1` → 200 with three results, each one projected.
8. An inbound `Authorization: Bearer x` and extra cookies are not visible in procedure ctx or in upstream remote calls.
9. Redaction with sentinels (§0.11). The fixture sets up:
   - `LOCAL_AI_PROVIDER=lmstudio` and `LM_API_TOKEN=sentinel-lm`;
   - a kubeconfig user token `sentinel-kube`;
   - a RAG node whose `rag.endpoint` is `postgres://rag:sentinel-pg@db.local:5432/rag`;
   - an agent node with `cli: [{ env: { ANTHROPIC_API_KEY: "sentinel-cli" } }]`;
   - a ModelRun with `extraArgs: ["--api-key", "sentinel-arg", "--hf-token=sentinel-hf"]`;
   - a log fixture line containing `--api-key sentinel-log` and `Authorization: Bearer sentinel-bearer`.

   The test calls every allowlisted procedure, singly and batched, and reads `serverLogs` SSE frames. No `sentinel-*` string appears in any response body or frame. `env.LM_API_TOKEN`, `env.OPENAI_API_KEY` and `env.LOCAL_AI_API_KEY` equal `"[redacted]"`. The RAG endpoint comes back as `postgres://db.local:5432/rag`. Unit tests in `redaction.test.ts` cover each rule on its own, and show that non-secret fields (node names, ports, model rels) pass through unchanged.

10. Fail closed from the first console PR (§0.6). With `defaultNode = remote1` and a user whose token cannot be resolved, `serverStatus` → error `node_credentials_unavailable`, and the local spy records 0 calls. With an unreadable kubeconfig, a node-routed procedure → `kubeconfig_unreadable`, also with 0 local calls. A `CONTROL_PLANE_ONLY` procedure still works when the kubeconfig resolves.
11. Routing parity through the **console mount** (the same harness as P2a RED 3): `workloadList` runs locally, and `serverStatus` is forwarded to remote1 over pinned TLS with Bun `makePinnedFetch`.
12. SSE teardown: subscribe to `serverLogs` (fixture log file, `follow: true`) with `Accept: text/event-stream`, then abort the client fetch. The server generator's `finally` runs within 1 s and the file watcher is released. For the remote case, the remote agent sees the disconnect.
13. Static: `/..%2f..%2fetc%2fpasswd` → 403; unknown extensionless path → index; missing asset → 404; security headers on every response.
14. CLI (`packages/cli/test/console.test.ts`): `console --no-open --port 0` prints `Console: http://127.0.0.1:<port>` and binds only on 127.0.0.1; a missing dist exits 1 with the `build:web` hint; `--host 0.0.0.0` is refused (remote access is a non-goal).

**GREEN:** build the Bun.serve server: guards → batch-aware allowlist → `fetchRequestHandler({ endpoint: "/api/trpc", router: buildConsoleRouter(allowlist, buildDispatchRouter({ …, onUnresolvable: "error" })), createContext: () => ({ node: null }) })`. Set `idleTimeout: 255`, and use SSE ping to keep streams alive.

**Focused check (packages/remote):**
`cd packages/remote && $BUN test test/console`
(Controller, second package: `cd packages/cli && $BUN test test/console.test.ts`.)

**Risks:**

- The redaction rules are heuristic. The sentinel test plus `redactDeep` as a backstop bound the risk, and any new allowlist entry must come with a sentinel case (enforced by the snapshot's "every entry has `project`" assertion and by review).
- Bun.serve SSE backpressure on Linux (#178 history); run the SSE test on the Ubuntu leg.
- The console process becomes a second control-plane process next to `llamactl controller serve`. It exposes no mutation in this phase, and every `reconciler*` is outside the allowlist.

### P3: Tab-scoped node selection

**Goal:** every request names its target node, and that node is a dispatchable agent node. Two tabs cannot redirect each other. An unknown, non-dispatchable or unresolvable node fails closed.

**Files**

- Server: `packages/remote/src/console/server.ts` mounts `/api/n/:node/trpc/*` (a path segment, because EventSource cannot set headers). The bare `/api/trpc` mount is removed. `createContext` returns `{ node }` after validation:
  - The node must be in the current cluster's `nodes` with `effectiveKind === "agent"`. The local in-process node counts.
  - A gateway or RAG node → `400 node_not_dispatchable`.
  - A synthesized `<gateway>.<provider>` name, or any unknown name → `404 unknown_node`.
  - The mode stays `onUnresolvable: "error"`.
- Client: `packages/app/src/console/node-scope.ts` (new) holds `useTabNode()`. Resolution order:
  1. the URL `?node=`, if it names a dispatchable node;
  2. `sessionStorage["llamactl-console-node"]`, if dispatchable;
  3. once `nodeList` loads, `nodeList.defaultNode`, if it is dispatchable;
  4. `local`.

  It never uses localStorage. The selector options are `nodeList.nodes.filter(n => n.effectiveKind === "agent")`, so gateway, provider and RAG nodes are never offered. A `NodeScopedProvider` remounts the `QueryClient` + tRPC client per node. There is no separate per-workload client (see the node model in §1).

- `packages/app/src/lib/transport/http.ts`: `buildHttpLinks({ baseUrl, node })` → `/api/n/${encodeURIComponent(node)}/trpc`.
- Web-only: the workload selection store (`beacon-workload-selection`) is persisted to `sessionStorage` in the web build.
- Tests: `packages/remote/test/console/routing.test.ts`, `packages/app/test/console/node-scope.test.ts`.

**RED cases**

1. Interleaved: 50 alternating `serverStatus` calls for `/api/n/local/…` and `/api/n/remote1/…`, issued concurrently. The fake remote sees exactly the 25 remote1 calls and the local spy exactly 25.
2. `/api/n/ghost/trpc/serverStatus` → `404 unknown_node`, no procedure called, **no local fallback**.
3. `/api/n/<gateway>/…` and `/api/n/<ragNode>/…` → `400 node_not_dispatchable`; `/api/n/<gateway>.<provider>/…` → `404 unknown_node`. Zero procedure calls in all three cases.
4. A remote node whose user token cannot be resolved → `node_credentials_unavailable`, not local execution.
5. Control-plane-only procedures under any valid node run locally. An invalid node segment is still rejected.
6. Setting the Electron module-global override has no effect on console requests (no shared mutable state).
7. The batch-aware allowlist (P2b RED 7) still holds under `/api/n/:node/trpc/`, and `%2F` inside the node segment → 400.
8. Client:
   - Two independent `Storage` instances simulating two tabs keep separate nodes.
   - `?node=` overrides storage.
   - Nothing is written to `localStorage`.
   - A node name containing `/` or failing the kubeconfig name regex is rejected client-side.
   - A gateway or provider name in `?node=` is rejected client-side (fallback plus notice).
   - The selector options exclude gateway, provider and RAG nodes.
   - With no URL or storage value, the default is `nodeList.defaultNode` when it is an agent node, and `local` when it is not.
9. Switching node A → B gives a fresh `QueryClient`: a cached `env` result from A is not served on B.

**GREEN:** route parsing plus kubeconfig validation; the per-tab store and provider; the node selector in the console titlebar.

**Focused check (packages/remote):** `cd packages/remote && $BUN test test/console/routing.test.ts`
(Second package, controller-run: `cd packages/app && $BUN test test/console/node-scope.test.ts`.)

**Risks:** "Duplicate tab" copies sessionStorage. That is acceptable (the duplicate starts on the same node and is independent afterwards) and should be documented. Cache bleed if a caller bypasses `NodeScopedProvider`; the P5a lint rule says console modules must not import `trpc` directly.

### P4: HTTP/SSE links with reconnect and teardown

**Goal:** predictable live-state behaviour: backoff reconnect, clean teardown, terminal errors that do not retry, an invalid-session banner, and mutations that are never retried.

**Files**

- `packages/app/src/lib/transport/sse-lifecycle.ts` (new): wraps `httpSubscriptionLink`. It uses a fetch-based EventSource (`eventsource@4` with a `fetch` override) so status codes are visible, and disables native auto-reconnect. States are `connecting | streaming | reconnecting | idle | error`. Backoff `[1,2,4,8,16,30]s`, with a 2 s health confirm before backoff resets.
- `packages/app/src/lib/transport/errors.ts` (new): network / invalid_session / forbidden / not_exposed / unknown_node / node_not_dispatchable / workload_refused (409) / procedure.
- `packages/app/src/console/session-store.ts` (new): invalid-session flag → banner ("Console restarted or session expired — reload").
- `packages/app/src/modules/logs/index.tsx`: consumes `__reconnect__` by clearing the buffer and re-requesting the history window, so lines are not duplicated.
- Tests: `packages/app/test/lib/transport/sse-lifecycle.test.ts`, `packages/app/test/lib/transport/errors.test.ts`.

**RED cases (fake EventSource + fake timers)**

1. After an error, reconnect delays run 1 s, 2 s, 4 s … and stay capped at 30 s.
2. A connection that opens and drops before 2 s does **not** reset backoff.
3. Unsubscribing during a backoff wait cancels the timer; opened = closed sources (no leak).
4. A 401 on (re)connect means no further reconnects and the invalid-session flag is set. A 404 `procedure_not_exposed` / `unknown_node` or 400 `node_not_dispatchable` is a terminal error with no retry.
5. Each successful reopen emits exactly one `__reconnect__`, and the Logs buffer resets on it.
6. A mutation that hits a network error surfaces the error, `fetch` is called exactly once, and nothing is retried.
7. Integration (packages/remote harness, in-process): restarting the console server on the same port mid-stream means the client's reconnect gets 401 (new nonce, same `llamactl_console_<port>` name), which is terminal and raises the banner.

**GREEN:** implement the wrapper and error mapping; wire them into `buildHttpLinks`; connect the Logs state dot to the lifecycle state.

**Focused check (packages/app):** `cd packages/app && $BUN test test/lib/transport`

**Risks:** two reconnect mechanisms fighting each other (tRPC's own handling plus ours). The test asserts a single open per attempt. `serverLogs` replays history on every reconnect, which is handled by the buffer reset. Proxies buffering SSE do not apply (loopback only).

### P5a: Console shell, views and the confirmed stop action

**Goal:** fleet overview, tab-node workload inspection, tab-node live logs, and one confirmed lifecycle action (`serverStop`) in a Penumbra-style shell. Covered by bun tests on the app side and on the server precheck. The browser tests come in P5b.

**Files**

- `packages/app/src/console/{ConsoleShell.tsx,console-manifest.ts,router.ts}` (new). `main.web.tsx` mounts `ConsoleShell`, not the full Electron App, so the web bundle includes only these modules.
- Views reuse existing components where possible and follow the §1 node model:
  - `console/views/fleet.tsx`: the legacy `NodeMap` over every node (`nodeList`, `nodeTest`) with "open in new tab on <node>" links, the exposed-workloads list, and a "this tab's node" card from `env` (redacted) and `nodeFacts`.
  - `console/views/workloads.tsx`: `workloadList` filtered to `spec.node === tabNode`. A footer counts the workloads on other nodes and links to each node via `?node=`. The Describe drawer (manifest YAML, status JSON, workers table) comes from `modules/workloads/{index,workload-row,workers-panel}`. A deep link to a workload on another node shows "This workload runs on <node>. Switch this tab or open a new one", and makes no node-routed call. ApplyPanel and the reconciler toolbar are not mounted.
  - `console/views/nodes.tsx`: list, kind, endpoint (userinfo already stripped on the server), default badge, 30 s `nodeTest` dot.
  - `console/views/logs.tsx`: from `modules/logs`, plus a workload picker that lists only tab-node workloads. `serverStatus`/`serverLogs` go through the tab's node-scoped client.
- `console/actions/stop-server.tsx`:
  - **Offered only** for `kind === "ModelRun"`, `spec.node === tabNode` and `spec.workers.length === 0`.
  - For a ModelRun with workers, the button is disabled. Its explanation lists the worker nodes whose rpc-servers a coordinator stop would leave running, and points to `llamactl delete workload <name>` (full ordered stop) or `llamactl server stop` + `rpc-server` stops.
  - ModelHost rows have no stop button.
  - The dialog shows the workload, the **target node** (= the tab node) and the endpoint. It says a controller or reconciler may restart a workload whose manifest remains, and it requires typing the workload name (the ops-chat pattern).
  - On submit it calls `serverStop.mutate({ workload, graceSeconds: 5 })` once on the tab's client.
  - On `{stopped:true}`: a success toast, then `serverStatus`/`workloadList` are invalidated.
  - On `{stopped:false}`: an **inline refusal**, "Stop not confirmed: llamactl could not verify that PID <pid> is still this workload's llama-server. Its tracking record was kept. Check with `llamactl server status`". There is no success toast. The status is refreshed, but nothing is shown as stopped.
  - A 409 from the precheck shows the refusal inline.
- `packages/remote/src/console/allowlist.ts`: adds the `serverStop` entry with a **precheck** that runs before the inner router is called. It uses `lookupWorkload` (default: `workloadStore.loadWorkloadByNameAny`) and refuses with:
  - `404 workload_not_found` when no manifest exists. The prototype stops only manifest-backed workloads.
  - `409 unsupported_workload_kind` when the workload is not a ModelRun.
  - `409 workload_node_mismatch` when `spec.node !== ctx.node`. This stops a forged request from stopping a same-named server on another node.
  - `409 multi_node_workload` when `spec.workers` is non-empty.

  The projection passes `{stopped, pid, killed}` through unchanged.

- Endpoint links: `target="_blank" rel="noopener noreferrer"`.
- Lint guard (an `eslint.config.mjs` `no-restricted-imports` block for `packages/app/src/console/**`): no direct import of `@/lib/trpc`'s React instance. Console code uses the node-scoped hooks.
- Tests: `packages/app/test/console/{manifest,router,workloads-scope,stop-dialog}.test.ts`, `packages/remote/test/console/stop-precheck.test.ts`. The P2b allowlist snapshot is updated in this PR.

**RED cases**

- _App (bun test, pure view-model functions; DOM behaviour is proven in P5b):_
  - `stopDialogState`: submit stays disabled until the typed name matches exactly, and Cancel produces zero calls.
  - `stopAvailability`: a single-node ModelRun on the tab node is enabled. A ModelRun on another node is not offered. A ModelRun with workers is disabled, and the reason lists the worker nodes. A ModelHost is not offered.
  - `stopResultMessage`: `{stopped:true}` → success. `{stopped:false, pid}` → refusal text that contains the pid and does not count as success. A 409 → its inline refusal.
  - `workloadsForTab`: keeps only `spec.node === tabNode`, and counts the others per node.
  - The router parses each deep link, including `?node=`.
  - The manifest has exactly `fleet, workloads, nodes, logs`.
- _Remote (`stop-precheck.test.ts`, spy inner router):_
  - A missing manifest, a ModelHost, a node mismatch and a multi-node ModelRun each return their code, and the inner `serverStop` records zero calls.
  - A single-node ModelRun on `ctx.node` gives exactly one inner call with `graceSeconds: 5`.
  - `{stopped:false}` from the inner router passes through unchanged.
  - The allowlist snapshot is now mutations = `{serverStop}` exactly.
  - A batch `serverStatus,serverStop` sent as GET is rejected by tRPC's method check, with zero `serverStop` calls.

**GREEN:** build the shell and the four views, wire the action and the server precheck, and prune the web registry to the console manifest.

**Focused check (packages/app):** `cd packages/app && $BUN test test/console && $BUN run typecheck && $BUN x vite build -c vite.web.config.ts`
(Controller, second package: `cd packages/remote && $BUN test test/console`.)

**Risks:**

- Scope creep: no fifth module, and no Expose form, in this PR.
- The workload-on-another-node notice is a UX cost of the single model. It is deliberate, because it keeps every node-routed call on the tab's node.
- The bundle may still pull in heavy shared deps (yaml, NodeMap); measure it in P6.

### P5b: Playwright harness, functional specs and advisory CI

**Goal:** deterministic browser tests over the real console server layer (guards, allowlist, projections, stop precheck), with a fixture backend underneath.

**Files**

- `packages/app/playwright.config.ts`: chromium only, `workers: 1`, `fullyParallel: false`, `retries: 0`, `forbidOnly` on CI, `trace: retain-on-failure`.
- `packages/app/e2e/harness/{serve.ts,fixture-backend.ts,fixtures/*.ts}`.
  - `serve.ts` starts the real `startConsoleServer` with the `backend` and `lookupWorkload` seams.
  - The fixture backend implements only the allowlisted procedures. It is typed against `inferRouterOutputs<AppRouter>`, so the fixtures cannot drift from the real types, and its outputs still pass through the real projections. It records calls per node and exposes test controls: emit a log line for a workload, drop a stream, mark a node unreachable, and make `serverStop` return `{stopped:false}` or throw.
  - The fixtures seed the same sentinels as P2b RED 9.
- `packages/app/e2e/*.spec.ts` (below).
- `packages/app/package.json`: devDependency `@playwright/test` and script `e2e`.
- `.github/workflows/console-e2e.yml`: new, ubuntu-latest, **advisory** (not required) until P7.

**RED cases (Playwright)**

1. `fleet.spec`: renders local + agent-1 + an offline node (red dot, no endless spinner). Partial fleet: the other nodes still render. Endpoint links open a new tab. The tab-node card shows `LM_API_TOKEN` as "set" (redacted), not its value.
2. `workloads.spec`:
   - With the tab on agent-1, only agent-1 workloads are listed, and the footer counts the local ones.
   - A Describe drawer shows manifest, status and workers. Its `extraArgs` shows the `--api-key` value masked.
   - The `/workloads/:name?node=agent-1` deep link loads directly. A deep link to a local workload from an agent-1 tab shows the switch notice and makes no node-routed call.
   - No Apply or reconciler Start/Stop controls are present.
3. `nodes.spec`: kind, endpoint and default badge are shown, and the RAG endpoint has no password. Reachability updates after the fixture flips a node. The titlebar selector lists only agent nodes, with no gateway, provider or RAG node.
4. `logs.spec`:
   - Lines stream, and the follow toggle works.
   - When the fixture drops the stream, the state goes `reconnecting` → `streaming` with a single "reconnected" divider and no duplicated history.
   - Navigating away makes the fixture report the stream closed within 2 s.
   - A stopped workload shows "Server offline" and opens **no** stream.
   - A fixture line containing `--api-key sentinel-log` renders masked.
5. `lifecycle.spec`:
   - Cancel → 0 mutations.
   - A wrong typed name keeps submit disabled.
   - Confirm → exactly one `serverStop` recorded on **the tab's node** with `graceSeconds: 5`, and a success toast.
   - When the fixture returns `{stopped:false}`, the inline "Stop not confirmed" refusal appears with the pid, there is no success toast and nothing is retried.
   - A server error shows inline, and nothing is retried.
   - A multi-node ModelRun shows a disabled stop button with its worker list.
   - A forged `page.request` POST of `serverStop` for a local workload, sent to `/api/n/agent-1/…`, → 409 `workload_node_mismatch`, and the fixture records zero `serverStop` calls.
6. `two-tabs.spec` (metric T5): two pages in one browser context, tab A on `local` and tab B on `agent-1`.
   - Both open the Logs view at the same time: A on local workload `wA`, B on agent-1 workload `wB`.
   - B then stops `wB` through the dialog.
   - The fixture then emits lines for both workloads.
   - Assertions:
     - A's stream keeps receiving `wA` lines with **no** reconnect divider and no state change.
     - B's stream shows `wB` going offline.
     - The per-node call log has `serverLogs(wA)` only on local, and `serverLogs(wB)` + `serverStop(wB)` only on agent-1.
     - A's call log has no entries made after B's stop other than its own stream.
     - After A reloads it is still on `local`.
7. `session.spec`: a request without the cookie shows the banner. `page.request` with a forged `Origin`/`Sec-Fetch-Site: cross-site` gets 403. A non-allowlisted procedure gets 404, alone and inside a batch with an allowlisted one.
8. `credentials.spec`: a HAR capture of the full run (specs 1–7 replayed in one context) and the final `page.content()` of every view contain none of the P2b sentinel values (`sentinel-lm`, `sentinel-kube`, `sentinel-pg`, `sentinel-cli`, `sentinel-arg`, `sentinel-hf`, `sentinel-log`, `sentinel-bearer`), and `localStorage`/`sessionStorage` contain no sentinel or token-like value.

**GREEN:** write the harness, fixtures, specs and the workflow.

**Focused check (packages/app):** `cd packages/app && $BUN run e2e`
(`e2e` runs `playwright test`. Playwright's runner needs Node and a one-time `npx playwright install chromium`. Record both in the setup-effort metric.)

**Risks:**

- Fixture drift. Mitigated by output typing, by running the real server layer above the fixture, and because the real-router routing, pinned-TLS and SSE-teardown proof already lives in the P2a/P2b/P3 bun tests.
- Flakes: `retries: 0`, fixture-driven timing, no sleeps.

### P6: Decision gate (**STOP for an operator decision**)

**Goal:** measure the prototype and record a decision on #410. **No P7 work starts until the operator comments with the decision.**

**Files**

- `docs/decisions/410-ui-runtime.md`: measurements, the decision record template and the recommendation.
- `scripts/measure-410.ts`: reproducible footprint numbers. Read-only; prints JSON. P7 reruns it.

**Metrics**

1. **Task completion.** A scripted operator task list runs on the console vs the CLI, recording success, wall time, steps and any CLI fallback:
   - T1: find the unreachable node.
   - T2: find workload X's phase and endpoint.
   - T3: tail X's logs on a remote node.
   - T4: stop X with confirmation.
   - T5: tail logs on two nodes in two tabs at once while stopping a workload in one of them. This is what `two-tabs.spec` covers.
   - T6: recover after a console restart.
2. **Setup effort.** Commands and wall time from a clean clone to first render (`bun install` → `bun run --cwd packages/app build:web` → `llamactl console`) vs Electron (`dev`/`package:mac`). Include signing or packaging needs, supported platforms (the browser works on Linux, where production llamactl runs), and the Node/Playwright requirement.
3. **Dependency and CI footprint.**
   - Dependencies removable in P7: `electron`, `electron-builder`, `electron-vite`, `electron-trpc`, `undici` (used only by Electron main and preload in `src`), `bufferutil`, `utf-8-validate`. Dependency added: `@playwright/test`.
   - Lockfile package-count delta.
   - CI minutes, runs and rerun counts over the last 30 days for `ui-audit`, `ui-tier-a` and `ui-flows-nightly` (`gh run list --workflow … --json`) vs `console-e2e`, plus the #369 rerun-pass incidents.
4. **Maintenance.**
   - Retained renderer lines: the console entry's import graph vs ~26k today.
   - Files under `packages/app/electron/**`.
   - Compatibility shims (2 Bun shims, CJS bundling exceptions, the v10 subscription shim).
   - The dispatcher is a single implementation after P2a.
   - New console-side upkeep: allowlist entries, projections and their sentinel cases.
5. **Security checklist:** port-scoped cookie, Host, Origin, Sec-Fetch-Site, batch-aware allowlist, server-side response redaction, fail-closed resolution, stop precheck, no credentials in the browser (HAR, DOM and storage), loopback bind. All of it is evidenced by P2b–P5b tests.

**Proposed thresholds** (for the operator to accept or change; not applied automatically):

- T1–T5 completed with no CLI fallback.
- Setup in ≤ 3 commands with no signing.
- Net dependencies removed > added.
- Retained renderer ≤ ~25% of today's lines.
- Zero dependence on `electron-mcp`.

**Decision options**

- **A: Focused web conversion.** Go to P7-A.
- **B: Retire the UI completely.** Go to the CLI/MCP-only fallback (§4, P7-B).
- _(Not offered: extending the prototype with more modules. The issue says to end the prototype before expanding scope. A narrowly named gap can be one bounded follow-up only if the operator explicitly asks for it.)_

**Check:** `cd packages/app && $BUN run ../../scripts/measure-410.ts` (prints the JSON committed to the decision doc).

**Risks:** source-only usage data. The issue notes that no live usage study was done, so the task list stands in for real usage and should be stated as such. Keep the decision doc honest about this.

### P7-A: Electron removal (only after decision A is recorded)

**Entry preconditions**

- (a) The decision comment is on #410.
- (b) A **bench scheduler disposition** is landed or recorded: either move the loop and CRUD to the agent or console with `llamactl bench schedule …` CLI, or record "scheduled benches stop" as an accepted loss. Removing Electron otherwise silently ends scheduled benches.
- (c) Operators have been told to export localStorage-only state (pipeline drafts, chat history). Nothing is migrated automatically, and kubeconfig, tokens and other operator state are untouched.
- (d) The `console-e2e` job has been green on main for ≥ 5 consecutive runs.

**Files (delete)**

- `packages/app/electron/**`: main, preload, `shims/bun.ts`, `shims/bun-sqlite.ts`, `trpc/router.ts`, `trpc/dispatcher.ts` (the logic already lives in `@llamactl/remote`), `node-pinned-fetch.ts`, `cross-node-fan-out.ts`.
- `packages/app/{electron.vite.config.ts,electron-builder.yml,tsconfig.main.json,tsconfig.node.json,tsconfig.web.json}`. `tsconfig.console.json` becomes `tsconfig.json`'s only project, with no `electron/**` includes.
- `packages/app/src/{lib/transport/ipc.ts,lib/ui-client.ts,lib/ui-client.electron.ts,main.tsx,index.html}` and the App shell parts used only by Electron.
- Retired and deferred module directories and registry entries not in `console-manifest.ts` (recoverable from git history; the decision doc lists the paths). Delete their tests and update `test/shell/beacon/search-view.test.ts`.
- CI and audit chain:
  - workflows: `.github/workflows/{ui-audit,ui-tier-a,ui-flows-nightly}.yml`
  - test assets: `tests/ui-audit-*`, `tests/ui-audit-baselines/`, `tests/ui-flows/`
  - scripts: `scripts/audit.sh`, `scripts/smoke-tier-a.sh`, `scripts/smoke-ui-flows.sh`, `scripts/check-ui-audit-functional-report.ts`
  - `packages/app/test/ui-audit-modules-drift.test.ts`
  - docs: `docs/ui-audit.md`
  - the root `audit`, `audit:update` and `audit:functional` scripts

**Files (update)**

- `packages/app/package.json`: remove Electron, packaging, undici, bufferutil, utf-8-validate and the `package*` scripts. Write a new description and remove `main`. `build` becomes `vite build -c vite.web.config.ts`, and `typecheck` becomes a single `tsc -p tsconfig.json --noEmit`.
- `packages/app/test/setup.ts`: remove the `electronTRPC` stub (delete the file if nothing else is left in it, along with its three importers' `import` lines).
- `eslint.config.mjs`: remove `packages/app/electron/**/*.ts` and `packages/app/electron.vite.config.ts` from the Node-globals block (lines 228-239), and change `packages/app/vite.config.ts` to `packages/app/vite.web.config.ts`. `appRendererFiles` stays.
- `tsconfig.eslint.json`: remove the `packages/app/electron/**/*.ts` and `packages/app/electron.vite.config.ts` includes (lines 21-22), so `typecheck:strict` keeps passing.
- Move the dispatcher tests from `packages/app/test/{dispatcher.test.ts,electron/**}` to `packages/remote/test/dispatch/` where they still apply (the cross-node fan-out tests go with the deleted code).
- CI: make `console-e2e` **required**. Keep `check.yml`'s "Test packages/app" step and `cross-repo-smoke.yml`'s packages/app tier, which still apply, and confirm both pass on the PR.
- Docs: README (the "One router, three mounts" section and the "packages/app (Electron)" tree line), root `package.json` description (drop "Electron control surfaces"), release and launch docs.
- `docs/decisions/410-ui-runtime.md`: see step "Measured reduction" below.
- #369: after `console-e2e` is required and green, comment with the replacement evidence and close it as superseded. Do not close it earlier.

**Measured reduction (part of the done criteria)**

1. Rerun `scripts/measure-410.ts` on the P7-A branch after the deletions.
2. Update `docs/decisions/410-ui-runtime.md` with a **measured before/after table**: dependencies, lockfile package count, CI minutes per 30 days (using the projected figure until 30 days of `console-e2e` history exist, and labelled as projected), retained renderer lines, and `packages/app/electron/**` file count. Compare each row with P6's projection.
3. Add an explicit **Remaining costs** section to the same doc:
   - the browser transport (tRPC HTTP/SSE links and the reconnect wrapper);
   - the console server lifecycle (started manually, port choice, a restart invalidates sessions);
   - the auth layer (cookie/nonce, Host/Origin/Sec-Fetch-Site guards, plus allowlist, projection and sentinel upkeep whenever an exposed procedure changes);
   - the Playwright/Node dev dependency and the chromium download;
   - the dispatch module in `@llamactl/remote`.

**RED cases (guards that fail before deletion)**

1. `packages/app/package.json` has no dependency matching `^electron|electron-|^undici$`.
2. No file under `packages/app` imports `electron`, `electron-trpc` or `ipc-link`, or contains `electronTRPC`. `tsc -p packages/app/tsconfig.json --listFilesOnly` lists nothing under `electron/`.
3. `git grep -n electron-mcp -- .github scripts tests package.json packages docs ':!docs/superpowers' ':!docs/notes'` is empty. Historical session notes are exempt, and the exemption is listed in the test. No workflow runs only on macOS for UI.
4. `git grep -n -E "packages/app/electron|electron\.vite\.config" -- eslint.config.mjs tsconfig.eslint.json package.json .github` is empty.
5. The registry/manifest equality test: shipped modules == `console-manifest.ts`.
6. `renderer-no-bun.test.ts` is still green over the whole of `src/**` (it now covers the entire retained app).
7. The decision doc has a "Measured before/after" table and a "Remaining costs" section (a text check in `packages/app/test/decision-doc.test.ts`, deleted with the doc's next revision if not wanted long-term).

**GREEN:** the deletions, updates and moves above; one supported UI runtime.

**Focused check (packages/app):** `cd packages/app && $BUN test && $BUN run typecheck && $BUN x vite build -c vite.web.config.ts`
(Controller: `cd packages/remote && $BUN test test/dispatch test/console`, then the full serial gate, which includes the root `typecheck`, `typecheck:strict` and `lint`.)

**Risks:**

- A large deletion diff: split the review into commits for runtime/packaging, modules, CI/scripts/lint config, and docs inside the one PR.
- Hidden imports from deleted modules (global search, tab store) show up only at build time; the focused check runs `vite build`.
- Root `overrides.undici-types` may become unnecessary; verify before removing.
- `release-agent.yml` (agent binary) must not change.

---

## 4. Non-goals and the CLI/MCP-only fallback

**Non-goals**

- Porting deferred or retired modules, or feature parity with the current 22-entry registry.
- Redesigning the API (no Penumbra-style REST or contract package); tRPC types stay.
- A shared cross-repo component or UI package, or refactoring Penumbra.
- Hosted, LAN or remote browser access. The console binds loopback only. Remote access would need its own explicit, authenticated design later.
- The browser talking directly to self-signed agents, or any fleet credential in browser storage, Vite env, the DOM or responses.
- Pixel or visual regression suites, Storybook, multiple themes or map variants.
- Supporting Electron and web side by side indefinitely. Electron keeps shipping only until P7.
- Migrating renderer localStorage state (chat history, pipeline drafts) automatically, or any destructive migration of kubeconfig, tokens or projects.
- Moving the in-process reconciler or keep-alive supervisor into the console server.
- Stopping multi-node ModelRuns or ModelHosts from the console prototype.
- Changing agent auth or the shared router's semantics. The dispatch extraction preserves Electron behaviour exactly; the fail-closed mode is console-only.

### P7-B: decision B (retire the UI completely, CLI/MCP-only product)

Run P7-B in place of P7-A, as one PR after its preconditions:

1. **Required before deletion:** the bench scheduler disposition (same as P7-A precondition b).
2. **Recommended gap-closers** (small, separate PRs; operator picks):
   - MCP `llamactl.server.logs` (logs have no MCP path)
   - `llamactl project journal [--tail N] [--follow]`
   - `llamactl cost-guardian status|journal` (read-only)
   - `llamactl catalog unpromote <profile> <preset>`
   - `llamactl ops sessions list|rm` (only if ops-chat backend procedures stay)
   - `llamactl node discover-lan` and `llamactl node openai-config <name>`
   - MCP `llamactl.uninstall` and `llamactl.workload.describe`
   - CLI `rag search` / `rag collections` and `node models <name>`
   - `plan run --node` / `operator.plan nodeId`
3. **Delete:**
   - all of `packages/app`;
   - the console server (`packages/remote/src/console`, its tests) and `llamactl console` (`packages/cli/src/commands/console.ts`, its `bin.ts` case and USAGE line, `packages/cli/test/console.test.ts`) if P2b–P5b landed;
   - the three UI workflows, `.github/workflows/console-e2e.yml` if it exists, and `tests/ui-*`;
   - the same scripts and docs as P7-A: `scripts/{audit.sh,smoke-tier-a.sh,smoke-ui-flows.sh,check-ui-audit-functional-report.ts}`, `docs/ui-audit.md`, the root `audit*` scripts.

   Keep `packages/remote/src/dispatch` only if the CLI uses it; otherwise delete it too.

4. **Update, or the next CI run fails:**
   - root `package.json`: remove `bun run --cwd packages/app typecheck &&` from `typecheck`; update `description`; check the `workspaces` glob.
   - `.github/workflows/check.yml`: remove the "Test packages/app" step.
   - `.github/workflows/cross-repo-smoke.yml`: remove the "Run llamactl tier (packages/app)" step.
   - `eslint.config.mjs`: remove `appRendererFiles` and its React block, the `packages/app/**` entries in the Node-globals block, and any React/Vite plugin imports that are no longer used.
   - `tsconfig.eslint.json`: remove the `packages/app/electron/**` and `electron.vite.config.ts` includes, the `@/*` path and the `vite/client`/`react`/`react-dom` types if nothing else needs them.
   - RED guard: `git grep -n "packages/app" -- package.json .github eslint.config.mjs tsconfig.eslint.json` is empty, and the P7-A RED 3 `electron-mcp` grep is empty. Controller gate: root `typecheck`, `typecheck:strict` and `lint` all pass.
5. **Document:** a replacement table (the inventory's CLI/MCP column) in README, plus the explicit loss list:
   - topology map, at-a-glance dashboard
   - interactive chat, A/B compare
   - ops-chat loop UX
   - routing-journal view
   - pipeline editor
   - reconciler status
   - scheduled benches (if not rehosted)
   - mDNS discover (if not added)
   - the OpenAI config reveal
6. **Close #369** as obsolete. Rerun `scripts/measure-410.ts` (or record the same numbers by hand if the script went with `packages/app`). Put the measured before/after maintenance reduction (dependencies, lockfile, CI minutes, lines) and a remaining-costs section (the CLI/MCP gap list still open, plus any kept dispatch module) in the decision doc.
