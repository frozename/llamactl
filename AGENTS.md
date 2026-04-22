# AGENTS.md — llamactl

Agent instructions for any AI coding tool (Claude Code, Cursor,
Codex, Copilot) working in this repo. See `README.md` for the
user-facing overview.

## What this repo is

Local-first control plane for llama.cpp fleets. `kubectl`-style
verbs (apply / get / describe / delete) over `ModelRun` and `NodeRun`
manifests, plus imperative escape hatches, plus infra-deploy
(`kubeadm`-like agent install), plus an MCP surface and agentic
harnesses.

## Tech stack

- **Runtime**: Bun 1.3+. No node, no npm, no yarn, no pnpm.
- **TS**: 5.9+, NodeNext ESM, `.js` on import specifiers.
- **RPC**: tRPC v11 (shared router across Electron + agent HTTPS +
  in-proc `createCaller`). React Query v5.
- **Validation**: Zod 4.3+.
- **UI**: Electron + electron-trpc 1.0.0-alpha, React 19, Vite 7.
- **MCP SDK**: 1.29.0.
- **WebSocket**: Bun native (for the reverse tunnel in I.3).
- **Cross-repo dep**: `@nova/contracts`, `@nova/mcp-shared`, `@nova/mcp`
  via `file:../../../nova/packages/*`.

## Layout (what lives where)

```
packages/
├── core/       tRPC-adapter-free business logic. No HTTP, no tRPC
│               imports, no electron imports. Pure functions over
│               ResolvedEnv + process spawns.
├── cli/        Bun CLI entrypoint (`bin.ts`). Commands under
│               src/commands/. Every verb routes through
│               dispatcher.ts (local → createCaller, remote → NodeClient).
├── remote/     tRPC router + agent HTTPS mount + kubeconfig +
│               workload reconcilers + infra + tunnel. Shared by
│               cli + app + the agent.
├── app/        Electron. electron-trpc IPC; reads @llamactl/remote
│               for the router; renders with React 19. Ships the
│               Operator Console (N.4) which plans *and* executes
│               MCP tools with tiered approval cards, the N.4.5
│               Planner chat, A/B compare chat (K.2), Cost dashboard
│               (N.3.7), and the Pipelines builder + "Save as MCP
│               tool" exporter (K.6).
├── mcp/        @llamactl/mcp. Projects tRPC procedures as MCP tools.
│               18 native tools today across read + mutation (dry-run
│               + wet) tiers: catalog, node, bench (compare + history),
│               server, workload, promotions, env, cost.snapshot,
│               embersynth, operator.plan (multi-turn history, stub +
│               LLM modes). M.1 also auto-registers any
│               `~/.llamactl/mcp/pipelines/*.json` stub as
│               `llamactl.pipeline.<slug>` (emitted by the app's
│               Pipelines module via `pipelineExportMcp`).
└── agents/     Runbooks + self-healing loop + cost guardian + N.5
                demos. Multi-MCP harness boots @llamactl/mcp +
                @nova/mcp in-proc and routes by tool-name prefix.
                `demos/` holds four scripted narrated runs:
                demo-audit, demo-onboard, demo-failover, demo-cost-clamp.
```

**Hard rule**: `packages/core` stays adapter-free. If you need a new
feature, write the pure logic in core, then expose it through the
tRPC router in remote, then project through MCP in `packages/mcp` if
it's an operator surface.

## Commands

```bash
bun install
bun test                      # per-package bun:test suites
bun run typecheck             # core + cli; also run remote + app per-package
bun run --cwd packages/remote tsc --noEmit
bun run --cwd packages/app tsc --noEmit

bun packages/cli/src/bin.ts <verb> --help
zsh test/run-all.zsh          # full sweep with shell smoke tests

# Electron dev
cd packages/app && bun run dev
```

Never skip hooks. If a pre-commit hook fails, investigate — don't
`--no-verify`.

## Code style

- **No comments explaining WHAT.** The name says it. Comments are
  for WHY — workarounds, constraints, subtle invariants.
- **Short module headers** are fine and encouraged on non-obvious
  files.
- **No backwards-compat shims** when removing things. Delete
  entirely — the consumer is the same repo.
- **No new error-handling for things that can't happen**. Trust
  framework guarantees; validate at boundaries (CLI args, HTTP,
  manifest files), not in internal code.
- **Don't design for hypothetical future requirements.** Three
  similar lines beat a premature abstraction.

### Zod 4

- `z.record(z.string(), z.unknown())` — NOT `z.record(z.unknown())`.
- `z.object({...}).partial()` for forward-compat shapes; strict
  `z.record(EnumSchema, X)` forces all keys present (usually wrong).
- `z.discriminatedUnion` with explicit `z.literal` discriminators.

### tRPC v11

- `createTRPCClient` (not `createTRPCProxyClient` — that was v10).
- Subscriptions over SSE via `unstable_httpSubscriptionLink` +
  `splitLink` keyed on `op.type === 'subscription'`.
- `electron-trpc 1.0.0-alpha` — `exposeElectronTRPC` in preload,
  `ipcLink` in renderer.
- Bun lacks `EventSource` globally — subscribe paths need the
  `eventsource` ponyfill (`4.1.0`) with `{ withCredentials: false }`.

### Dispatcher pattern

Every CLI command that targets a node routes through
`packages/cli/src/dispatcher.ts`:

```ts
await runOp(nodeId, 'catalog.list', {});
await subscribeRemote(nodeId, 'pullFile', input, onEvent);
```

`local` is an in-proc `createCaller` shortcut; remote uses an HTTPS
`NodeClient` with pinned TLS + bearer auth.

**Never** bypass the dispatcher by importing `@llamactl/core`
directly from a CLI command. It breaks `--node gpu1` fan-out and
the `all` target.

## Workloads

- `ModelRun` — a model on a node with args. `apply`-able.
- `NodeRun` — desired infra stack on an agent (llama.cpp build
  pinned to a commit, optional sidecars).
- Gateway handlers (`packages/remote/src/workload/gateway-handlers/`)
  route `spec.gateway: true` by provider kind. Agent-gateway is a
  sentinel that falls through to regular `serverStart`; sirius +
  embersynth handlers each POST their respective `/reload` endpoint
  after confirming llamactl-side YAML state is coherent. Response
  translation: 2xx → Running, non-2xx → Failed with
  `*ReloadFailed`, upstream absent → Pending with an actionable
  reason. See handler JSDoc for the wire contract.

## Ops Chat dispatch (N.4)

`packages/remote/src/ops-chat/` maps 16 llamactl.* MCP tools onto
the matching tRPC procedures. The Operator Console renderer calls
`trpc.operatorRunTool({name, arguments, dryRun})` and the server
routes via `createCaller` — no secondary MCP server boot, no
duplicate surface. Adding a new MCP tool without wiring a dispatch
handler fails the
`packages/mcp/test/smoke.test.ts:ops-chat-coverage` assertion. Every
call (dry + wet, success + failure) appends one line to
`~/.llamactl/ops-chat/audit.jsonl`.

## Self-healing loop (`llamactl agent heal`, N.2)

Base usage:

```bash
llamactl agent heal [--interval <seconds>] [--once] [--quiet] [--journal <path>]
llamactl heal       [--interval <seconds>] [--once] [--quiet] [--journal <path>]
```

The canonical form is `llamactl agent heal`; `llamactl heal` is
preserved as a backwards-compat alias. Both dispatch paths share the
same flag parser.

Observes fleet health on an interval (default 30s), journals every
tick + every healthy↔unhealthy transition, and — as of N.2 —
plans + optionally executes remediation.

N.2 flags:

- `--use-facade` / `--no-use-facade` (default on) — health signal
  source. On: call `nova.ops.healthcheck` through an in-proc MCP
  client (same pattern runbooks use). Off: raw HTTP probes against
  gateway + provider baseUrls. Facade is the canonical path; the
  raw probe is retained as a fallback when nova-mcp can't boot, and
  fires automatically for the current tick if a facade call rejects
  or returns `isError`.
- `--auto` — enable auto-execution of remediation plans. Default is
  propose-only: on a healthy→unhealthy flip the loop asks
  `nova.operator.plan` for a remediation plan and appends a
  `proposal` entry to the journal. An operator applies it later via
  `--execute`.
- `--severity-threshold <1|2|3>` — max tier allowed in `--auto`
  mode (default 2). Tier 1 is read-only, tier 2 is mutation-safe,
  tier 3 is destructive. **Tier 3 is always refused regardless of
  threshold** — destructive remediation requires manual approval.
  Plans with `requiresConfirmation: true` are also refused.
- `--execute <proposal-id>` — one-shot: look up a previously
  journaled proposal by id, execute its plan through the N.1
  runbook harness, journal an `executed` entry, exit. Does not
  start a loop.

Remediation behavior: on a healthy→unhealthy transition the loop
calls `nova.operator.plan({goal})`, journals a `proposal` with a
content-hash id, and in `--auto` mode passes the plan through the
severity gate. If the gate allows, steps execute sequentially via
`runRunbook` (for known runbook names) or the raw in-proc tool
client (for raw MCP tool names), stopping at first failure. Every
outcome — proposal, refused, plan-failed, executed, step failure —
is journaled.

The journal at `~/.llamactl/healer/journal.jsonl` (override with
`--journal` or `LLAMACTL_HEALER_JOURNAL`) is the audit trail. Keep
it rotated; the loop appends, never truncates.

## Deploying agents

Two steps: build a single-file `llamactl-agent` binary, then install
it as a Launch service so it starts on boot and stays up.

### Build

```bash
bun run build:agent         # current platform
bun run build:agent:all     # all four supported platforms
```

Both call `llamactl artifacts build-agent` under the hood. The
binary lands at
`$DEV_STORAGE/artifacts/agent/<platform>/llamactl-agent` (or
`$LLAMACTL_ARTIFACTS_DIR` / `~/.llamactl/artifacts` depending on
which env var is set). `build:agent:all` cross-compiles all four
targets from macOS.

### Install (macOS)

`llamactl agent install-launchd` resolves a binary, renders a plist,
writes it to `~/Library/LaunchAgents/` (user scope) or
`/Library/LaunchDaemons/` (system scope), and loads it via
`launchctl`. The binary source is one of three mutually exclusive
flags; default is `--from-source`:

- `--binary=<path>` — use an existing binary at this path.
- `--from-release=<tag>` — fetch + SHA/cosign-verify a GitHub
  Release artifact into `--install-path`.
- `--from-source` — build locally via `artifacts build-agent` and
  copy the result into `--install-path`.

User scope example (home-lab Mac):

```sh
llamactl agent install-launchd --scope=user --from-source \
  --install-path=/usr/local/bin/llamactl-agent \
  --dir=$DEV_STORAGE/agent/mac-mini
```

System scope example (headless server, requires `sudo`):

```sh
sudo llamactl agent install-launchd --scope=system --from-release=v0.4.0 \
  --install-path=/usr/local/bin/llamactl-agent \
  --dir=/var/llamactl/agent
```

`--dry-run` prints the rendered plist + the launchctl plan without
touching disk. Always run it first on a new host to eyeball the
result before committing to disk writes + service load.

The plist's `EnvironmentVariables` block carries only non-secret
system vars (`PATH`, `DEV_STORAGE`, `HF_HOME`, `LLAMA_CPP_*`,
`HUGGINGFACE_HUB_CACHE`, `OLLAMA_MODELS`). The agent bearer token
stays on disk in `--dir` and never enters the plist.

### Full Disk Access (one-time GUI step)

When the agent needs to read certs or models from an external
volume (`/Volumes/…`), grant Full Disk Access to the installed
binary path via System Settings → Privacy & Security → Full Disk
Access → `+` → pick the installed binary. One grant per binary path
— the grant survives reinstalls at the same path. Processes spawned
by `launchd` do **not** inherit the Terminal's FDA grant, so this
step is required separately from any grant already given to Bun or
iTerm.

End-to-end walkthrough for a fresh Mac mini (clean-slate prep,
dotfiles, DEV_STORAGE split, agent init, install-launchd, FDA
grant, smoke tests): see `docs/deployment-mac-mini.md`.

For multi-node tensor-parallel workloads that shard one model
across several agents via `rpc-server`, see
`docs/tensor-parallel.md`.

For **RAG nodes** (vector stores / knowledge bases registered as a
new `kind: 'rag'` alongside agent/gateway/provider), see
`docs/rag-nodes.md`. v1 ships two backends — `chroma` (MCP-proxied
via chroma-mcp) and `pgvector` (native SQL against Postgres +
pgvector). Adapters implement a shared `RetrievalProvider` contract
from `@nova/contracts`; tRPC exposes `ragSearch` / `ragStore` /
`ragDelete` / `ragListCollections`; MCP mirrors the same surface as
`llamactl.rag.*`; the Electron activity bar surfaces them through
the Knowledge module.

For **RAG pipelines** (declarative ingestion — filesystem / http /
git sources → markdown-aware chunking → embed → store, with
dedupe, scheduling, and a 4-step Electron wizard), see
`docs/rag-pipelines.md`. `llamactl rag pipeline {apply, run, list,
get, rm, logs, scheduler, draft}` on the CLI; `llamactl.rag.
pipeline.*` on MCP; Knowledge → Pipelines tab in the Electron app.
Sources plug in via `packages/remote/src/rag/pipeline/fetchers/`;
transforms via `packages/remote/src/rag/pipeline/transforms/`.

For **Projects + routing policy** (the trifold local+cloud+
subscription-CLI orchestration lens — register a project dir,
auto-index its docs, declare per-task-kind routing targets across
all three lanes, journal every decision), see `docs/projects.md`.
`llamactl project {add, list, get, rm, index, route, apply}` on
the CLI; `llamactl.project.*` on ops-chat dispatch; Projects
module in the Electron activity bar. CLI subscription backends
(`claude -p` / `codex exec` / `gemini -p`) are declared as
`cli: []` bindings on agent nodes and synthesize as virtual
`<agent>.<cli>` provider-kind nodes.

For **Composites** (declarative multi-component infra — model +
gateway + RAG + supporting services applied as one atomic unit
with dependency DAG + rollback), see `docs/composites.md`.
`RuntimeBackend` interface in `packages/remote/src/runtime/` has
two implementations: Docker (v1 default, `runtime/docker/`) and
Kubernetes (`runtime/kubernetes/`, selectable per composite via
`spec.runtime: kubernetes` — see `docs/composites-kubernetes.md`).
The factory at `runtime/factory.ts` routes on the declared kind;
the router caches one backend per kind for the process lifetime.
`ServiceHandler` registry at `packages/remote/src/service/` covers
chroma, pgvector, and a generic-container escape hatch; add
handlers for new container kinds (nginx, redis, databases) the
same way gateway-handlers plug into `workload/gateway-handlers/`.
tRPC: `compositeApply` / `compositeDestroy` / `compositeList` /
`compositeGet` / `compositeStatus`. MCP: `llamactl.composite.*`.
Electron module: `Composites` (activity bar, `Boxes` icon) — YAML
editor + dry-run preview + Apply/Destroy, plus a Detail tab that
streams `compositeStatus` events. The editor is a plain textarea;
runtime selection happens by editing `spec.runtime:` in the
manifest (first-class picker is a UI follow-up). The planner
prefers `llamactl.composite.apply` over multi-step plans when
operators describe 3+ interacting components.

**K8s backend (Phase K8s-1 through K8s-7 shipped) — opt-in by
design**: the backend is fully implemented + tested, but nothing
about llamactl's onboarding *requires* a cluster. Docker is the
default runtime everywhere. K8s becomes active when either:

  - `spec.runtime: kubernetes` is set on a composite manifest, or
  - `LLAMACTL_RUNTIME_BACKEND=kubernetes` is exported in the env.

The `@kubernetes/client-node` dep is installed unconditionally
but lazy-loaded — nothing talks to a cluster until the first
composite apply with k8s runtime fires. `llamactl doctor`
demotes k8s "kubeconfig absent / unreachable" to `info` unless
intent is detected; `llamactl init` auto-detect picks docker
silently when k8s doesn't answer. Skip the probe entirely with
`llamactl doctor --skip=kubernetes`.

Implementation: namespace-per-composite (`llamactl-<name>`),
Deployment for stateless services (chroma, generic) and
StatefulSet + headless Service + `-client` ClusterIP +
volumeClaimTemplates for stateful (pgvector). All resources stamp
Helm common-labels (`app.kubernetes.io/*`) + llamactl-namespaced
labels (`llamactl.io/composite/component`); drift detection uses
the `llamactl.io/spec-hash` annotation. Secrets map to
`v1.Secret` + `secretKeyRef` so values never land in the pod
spec. Destroy short-circuits through
`backend.destroyCompositeBoundary` — a single `DELETE namespace`
that cascades via k8s GC. Workloads (llama-server) still ride
the agent path; running them as k8s Deployments is a
multi-quarter follow-up. Opt-in E2E at
`packages/remote/test/composite-e2e.test.ts` behind
`LLAMACTL_COMPOSITE_E2E_K8S=1` + reachable cluster.

## Cost guardian (`llamactl cost-guardian`, N.3)

Base usage:

```bash
llamactl cost-guardian tick [--config=<path>] [--journal=<path>] [--skip-journal]
```

Each tick calls `nova.ops.cost.snapshot`, runs the pure tier state
machine (noop / warn / force_private / deregister), journals the
decision, and prints it. Config is read from
`~/.llamactl/cost-guardian.yaml` (override: `--config` or
`LLAMACTL_COST_GUARDIAN_CONFIG`).

Auto-execution flags:

- `--auto` — equivalent to `--auto-tier-2 --auto-tier-3`. Enables
  both mutation-tier wet-runs.
- `--auto-tier-2` — overrides `config.auto_force_private` to true.
  When on, a successful tier-2 dry-run preview is followed in the
  same tick by a wet-run call to
  `llamactl.embersynth.set-default-profile` (profile
  `private-first`).
- `--auto-tier-3` — overrides `config.auto_deregister` to true.
  When on, a successful tier-3 dry-run preview is followed in the
  same tick by a wet-run call to `sirius.providers.deregister`,
  unless the target provider's name appears in
  `config.protectedProviders` (default `['fleet-internal']`).

Behavior: every tick journals a dry-run preview before anything
irreversible happens. The auto flags gate whether the matching
wet-run follows. The tier-3 denylist always refuses regardless of
flag state — matching names journal a
`deregister-refused` entry with `reason: 'provider-protected'`.
A failed tier-2 wet-run stops the same tick — no tier-3 escalation
follows a tier-2 failure in a single tick.

The cost journal at `~/.llamactl/healer/cost-journal.jsonl`
(override with `--journal` or `LLAMACTL_COST_JOURNAL`) captures
every decision, preview, wet-run outcome, refusal, and failure.

## Reverse tunnel (I.3)

**When to use** — a node is behind NAT with no port forward, or
the fleet spans cloud + home lab and direct HTTPS from the CLI to
the NAT'd node won't work.

**Topology** — two roles:

- **Central** — an agent on a host the CLI can reach directly.
  Mounts a `/tunnel` WebSocket endpoint that dialing nodes connect
  to, plus a `/tunnel-relay/<nodeName>` HTTP bridge the CLI POSTs
  into.
- **Dialing node** — an agent behind NAT that opens an outbound
  WSS to a central and carries its tRPC router across the tunnel.

A single agent can be both (central for NAT'd siblings while
itself dialing another central). Typical setup is one central on
the operator's reachable machine + N nodes dialing in.

**Flags**:

- *On central*: no CLI flag today. The tunnel server is wired
  programmatically via `startAgentServer({ tunnelCentral: { port,
  expectedBearerHash, onNodeConnect?, onNodeDisconnect? } })` in
  `packages/remote/src/server/serve.ts`. An operator that wants to
  run an agent in central mode must script the boot path (or
  extend `agent serve` with a matching flag in a follow-up slice).
- *On dialing node* — `llamactl agent serve`:
  - `--dial-central=<wss-url>` — the central's `/tunnel` URL.
  - `--central-bearer=<token>` — tunnel bearer (or set
    `LLAMACTL_TUNNEL_BEARER` so it stays out of the command line).
  - `--tunnel-node-name=<name>` — identity presented in the hello
    frame; defaults to the agent's `nodeName`.
- *In kubeconfig*: mark a node with `tunnelPreferred: true` and
  set the context's `tunnelCentralUrl` to the local central's URL.
  The dispatcher then POSTs `tunnelCentralUrl/tunnel-relay/<node>`
  instead of talking to the node directly.

**Security model** — two distinct bearers, intentionally separate
so operators can rotate tunnel access without touching the main
agent bearer:

- The **tunnel bearer** — the raw token is passed on the dialing
  side as `--central-bearer`; its hash is configured on the
  central as `expectedBearerHash`. Presented in the first WS
  hello frame; guards the inbound `/tunnel` WS upgrade only.
- The **agent bearer** — standard kubeconfig user token. Guards
  `/trpc`, `/tunnel-relay/*`, and every other HTTP route on the
  agent. The CLI uses this for relay POSTs.

**Audit trail** — the tunnel server's state transitions log to
stderr on the agent (e.g. `tunnel: ready`, `tunnel: disconnected`)
via the `onStateChange` callback wired by `agent serve`. No JSONL
journal today; add one in a future slice if operators need
offline audit.

**Known gaps**:

- Subscriptions (streaming tRPC) aren't supported over the tunnel
  yet — the tunneled path rejects them with a "not supported yet"
  error. Use direct HTTPS for streaming ops.
- Fingerprint pinning over the tunnel-relay HTTP call isn't
  implemented — rely on TLS on the central agent's
  `/tunnel-relay` endpoint and trust the system CA.

## Testing

- `bun:test` everywhere.
- Use `makeTempRuntime` + `envForTemp` in
  `packages/core/test/helpers.ts` for any test that writes state
  under `$DEV_STORAGE`.
- Multi-node integration tests use `makeCluster({ nodes: N })` in
  `packages/remote/test/helpers.ts` — real Bun agents on random
  127.0.0.1 ports.
- Fake `llama-server` binary pattern (see
  `packages/core/test/server.test.ts`): a shell script on `$PATH`
  that mimics just enough of the real binary's behaviour. Reuse
  that; don't mock `Bun.spawn`.
- Use `InMemoryTransport.createLinkedPair()` for MCP smoke tests.
  No subprocess needed.

### Test profiles for hermetic audits

Set `LLAMACTL_TEST_PROFILE=<dir>` to reroot every AI-model / runtime /
cache path under one prefix. Designed for repeatable UI audits and CI
runs where the operator's real `$DEV_STORAGE` and llama-server would
otherwise bleed through.

When `$LLAMACTL_TEST_PROFILE` is set the resolver applies these
defaults — any individually-set env var still wins:

| Env var                 | Default value                                       |
|-------------------------|-----------------------------------------------------|
| `DEV_STORAGE`           | `$LLAMACTL_TEST_PROFILE`                            |
| `LOCAL_AI_RUNTIME_DIR`  | `$LLAMACTL_TEST_PROFILE/ai-models/local-ai`         |
| `LLAMA_CPP_ROOT`        | `$LLAMACTL_TEST_PROFILE/ai-models/llama.cpp`        |
| `LLAMA_CPP_MODELS`      | `$LLAMA_CPP_ROOT/models`                            |
| `LLAMA_CPP_CACHE`       | `$LLAMA_CPP_ROOT/.cache`                            |
| `LLAMA_CPP_LOGS`        | `$LLAMACTL_TEST_PROFILE/logs/llama.cpp`             |
| `LLAMA_CPP_BIN`         | `$LLAMACTL_TEST_PROFILE/bin` (empty dir)            |
| `HF_HOME`               | `$LLAMACTL_TEST_PROFILE/cache/huggingface`          |
| `HUGGINGFACE_HUB_CACHE` | `$HF_HOME/hub`                                      |
| `OLLAMA_MODELS`         | `$LLAMACTL_TEST_PROFILE/ai-models/ollama`           |
| `LLAMA_CPP_HOST`        | `127.0.0.1` (constant — no real interface bind)     |
| `LLAMA_CPP_PORT`        | `65534` (sentinel — nothing listens; Logs/Server surface "offline") |

Both the TypeScript resolver (`packages/core/src/env.ts`) and the
shell fallback cascade (`shell/env.zsh`) honour the same priority
order: individual env var > `$LLAMACTL_TEST_PROFILE` default >
production default.

Example — hermetic UI audit:

```sh
LLAMACTL_TEST_PROFILE="$(mktemp -d -t llamactl-audit)" \
  bun run tests/ui-audit-driver-v2.ts --executable=<path>
```

Unset `LLAMACTL_TEST_PROFILE` (or pass the empty string) for normal
production behaviour — zero change for users that do not opt in.

### UI regression gate

Every PR + push to `main` runs a pixel-diff gate over the 16 top-level
Electron modules against baselines at `tests/ui-audit-baselines/`. See
[`docs/ui-audit.md`](./docs/ui-audit.md) — covers how to handle
failures, reseed baselines after intentional UI changes
(`bun run audit:update`), and run the gate locally (`bun run audit`).

## Secret references

Every `apiKeyRef`, `User.tokenRef`, and `RagBinding.auth.tokenRef`
flows through a unified resolver in
`packages/remote/src/config/secret.ts`. Four reference syntaxes are
supported everywhere:

- `env:VAR_NAME` or `$VAR_NAME` — read from `process.env`
- `keychain:service/account` — read macOS Keychain via
  `/usr/bin/security find-generic-password -w`. macOS only; the
  resolver throws a clear platform error on other hosts.
- `file:/abs/path` or `file:~/home-relative` — read file contents
- legacy bare `/abs/path` or `~/home-relative` — same as `file:`

Values are trimmed on read. The resolver's error messages name what
couldn't be found without echoing the value itself. Add new backends
(Vault, k8s Secret) by extending `classify()` + adding a
`resolveX(body, ctx)` helper — existing call sites inherit the
backend for free via `resolveSecret(ref, env)`.

## Cross-repo discipline

**After a non-trivial slice, verify four repos still green:**

```bash
# llamactl
bun test

# nova
(cd ../nova && bun test)

# sirius-gateway
(cd ../sirius-gateway && bun test)

# embersynth
(cd ../embersynth && bun test)
```

If the slice touched `@nova/*`, also run `bun install` in every
consumer before their test run.

Test counts we expect as a baseline (bump as features ship):

- nova ≥ 157, llamactl ≥ 736, sirius ≥ 262, embersynth ≥ 152.

Four repos green = slice shippable.

## Phase M status (MCP surface across the fleet)

- **M.1 `@llamactl/mcp`** — shipped. 18 tools + M.1 pipeline pickup
  (`~/.llamactl/mcp/pipelines/*.json` → `llamactl.pipeline.<slug>`).
- **M.2 `@sirius/mcp`** — shipped. `sirius.providers.list`,
  `.models.list`, `.providers.deregister` (dry-run), `.health.all`.
- **M.3 `@embersynth/mcp`** — shipped. 10 tools: `config.show`,
  `nodes.list`, `nodes.inspect`, `profiles.list`, `profiles.inspect`,
  `synthetic.list`, `route.simulate`, `health.all`, `evidence.tail`,
  `reload` (dry-run previews a diff; wet-run appends one audit
  entry). Source: `embersynth/src/mcp/server.ts`.
- **M.4 `@nova/mcp` facade** — shipped. The facade loads
  `~/.llamactl/nova-mcp.yaml` (override via `NOVA_MCP_CONFIG`), boots
  an MCP `Client` per downstream (stdio or HTTP), and re-exposes the
  flat union of every downstream tool under its original namespace
  (`llamactl.*` / `sirius.*` / `embersynth.*`). On top of that, five
  native tools live on the facade: `nova.ops.overview`,
  `nova.ops.healthcheck`, `nova.ops.cost.snapshot`,
  `nova.operator.plan`, and `nova.models.list` (merged catalog across
  the three downstreams, first-wins dedupe with
  `alsoAvailableIn`/`provenance`). Boot-time snapshot only — a
  downstream restart needs a facade restart. Full config shape and
  facade patterns live in `/Volumes/WorkSSD/repos/personal/nova/AGENTS.md`.

## Commit discipline

- One slice per commit — don't bundle a feature + an unrelated
  refactor.
- Never include "Co-Authored-By" lines or tool attribution. Write
  commits as if authored by a careful human.
- Never `git commit --amend` on a pushed commit.
- Never `--no-verify` unless the user asks.
- Run full test sweep before committing.

## Planning a slice

For anything non-trivial, write a plan first. Plans live under
`~/.claude/plans/<slug>.md`. A plan describes:

- The problem in one paragraph.
- Decision table (question / options / recommendation).
- Architecture diagram (text).
- Schema / interface definitions.
- Test surface.
- Risks + mitigations.
- Recommended sprint sequence (the slice cuts).

Then ship one sprint slice at a time, each ending in a passing
cross-repo test sweep + a commit.

## What to avoid

- Committing to `packages/core` anything that imports from
  `packages/remote`, `packages/app`, `tRPC`, `electron-trpc`, or
  MCP. Core is the base of the dependency DAG.
- Rewriting Nova schemas in llamactl. Bump Nova, `bun install` here.
- Force-pushes to `main`.
- `z.record(z.unknown())` (Zod 3 idiom — compile error in Zod 4).
- Adding long docstrings to every function. Write one-line module
  headers where context earns it; skip the rest.
- Creating `.md` files the user didn't ask for (plan docs, status
  reports, etc. stay in conversation or in `~/.claude/plans/`).

## CLI skeleton (when adding a new verb)

1. Add logic in `packages/core/src/`.
2. Expose as a tRPC procedure in `packages/remote/src/router.ts`.
3. Add a CLI command in `packages/cli/src/commands/<verb>.ts`
   routing through `dispatcher.runOp`.
4. Register in `packages/cli/src/bin.ts`.
5. Optional: project to MCP in `packages/mcp/src/server.ts`.
6. Optional: a runbook or healer hook in `packages/agents/`.
7. Tests at every layer (core, remote, cli, mcp).

## Design docs

`~/.claude/plans/` holds the roadmap + per-phase design docs:

- `radiant-converging-knuth.md` — overall roadmap.
- `infra-deployment-kubeadm.md` — I-α / I-β / I.4.
- `infra-reverse-tunnel.md` — I.3.
- `infra-supply-chain.md` — I.5 (release + cosign).
- `cost-guardian.md` — N.3.
- `operator-plan-llm.md` — N.4.
- `gateway-workload-substantive.md` — K.7.
