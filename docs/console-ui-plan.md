# Operator console UI plan — full feature parity

Goal: every llamactl interaction point (tRPC router, CLI verbs, MCP tools,
Ops Chat, background loops, journals) is reachable from the operator console
(`packages/app`). This document maps the surfaces to console modules, defines
the shared UI patterns they need, lists the remote/core gaps that block some
of them, and sequences the work into phases. It follows the structure of the
Penumbra `docs/console-ui-plan.md` so the two consoles evolve in parallel.

Baseline (main, `74434039`): the app is 196 files / ~19k lines under
`packages/app/src`, Electron 41 + React 19 + TanStack Query v5 + Zustand,
22 registry modules, and reaches **82 of 122** tRPC procedures. Forty
procedures have no UI caller (§6). Background state held by the healer, fleet
supervisor, response/KV caches, eval matrix and train has no tRPC reader at
all, so it is invisible to every client, not only the app.

## 1. Principles

1. **One router, four clients.** The `@llamactl/remote` tRPC router is the
   source of truth. CLI (`dispatcher.ts`), agent HTTPS, MCP (`packages/mcp`)
   and the Electron app all call the same procedures. No console feature may
   depend on state only a CLI command or a JSONL file can reach — when that
   happens it is a _remote_ gap (§6): add the pure logic in `packages/core`,
   expose it in the router, then project it through MCP + Ops Chat (the
   `ops-chat-coverage` smoke test enforces the last step).
2. **Read everywhere, act with intent.** Every query becomes a view. Every
   mutation becomes an explicit action carrying the tier the Ops Chat
   registry already assigns (`packages/remote/src/ops-chat/dispatch.ts`):
   - `read` — no confirmation.
   - `mutation-dry-run-safe` — the UI runs the dry-run first, shows the
     diff/plan, then asks for the wet run (`workloadApply`, `compositeApply`,
     `ragPipelineRun`, `promote`, `nodeAdd`, `reconcilerKick`, …).
   - `mutation-destructive` — typed confirmation of the target name
     (`workloadDelete`, `compositeDestroy --purge-volumes`, `nodeRemove`,
     `ragDelete`, `projectRemove`, `promoteDelete`, `infraUninstall`,
     `serverStop` on a workload with `enabled: true`).
     Procedures that are not yet in `OPS_CHAT_TOOLS` inherit a tier in this
     document (§3) and should be added to the registry when they gain a UI.
3. **Node scope is explicit.** Every view states which node it addresses.
   The main-process dispatcher already resolves the active node
   (`uiSetActiveNode`) and pins TLS per node; the UI must show the active
   node in the title bar and on every mutating dialog, and offer
   `all`-node fan-out only for reads (mirroring the CLI `--node all`).
4. **Live by default.** Anything with a subscription (`serverLogs`,
   `serverStart`, `compositeStatus`, `opsSessionWatch`, `operatorChatStream`,
   `bench*Run`, `pull*`, `modelHostStart`, `rpcServerStart`) renders a live
   stream; periodic loops (reconciler, bench scheduler, RAG scheduler, cost
   guardian) poll their status procedure at 5–30 s as today.
5. **Every action is audited.** UI mutations should flow through
   `operatorRunTool` (which appends to `~/.llamactl/ops-chat/audit.jsonl`)
   whenever the procedure has an Ops Chat tool, so the browser and the
   planner share one audit trail. Direct `useMutation` calls stay for
   procedures without a tool until §6.7 lands.
6. **Registry-first.** A module is one `AppModule` entry in
   `modules/registry.ts` plus `tests/ui-audit-modules.json` plus a baseline
   PNG. The drift test and Tier-A smoke keep that honest; the integration
   plan (`docs/console-integration-plan.md`) extends the entry with
   capability metadata so procedure coverage is checked the same way.

## 2. Information architecture

Target Beacon Explorer tree. Existing ids are kept (they are pinned by
`tests/ui-audit-modules.json` and baselines); new leaves are marked **new**.

| beaconGroup   | module id               | purpose                                                                                       | phase |
| ------------- | ----------------------- | --------------------------------------------------------------------------------------------- | ----- |
| workspace     | `dashboard`             | fleet overview; gains pressure/admission strip, healer + supervisor tiles, alerts             | P0    |
| workspace     | `chat`                  | existing A/B chat                                                                             | —     |
| workspace     | `projects`              | existing; gains `projectGet` detail, `projectResolveRouting` explainer, routing journal chart | P1    |
| ops           | `ops-chat`              | Operator Console; gains tool browser (`opsChatTools`), audit explorer                         | P1    |
| ops           | `ops-sessions`          | existing; gains `opsSessionGet` detail + `opsSessionSearch`                                   | P1    |
| ops           | `plan`                  | existing planner                                                                              | —     |
| ops           | `workloads`             | existing ModelRun list; gains reconciler events, `nodeBudget` per node, enable/disable        | P0    |
| ops           | `workloads.model-runs`  | existing                                                                                      | —     |
| ops           | `workloads.model-hosts` | **new** — ModelHost (oMLX) status/start/stop                                                  | P1    |
| ops           | `workloads.node-runs`   | **new** — NodeRun manifests + `infra*` (build pin, packages, service units)                   | P2    |
| ops           | `workloads.composites`  | existing; gains dry-run topological preview, destroy w/ purge tier                            | P1    |
| ops           | `nodes`                 | existing; gains `nodeFacts`, `nodeBudget`, set-default, RAG/cloud/CLI bindings, tunnel state  | P0    |
| ops           | `fleet`                 | **new** — `fleetSnapshot`, pressure states, admission verdicts, migrations, fleet journal     | P1    |
| ops           | `healer`                | **new** — self-healing journal, proposals inbox, execute/refuse, severity gate                | P1    |
| ops           | `agents`                | **new** — agent binary/launchd status, update/rollback, rpc-server doctor, CLI bindings       | P2    |
| models        | `models.catalog`        | existing; gains `catalogStatus` drawer, `discover` (HF) tab, `recommendations`                | P1    |
| models        | `models.presets`        | existing promotions editor                                                                    | —     |
| models        | `models.pulls`          | existing; gains `autotuneAfterPull` stream                                                    | P2    |
| models        | `models.bench`          | existing; gains `benchShow`, `benchVisionRows`, eval leaderboard (§6.5)                       | P1    |
| models        | `models.lmstudio`       | existing; gains `lmstudioScan` preview                                                        | P2    |
| models        | `models.server`         | existing server/keep-alive; gains rpc-server panel, `resolveTarget` explainer                 | P1    |
| knowledge     | `knowledge.retrieval`   | existing; gains `ragSearch` playground + `ragDelete`                                          | P0    |
| knowledge     | `knowledge.pipelines`   | existing; gains `ragPipelineGet` YAML, `ragPipelineLogs`, `ragPipelineDraft` (LLM draft)      | P1    |
| observability | `logs`                  | existing server logs; gains `logsSearch`, cross-node fan-out                                  | P1    |
| observability | `cost`                  | existing guardian status/tail; gains `costSnapshot` chart, policy editor                      | P1    |
| observability | `journals`              | **new** — unified JSONL journal browser (ops-chat audit, healer, fleet, tunnel, routing, RAG) | P2    |
| observability | `caches`                | **new** — response cache + KV slot cache stats (needs §6.4)                                   | P3    |
| observability | `eval`                  | **new** — eval matrix leaderboard/report cards (needs §6.5)                                   | P3    |
| settings      | `settings`              | existing; gains redacted `env`, kubeconfig contexts (`ctx use`), diagnostics (`doctor`)       | P1    |
| hidden        | `ui-primitives`         | gallery                                                                                       | —     |

Global chrome additions: the command palette maps to every action below; the
activity rail shows a badge for pending healer proposals + Ops Chat approvals;
the status bar shows active node, pressure state of that node, reconciler
running flag, tunnel connectivity and IPC/SSE health.

## 3. Feature → UI mapping

Columns: feature; tRPC procedure(s); CLI / MCP equivalent it replaces; UI
element; action tier. `—` in the tRPC column means the feature has no
procedure today (see §6).

### 3.1 Nodes & fleet (P0–P1)

| feature                | tRPC                                                      | CLI / MCP                                          | UI                                                                                                            | tier                |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| node list              | `nodeList`                                                | `node ls`, `llamactl.node.ls`                      | table: name, kind (agent/gateway/provider/rag/cli), endpoint, fingerprint (short), tunnelPreferred, default ★ | read                |
| node detail            | `nodeFacts`, `nodeTest`, `nodeOpenAIConfig`               | `node test`, `llamactl.node.facts`                 | `node:<id>` tab: facts (OS, memory, GPU, llama.cpp build), OpenAI base URL + copy, health probe button        | read                |
| node budget            | `nodeBudget`                                              | `describe node`, `llamactl.node.budget`            | memory budget bar: total / reserved / per-workload stacked, admission headroom                                | read                |
| register agent node    | `nodeAdd`                                                 | `node add --bootstrap`, `llamactl.node.add`        | existing panel; add bootstrap-blob paste + fingerprint preview, `--force` toggle explained                    | dry-run-safe        |
| register cloud/gateway | `nodeAddCloud`                                            | `node add-cloud`, `sirius`, `embersynth`           | existing panel; api-key **ref** field only (env:/keychain:/file:), never a raw key                            | dry-run-safe        |
| register RAG node      | —                                                         | `node add-rag`                                     | form for provider/endpoint/collection/embedder/password-ref                                                   | dry-run-safe (§6.1) |
| update RAG binding     | `nodeUpdateRagBinding`                                    | —                                                  | existing embedder panel                                                                                       | dry-run-safe        |
| set default node       | `nodeSetDefault`                                          | `ctx use` / kubeconfig                             | ★ toggle in list; also NodeSelector "make default"                                                            | dry-run-safe        |
| remove node            | `nodeRemove`                                              | `node rm`, `llamactl.node.remove`                  | typed-name confirm; refuses `local`                                                                           | destructive         |
| LAN discovery          | `nodeDiscover`                                            | —                                                  | existing                                                                                                      | read                |
| fleet snapshot         | `fleetSnapshot`                                           | `fleet snapshot`, `fleet status`                   | **fleet** module: per-node pressure (nominal/elevated/critical), workloads, last tick; NodeMap colour-coded   | read                |
| fleet journal          | —                                                         | `fleet journal-tail --type`                        | timeline of migrations, leases, admissions, pressure transitions                                              | read (§6.2)         |
| admission check        | —                                                         | `admit`, `admit-measure`                           | "Will it fit?" calculator: model × ctx × kv quant → headroom verdict per node                                 | read (§6.2)         |
| migration controller   | —                                                         | `supervisor` flags                                 | controls: interval, auto tier, thresholds; proposal list with execute/refuse                                  | dry-run-safe (§6.2) |
| tunnel state           | —                                                         | `tunnel pin-central`, `agent serve --dial-central` | per-node chip (direct / via tunnel / unreachable) + tunnel journal tail                                       | read (§6.2)         |
| cross-node search      | `opsSessionSearch`, `logsSearch`, `globalSearchRagStatus` | —                                                  | ⌘K global search already fans out; add results panel with per-node partial-failure notes                      | read                |

### 3.2 Workloads: ModelRun, ModelHost, NodeRun, Composite (P0–P2)

| feature                  | tRPC                                                                                                                             | CLI / MCP                                       | UI                                                                                                                                                            | tier                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| list / describe          | `workloadList`, `workloadDescribe`, `workloadsDir`                                                                               | `get workloads`, `describe workload`            | existing rows; add phase legend (Running/Stopped/Mismatch/Unreachable/Foreign) and manifest ↔ live diff                                                       | read                                                 |
| apply                    | `workloadValidate`, `workloadTemplate`, `workloadApply`                                                                          | `apply -f`, `expose`, `llamactl.workload.apply` | existing apply panel; add dry-run diff (unchanged / restart / start), `--evict` picker, `--force`                                                             | dry-run-safe                                         |
| enable / disable         | — (CLI edits `spec.enabled` then applies)                                                                                        | `enable`, `disable`                             | toggle on row → `workloadApply` with patched YAML (client-side patch until §6.1 adds a procedure)                                                             | dry-run-safe                                         |
| delete                   | `workloadDelete`                                                                                                                 | `delete workload [--keep-running]`              | typed confirm; `keep-running` checkbox                                                                                                                        | destructive                                          |
| reconciler               | `reconcilerStatus`, `reconcilerEvents`, `reconcilerStart/Stop/Kick`                                                              | `controller serve`, `llamactl.reconciler.kick`  | existing controls; add **events timeline** (last 200), lock-file holder, interval editor                                                                      | dry-run-safe                                         |
| workers panel            | (part of `workloadDescribe`)                                                                                                     | —                                               | existing                                                                                                                                                      | read                                                 |
| ModelHost                | `modelHostStatus`, `modelHostStart`, `modelHostStop`                                                                             | `apply -f` (kind: ModelHost)                    | **model-hosts** module: engine (omlx), loaded models, KV tier stats; start streams events; stop                                                               | dry-run-safe                                         |
| NodeRun / infra          | `infraList`, `infraCurrent`, `infraInstall`, `infraActivate`, `infraUninstall`, `infraServiceWriteUnit`, `infraServiceLifecycle` | `infra *`, `apply -f` (kind: NodeRun)           | **node-runs** module: per-node package table (pkg, versions, active), install from tarball (sha256), activate, service unit editor + start/stop/reload/status | install/activate dry-run-safe; uninstall destructive |
| infra rollout / rollback | —                                                                                                                                | `infra rollout --strategy`, `infra rollback`    | wizard: pick nodes, strategy, health timeout; progress per node                                                                                               | dry-run-safe (§6.1)                                  |
| composite apply          | `compositeApply` (dryRun), `compositeList`, `compositeGet`                                                                       | `composite apply -f [--dry-run]`, `init`        | existing; render dry-run topological order + implied edges as a DAG before wet run; `init` templates as presets                                               | dry-run-safe                                         |
| composite status         | `compositeStatus`                                                                                                                | `composite status`                              | existing live event stream; add per-component phase chips + rollback markers                                                                                  | read                                                 |
| composite destroy        | `compositeDestroy`                                                                                                               | `composite destroy [--purge-volumes]`           | typed confirm; purge-volumes is a second checkbox with red copy (docker only)                                                                                 | destructive                                          |

### 3.3 Models: catalog, presets, pulls, bench, server (P0–P2)

| feature                      | tRPC                                                                                               | CLI / MCP                                       | UI                                                                                                            | tier                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| catalog list                 | `catalogList`                                                                                      | `catalog list`, `llamactl.catalog.list`         | existing table                                                                                                | read                       |
| catalog status               | `catalogStatus`                                                                                    | `catalog status <rel>`                          | drawer: membership, layered class resolution (catalog → HF pipeline → path pattern), quant, installed on disk | read                       |
| catalog add                  | —                                                                                                  | `catalog add`                                   | form deriving label/family/class; refuses duplicates                                                          | dry-run-safe (§6.1)        |
| discover (HF)                | `discover`                                                                                         | `discover [filter] [profile] [limit]`           | tab with filter chips (new/curated/reasoning/multimodal/fits-16g…) and "add as candidate" → pulls             | read                       |
| recommendations              | `recommendations`                                                                                  | `recommendations [profile]`                     | preset ladder per machine profile with promotion overlay + HF summary                                         | read                       |
| promotions                   | `promotions`, `promote`, `promoteDelete`                                                           | `catalog promote`, `llamactl.catalog.promote*`  | existing editor; deletion becomes destructive tier                                                            | dry-run-safe / destructive |
| pull file / candidate        | `pullFile`, `pullCandidate`, `candidateTestRun`, `autotuneAfterPull`                               | `pull`, `pull file`, `candidate test`           | existing cards; add autotune stream after pull, `--no-tune` toggle                                            | dry-run-safe               |
| uninstall                    | `uninstall`                                                                                        | `uninstall <rel> [--force]`                     | typed confirm; shows what gets pruned (mmproj, bench rows, catalog entry, promotions)                         | destructive                |
| bench                        | `benchPresetRun`, `benchVisionRun`, `benchHistory`, `benchCompare`, `benchShow`, `benchVisionRows` | `bench *`, `llamactl.bench.*`                   | existing; add "latest tuned record" card (`benchShow`), vision rows table, compare heat-map by class/scope    | read / dry-run-safe        |
| bench scheduler              | `benchSchedule*`, `benchScheduler*`                                                                | —                                               | existing panel                                                                                                | dry-run-safe               |
| eval matrix                  | —                                                                                                  | `eval run/report/leaderboard`                   | **eval** module: leaderboard, report card, run history (§6.5)                                                 | read (§6.5)                |
| server start/stop            | `serverStart`, `serverStop`, `serverStatus`, `resolveTarget`                                       | `server start/stop/status`, `llamactl.server.*` | existing; add "how `<target>` resolves" explainer chip (preset → promotion → rel)                             | dry-run-safe               |
| keep-alive                   | `keepAliveStart/Stop/Status`                                                                       | `keep-alive *`                                  | existing                                                                                                      | dry-run-safe               |
| rpc-server (tensor-parallel) | `rpcServerStatus`, `rpcServerDoctor`, `rpcServerStart`, `rpcServerStop`                            | `agent rpc-doctor`, docs/tensor-parallel.md     | panel in **models.server**: doctor verdict, start (host/port stream), stop with grace                         | dry-run-safe               |
| LM Studio import             | `lmstudioScan`, `lmstudioPlan`, `lmstudioImport`                                                   | `lmstudio scan/import`                          | existing; add scan-only table before plan                                                                     | dry-run-safe               |
| logs                         | `serverLogs`, `logsSearch`                                                                         | `server logs --follow`                          | existing; add search across nodes + jump-to-workload                                                          | read                       |

### 3.4 Knowledge: RAG nodes, pipelines, quality (P0–P1)

| feature              | tRPC                                                      | CLI / MCP                            | UI                                                                                                            | tier                |
| -------------------- | --------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| collections          | `ragListCollections`                                      | `llamactl.rag.listCollections`       | existing                                                                                                      | read                |
| search playground    | `ragSearch`                                               | `rag ask`, `llamactl.rag.search`     | query box, topK, collection; hits with score, doc id, snippet; "ask via" picks gateway + model → `chatStream` | read                |
| store                | `ragStore`                                                | `llamactl.rag.store`                 | existing indexing tab                                                                                         | dry-run-safe        |
| delete               | `ragDelete`                                               | `llamactl.rag.delete`                | per-hit / per-doc delete with typed confirm                                                                   | destructive         |
| pipelines list / run | `ragPipelineList`, `ragPipelineRunning`, `ragPipelineRun` | `rag pipeline list/run [--dry-run]`  | existing; show dry-run summary before wet                                                                     | dry-run-safe        |
| pipeline manifest    | `ragPipelineGet`, `ragPipelineApply`                      | `rag pipeline get/apply`             | YAML viewer/editor with schema validation                                                                     | dry-run-safe        |
| pipeline logs        | `ragPipelineLogs`                                         | `rag pipeline logs [--follow]`       | per-run journal table (chunks, duplicates, cost)                                                              | read                |
| LLM draft            | `ragPipelineDraft`                                        | `rag pipeline draft`                 | wizard step: describe → YAML + warnings                                                                       | read                |
| scheduler            | —                                                         | `rag pipeline scheduler [--once]`    | status/start/stop like bench scheduler                                                                        | dry-run-safe (§6.1) |
| quality (RagBench)   | `ragBench`                                                | `rag bench -f`, `llamactl.rag.bench` | existing; add history of hit-rate / MRR over time                                                             | read                |

### 3.5 Projects & routing (P1)

| feature           | tRPC                                           | CLI / MCP                                          | UI                                                                                    | tier                       |
| ----------------- | ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| list / get        | `projectList`, `projectGet`                    | `project list/get`, `llamactl.project.*`           | existing list; add `project:<name>` detail tab (manifest, RAG target, routes, budget) | read                       |
| apply / remove    | `projectApply`, `projectRemove`                | `project add/apply/remove`                         | existing; remove becomes typed confirm                                                | dry-run-safe / destructive |
| index             | `projectIndex`                                 | `project index`                                    | existing; show chunk counts + cost                                                    | dry-run-safe               |
| routing explainer | `projectResolveRouting`, `projectRoutePreview` | `project route`, `llamactl.project.resolveRouting` | "why this target" card: taskKind → rule → node/model, with fallbacks                  | read                       |
| routing journal   | `projectRoutingJournal`                        | —                                                  | existing tail; add per-taskKind distribution chart                                    | read                       |

### 3.6 Operator Console, sessions, planner (P1)

| feature               | tRPC                                                                                         | CLI / MCP                            | UI                                                                                                   | tier                        |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------- |
| chat / plan / execute | `operatorChatStream`, `operatorPlan`, `operatorRunTool`, `operatorSubmitStepOutcome`         | `plan run`, `llamactl.operator.plan` | existing proposal bubbles with tier cards                                                            | per tool                    |
| tool browser          | `opsChatTools`                                                                               | MCP `tools/list`                     | side panel listing every tool, tier, surfaces, input schema; "insert into prompt" and "run manually" | read                        |
| audit explorer        | `opsChatAuditTail`                                                                           | `tail audit.jsonl`                   | existing tail → filterable table (tool, tier, dryRun, ok, node, duration) with JSON drawer           | read                        |
| sessions              | `opsSessionList`, `opsSessionGet`, `opsSessionWatch`, `opsSessionDelete`, `opsSessionSearch` | —                                    | existing list; add detail (summary + recent events), live watch, search                              | read / destructive (delete) |
| executor picker       | `nodeList`, `nodeModels`                                                                     | `plan --model --base-url`            | existing                                                                                             | read                        |
| pipelines → MCP tool  | `pipelineExportMcp`, `chatStream`, `chatComplete`                                            | `~/.llamactl/mcp/pipelines/*.json`   | existing builder; add list of exported stubs with delete (needs §6.1)                                | dry-run-safe                |

### 3.7 Self-healing, runbooks, cost guardian (P1–P2)

| feature         | tRPC                                                    | CLI                                                           | UI                                                                                               | tier                                                         |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| healer journal  | —                                                       | `agent heal`, `~/.llamactl/healer/journal.jsonl`              | **healer** module: ticks, healthy↔unhealthy transitions, proposals, refusals, executions         | read (§6.3)                                                  |
| proposals inbox | —                                                       | `agent heal --execute <id>`                                   | pending proposals with plan steps, tier per step, `requiresConfirmation` flag; Execute / Dismiss | execute: destructive when any step is tier 3 (always manual) |
| loop controls   | —                                                       | `--interval --auto --severity-threshold --use-facade`         | status card + settings; auto mode shows the gate rule ("tier 3 always refused")                  | dry-run-safe (§6.3)                                          |
| runbooks        | —                                                       | `runbook <name> [--dry-run] [--params]`                       | runbook list with params form, dry-run output, then run                                          | dry-run-safe (§6.3)                                          |
| cost guardian   | `costGuardianStatus`, `costJournalTail`, `costSnapshot` | `cost-guardian tick/config/journal`, `llamactl.cost.snapshot` | existing; add snapshot chart (days), policy config viewer/editor, auto-tier flags                | read / dry-run-safe (config: §6.1)                           |

### 3.8 Agents, deployment, diagnostics (P2)

| feature             | tRPC                                        | CLI                                             | UI                                                                                                        | tier                                      |
| ------------------- | ------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| agent status        | `nodeFacts`, `env`                          | `agent status`                                  | **agents** module: per node — binary version, config path, advertised URL, launchd label/state            | read (§6.6 for launchd)                   |
| update / rollback   | — (HTTP `/agent/update`, `/agent/rollback`) | `agent update --from-release`, `agent rollback` | release picker (tag, SHA, cosign verified ✓), readiness timeout, per-node progress; rollback with `--key` | update dry-run-safe; rollback destructive |
| install-launchd     | local-only                                  | `agent install-launchd --dry-run`               | **copyable command builder** (scope, source, paths, env) — never executed from the UI                     | n/a                                       |
| init / rotate-token | local-only                                  | `agent init`, `agent rotate-token`              | copyable commands; the bootstrap blob is pasted into Nodes → register                                     | n/a                                       |
| artifacts           | local-only                                  | `artifacts build-agent/list/prune/verify-sig`   | copyable commands + list of artifacts if `artifacts list` gains a procedure                               | n/a                                       |
| CLI bindings doctor | —                                           | `agent cli doctor [--node]`                     | table of declared CLI subscription backends (claude-pro, codex-plus…) with probe result                   | read (§6.6)                               |
| doctor              | —                                           | `doctor [--skip …]`                             | **settings → Diagnostics**: agent / docker / kubernetes / secrets probes with ✓ ℹ ⚠ ✗                     | read (§6.6)                               |
| env                 | `env`                                       | `env --json`, `llamactl.env`                    | existing settings view; **redact** token/secret-looking values; copy as `--eval`                          | read                                      |
| kubeconfig contexts | —                                           | `ctx current/use/get/nodes`                     | context switcher in settings + title bar; YAML viewer with tokens redacted                                | dry-run-safe (§6.1)                       |
| deploy-node         | local-only                                  | `deploy-node --central-url --ttl`               | copyable command with generated install URL                                                               | n/a                                       |

### 3.9 Surfaces intentionally not exposed

- `agent serve`, `controller serve`, `supervisor`, `fleet aggregator serve`,
  `rag pipeline scheduler`, `keep-alive worker`: long-running daemons. The UI
  shows their status and offers start/stop where a procedure exists
  (reconciler, bench scheduler) but never runs them in-process.
- `artifacts build-agent`, `agent init`, `agent install-launchd`, `tunnel
pin-central`, `init` (composite quickstart) mutate the local filesystem /
  launchd / keychain of the machine running the CLI — rendered as copyable
  commands (§4).
- `/register`, `/install-agent.sh`, `/artifacts/*`, `/v1/chat/completions`,
  `/v1/models`, `/metrics`, `/tunnel`, `/tunnel-relay/*` on the agent HTTPS
  server: machine ingress. The UI links to `/metrics` and shows the OpenAI
  base URL, nothing more.
- `packages/train` corpora and adapters: not an operator surface until an
  eval/train procedure exists.
- Raw bearer tokens, API keys, kubeconfig `users[].token`: never rendered;
  refs (`env:`, `keychain:`, `file:`) are shown verbatim.

## 4. Cross-cutting UI patterns

Shared primitives the modules above need (implementation detail in the
integration plan):

1. **`useTieredAction`** — one hook wrapping a tRPC mutation with its tier:
   `read` runs; `mutation-dry-run-safe` runs `{dryRun: true}` first (when the
   procedure supports it) and shows a **DryRunPreview** (diff / plan / DAG)
   with a "Run for real" button; `mutation-destructive` opens
   **TypedConfirm** (type the target name; optional reason). Every run
   toasts and invalidates the keys the action declares.
2. **Audit passthrough** — actions with an Ops Chat tool call
   `operatorRunTool` instead of the raw mutation so the audit log stays one
   file; the hook takes `tool?: OpsChatToolName`.
3. **NodeScopeBar** — every module header shows the node the view addresses
   (active node, explicit pick, or `all` for reads) with the resolved
   endpoint kind (inproc / pinned HTTPS / tunnel).
4. **Live stream panel** — one `useTrpcSubscription(proc, input, {onEvent})`
   with buffered rendering, pause/scroll-lock, reconnect state and "copy as
   JSONL", reused by logs, server start, composite status, bench, pulls,
   model-host start, rpc-server start, healer, and ops sessions.
5. **JournalTable** — generic JSONL viewer (time, type, node, summary, JSON
   drawer, type filter, since) for ops-chat audit, healer, fleet, tunnel,
   routing, RAG pipeline and cost journals.
6. **ManifestEditor** — YAML editor with Zod validation via
   `workloadValidate` / composite / pipeline / project schemas, template
   picker, dry-run button.
7. **EntityLink** — `node:`, `workload:`, `composite:`, `project:`,
   `session:` chips that open the corresponding dynamic tab.
8. **CopyCommand** — renders a CLI invocation for local-only operations
   (§3.9) with the current node/context substituted.
9. **PhaseChip / TierChip / PressureChip** — status vocabulary shared with
   CLI output (Running/Stopped/Mismatch/Unreachable/Foreign; read /
   dry-run-safe / destructive; nominal/elevated/critical).
10. **Explainer cards** — "why" views for target resolution
    (`resolveTarget`), routing (`projectResolveRouting`), admission
    (`nodeBudget`), catalog class (`catalogStatus`).

## 5. Phasing

- **P0 (close cheap gaps, no remote changes)** — wire the 40 unused
  procedures that already exist: `nodeFacts`/`nodeBudget`/`nodeSetDefault`
  in Nodes; `fleetSnapshot` tiles on Dashboard; `reconcilerEvents`;
  `ragSearch`/`ragDelete`; `catalogStatus`/`discover`/`recommendations`;
  `benchShow`/`benchVisionRows`; `opsChatTools` tool browser;
  `opsSessionGet`; `projectGet`/`projectResolveRouting`; `costSnapshot`;
  `ragPipelineGet/Logs/Draft`; `lmstudioScan`; `resolveTarget`. Ship
  `useTieredAction` + `TypedConfirm` + `DryRunPreview` and route existing
  destructive mutations through them.
- **P1 (new modules on existing procedures)** — `fleet`, `workloads.model-hosts`,
  rpc-server panel, `logsSearch`/`opsSessionSearch` result panels, audit
  explorer, `JournalTable`. Plus the first remote additions: healer reader
  (§6.3), fleet journal/admission (§6.2), node add-rag / catalog add / RAG
  scheduler / kubeconfig context procedures (§6.1).
- **P2** — `healer` and `agents` modules, `workloads.node-runs` over `infra*`,
  `journals`, agent update/rollback via procedures, doctor/CLI-doctor
  procedures (§6.6), cost-guardian policy editor.
- **P3** — `caches` and `eval` modules (§6.4, §6.5), operator identity + UI
  action audit for multi-operator setups (§6.7), optional browser-served
  renderer (integration plan §8).

Each phase ends with: registry + `tests/ui-audit-modules.json` + baseline
PNG per new module, `bun run lint`, `bun run --cwd packages/app typecheck`,
`bun run audit:functional`, and the procedure-coverage test from the
integration plan showing zero unlisted procedures.

## 6. Remote / core gaps to close

Everything below is state or behaviour the CLI or a JSONL file can reach but
no tRPC procedure exposes. Per the hard rule: pure logic in `packages/core`
(or the owning package), procedure in `packages/remote/src/router.ts`, MCP
tool + Ops Chat dispatch entry where it is an operator surface.

### 6.1 CLI-only mutations that need procedures

| gap                       | today                                         | proposed procedure(s)                                                          |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| register RAG node         | `node add-rag` writes kubeconfig directly     | `nodeAddRag({name, provider, endpoint, collection?, embedder?, passwordRef?})` |
| enable / disable workload | CLI patches YAML then `apply`                 | `workloadSetEnabled({name, enabled})`                                          |
| catalog add               | `catalog add` appends custom TSV              | `catalogAdd({repo, file, label?, family?, class?, scope?})`                    |
| RAG pipeline scheduler    | `rag pipeline scheduler` CLI loop             | `ragSchedulerStatus`, `ragSchedulerStart/Stop/Kick`                            |
| kubeconfig contexts       | `ctx current/use/get`                         | `ctxList`, `ctxCurrent`, `ctxUse({name})`, `kubeconfigRedacted`                |
| MCP pipeline stubs        | files under `~/.llamactl/mcp/pipelines`       | `pipelineStubList`, `pipelineStubRemove({slug})`                               |
| infra rollout / rollback  | `infra rollout/rollback` orchestrate per node | `infraRollout` (subscription), `infraRollback`                                 |
| cost-guardian config      | `cost-guardian config` reads/writes policy    | `costGuardianConfig`, `costGuardianConfigSet`, `costGuardianTick({dryRun})`    |

### 6.2 Fleet supervisor

`packages/fleet-supervisor` holds pressure windows, admission verdicts,
migration proposals and its own journal; only `fleetSnapshot` (HTTP
`/v1/fleet/snapshot` + tRPC) is readable. Add `fleetJournalTail({type?,
limit, since?})`, `admitEvaluate({node, model, ctx, kvQuant})` (wrapping the
`admit` calculator), `supervisorStatus`, `supervisorProposals`,
`supervisorExecute({id})` / `supervisorRefuse({id})`, `tunnelStatus` and
`tunnelJournalTail`.

### 6.3 Self-healing and runbooks

`packages/agents` journals to `~/.llamactl/healer/journal.jsonl` and is
driven only by `agent heal`. Add `healerJournalTail`, `healerStatus`
(interval, auto, threshold, facade mode, last tick), `healerProposals`,
`healerExecute({proposalId})` (reusing the `--execute` path and its tier
gate — tier 3 stays refused server-side), `runbookList`, `runbookRun({name,
params, dryRun})` as a subscription.

### 6.4 Caches

`packages/core/src/responsecache` and `kvstore` keep SQLite state with no
reader. Add `responseCacheStats` (entries, size, hit/miss, schema version),
`responseCachePurge({olderThan?})` (destructive), `kvSlotCacheStats`,
`kvSlotCacheEvict({slot})`.

### 6.5 Eval matrix

`packages/eval` persists to SQLite and writes artifacts under
`$DEV_STORAGE/eval/<ts>/`. Add `evalLeaderboard({sortBy?})`,
`evalReport({model})`, `evalRuns`, and `evalRun` as a subscription (wet run
requires a node and a model; tier dry-run-safe with `--url` pointing at an
already-running server).

### 6.6 Diagnostics

`doctor`, `agent cli doctor`, `agent status` and launchd state are CLI-only.
Add `doctorRun({skip?})`, `cliBindingsDoctor`, `agentServiceStatus`
(launchd label/state/last exit when the agent was installed with
`install-launchd`), and `artifactsList`.

### 6.7 Operator identity and UI audit

`~/.llamactl/ops-chat/audit.jsonl` records tool runs but not _who_ clicked;
the app is single-user Electron with the kubeconfig bearer token. Before the
console is shared (tunnel/central or a browser build), add an `operator`
field to the audit line (OS user + hostname by default) and record direct UI
mutations that bypass `operatorRunTool`. This is the equivalent of Penumbra's
`operator_actions` prerequisite.

## 7. Additions beyond procedure mapping

Things a procedure-to-table mapping would miss but that the data already
supports:

- **Fleet map with pressure** — `NodeMap` already draws nodes; colour by
  `fleetSnapshot` pressure state, overlay `nodeBudget` headroom, and show
  migration arrows from the fleet journal.
- **Workload trace** — Composite → ModelRun/ModelHost → node → server status →
  logs → bench record → cost, as one drawer (all edges exist in
  `compositeGet`, `workloadDescribe`, `serverStatus`, `benchShow`,
  `costSnapshot`).
- **Apply diff** — `workloadValidate` + `workloadDescribe` give desired vs
  observed; render a real diff (rel, extraArgs, ctx, kv quant) with the
  reconciler's decision (unchanged / restart / start) before the wet run.
- **Bench heat-map** — `benchCompare` by class × scope × quant with the
  promotion ladder overlaid, replacing the flat table.
- **Routing explainer** — `projectResolveRouting` + `projectRoutePreview`
  side by side: rule matched, fallbacks skipped, node budget at decision.
- **Alerts center** — pressure transitions, healer proposals, reconciler
  failures, cost-guardian escalations, tunnel disconnects, aggregated from
  the journals into one rail badge and an Electron notification.
- **Cost analytics** — `costSnapshot` days-series with per-project and
  per-node breakdown, guardian decision markers.
- **Tier legend everywhere** — the same three chips the Operator Console
  uses on proposals appear on every action button so operators learn one
  vocabulary.

## 8. Coverage checklist

Definition of done for parity:

- Every procedure in `packages/remote/src/router.ts` is either referenced
  from `packages/app/src` or listed in an explicit `EXCLUDED_PROCEDURES`
  allowlist with a reason (machine-only, superseded). A test in
  `packages/app/test` introspects the router keys and greps the renderer
  source, failing on drift — the procedure-level twin of
  `ui-audit-modules-drift.test.ts`.
- Every `OPS_CHAT_TOOLS` entry has a UI action with the same tier.
- Every CLI verb in `packages/cli/src/bin.ts` is either mapped to a module
  above or listed in §3.9.
- Every JSONL journal under `~/.llamactl` has a `JournalTable` reader.
- Every new module has a registry entry, a `tests/ui-audit-modules.json`
  row, a baseline PNG and a `smokeAffordance`.
