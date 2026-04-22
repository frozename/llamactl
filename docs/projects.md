# Projects — declarative local-project + routing-policy

A **Project** in llamactl is a filesystem directory (your dev repo,
your docs tree, a research codebase) that llamactl knows about. Once
registered, it becomes a first-class lane across the stack: the RAG
pipeline that indexes its docs is one command away, chat + bench +
ops-chat can scope to its context, and every task kind it declares
maps to a specific routing target (local agent / subscription CLI /
cloud API) with optional cost budgets. The whole point: make the
"local + cloud" orchestration sentence from llamactl's endgame vision
concrete against a specific codebase, instead of a fleet-wide default.

Each project's policy is a single YAML manifest. llamactl persists
them in `~/.llamactl/projects.yaml` — the `sirius-providers.yaml` /
`embersynth.yaml` pattern — so versioning the file keeps you
reproducible across machines.

For the CLI subscription backends (`claude -p` / `codex exec` / `gemini
-p`) that projects can route to, see the [CLI bindings](#cli-subscription-backends)
section below. For the ingestion half of the RAG story see
[`docs/rag-pipelines.md`](./rag-pipelines.md); this doc is about the
operator-project surface that sits on top.

---

## When to use it

Reach for a project when you want:

- **One command to bring a repo into llamactl.** `llamactl project
  add X --path Y --rag-node kb-pg --rag-collection Y_docs` registers
  the project; `llamactl project index X` runs the auto-generated
  RAG pipeline; `llamactl project route X quick_qna` previews where
  a chat against `project:X/quick_qna` would land.
- **Per-project routing policy.** Different projects want different
  lanes. A security-sensitive project pins everything to local; a
  docs-Q&A project routes through Claude Pro subscription; a
  research project uses top-of-the-line API for deep synthesis.
  Project manifests make that policy explicit, not a tribal
  convention.
- **Cost visibility scoped to the work.** Per-project budgets (v1
  captures the declared ceiling; enforcement against cost-guardian
  snapshots is a follow-up) let operators see "my NovaFlow work
  cost $0.04 today" separately from cluster-wide spend.
- **A clean cockpit surface.** Electron's Projects module lists
  every registered project with its policy + recent routing
  decisions, so "where did my last chat go" has an obvious answer.

Stick to plain `llamactl chat --via <node>` for one-off calls that
don't have a project context.

---

## Prerequisites

- **A rag node** the project will index into (see
  `docs/rag-nodes.md`). If the project doesn't need RAG, omit
  `spec.rag` — the project still carries its routing policy and
  `project index` just becomes a no-op.
- **At least one routing target** declared in `spec.routing`. Empty
  `routing: {}` is valid — the resolver falls back to
  `private-first` (the embersynth `private-first` profile) for
  every task kind.
- **Disk.** Projects live in
  `$LLAMACTL_PROJECTS_FILE || ~/.llamactl/projects.yaml`.
  Routing-decision journal lives in
  `$LLAMACTL_PROJECT_ROUTING_JOURNAL || ~/.llamactl/project-routing.jsonl`.

---

## Anatomy of a manifest

```yaml
apiVersion: llamactl/v1
kind: Project
metadata:
  name: novaflow
spec:
  path: /Users/alex/DevStorage/repos/work/novaflow   # absolute; validated as non-empty
  purpose: "at-home diagnostic services platform"    # free-form; injected into chat system prompt
  stack: [nestjs, nextjs, prisma, bullmq]            # informational tags

  rag:
    node: kb-pg                                       # any kind: 'rag' node in kubeconfig
    collection: novaflow_docs
    docsGlob: "**/*.md"                               # default docs/**/*.md
    schedule: "@daily"                                # optional cadence via the pipeline scheduler

  routing:
    quick_qna:      private-first                     # local agents via embersynth
    code_review:    mac-mini.claude-pro               # CLI subscription lane (Phase 1)
    deep_analysis:  sirius.anthropic                  # cloud API via sirius
    image:          sirius.openai                     # cloud API with vision

  budget:
    usd_per_day: 2.00                                 # soft cap; over-budget flips routing
    cli_calls_per_day:                                # per-subscription call tracking
      claude-pro: 300
      codex-plus: 200
```

Every field except `metadata.name` + `spec.path` is optional.
`spec.routing` defaults to `{}` (everything falls back to
`private-first`). `spec.rag` is omitted when the project doesn't
need retrieval. `spec.budget` is optional; USD enforcement against
cost-guardian snapshots lands in a follow-up slice — the field is
declared today so the manifest is forward-compatible.

---

## Routing-target grammar

The right-hand side of each `routing:` entry is a string. llamactl
recognizes several shapes:

- **Bare node name**: `mac-mini`, `kb-pg`, `sirius`. Routes to that
  node directly. Useful for a single-hop target.
- **Dotted gateway/provider**: `sirius.openai`,
  `llamactl-embersynth.fusion-auto`. Routes via the parent gateway
  fanned out by `sirius-providers.yaml` or `embersynth.yaml`. See
  [convergence strategy](../AGENTS.md) for which gateway contributes
  which leaves.
- **Dotted agent/cli-binding**: `mac-mini.claude-pro`,
  `laptop.gemini-free`. Routes via the CLI subscription backend
  declared on the hosting agent (Phase 1 of this plan — see
  [CLI bindings](#cli-subscription-backends)).
- **Embersynth profile id**: `private-first`, `fusion-auto`,
  `fusion-vision`. Routes to the embersynth gateway with that
  synthetic model; embersynth's internal profile picker does the
  node selection. `private-first` is the operator-safe default
  fallback.

Unknown task kinds fall back to `private-first`. Typo'd strings
error cleanly at apply time (zod rejects empty routing values
silently by default; the resolver then returns a
`fallback-default` decision with `target: 'private-first'`).

---

## CLI subscription backends

Declared per-agent via `spec.cli[]` on a kubeconfig agent node.
Example agent node block:

```yaml
clusters:
  - name: home
    nodes:
      - name: mac-mini
        endpoint: https://mac-mini.lan:7843
        kind: agent
        cli:
          - name: claude-pro           # becomes mac-mini.claude-pro
            preset: claude             # canned argv + stream: true
            subscription: claude-pro-alex
            advertisedModels: [claude-sonnet-4-5]
            defaultModel: claude-sonnet-4-5
            capabilities: [reasoning]
            timeoutMs: 120000
          - name: gemini-free
            preset: gemini
```

Probe every binding:

```sh
llamactl agent cli doctor           # exit 2 on any unhealthy binding
llamactl agent cli doctor --node mac-mini
llamactl agent cli doctor --json
```

Each binding synthesizes as a virtual `kind: 'provider'` node named
`<agent>.<cli>` — first-class in every routing decision. The
subprocess runs on the agent's machine (where the CLI is logged in),
never on the control plane; dispatcher routes traffic to the agent
via its HTTPS tRPC surface and the agent spawns the CLI locally.

v1 presets: `claude` (streaming), `codex`, `gemini`, plus `custom`
for anything else. `custom` requires operator-supplied `command` +
`args`.

USD cost for subscription calls is flat-fee — llamactl tracks
**calls** + **prompt/response bytes** in
`$LLAMACTL_CLI_JOURNAL_DIR/<YYYY-MM-DD>.jsonl` so
cost-guardian can surface "how hard are you pounding your
subscription" without inventing a dollar price.

---

## The CLI

```sh
# Register
llamactl project add novaflow \
  --path ~/DevStorage/repos/work/novaflow \
  --rag-node kb-pg \
  --rag-collection novaflow_docs

# Enumerate + per-project lookup
llamactl project list
llamactl project get novaflow
llamactl project get novaflow --json

# Index the RAG pipeline (requires spec.rag)
llamactl project index novaflow

# Preview routing — READ-ONLY, no journal write, no chat fire
llamactl project route novaflow quick_qna
llamactl project route novaflow code_review --json

# Remove — does NOT touch indexed data in the rag node
llamactl project rm novaflow
```

Project applies support stdin, matching `rag pipeline apply`:

```sh
cat novaflow.yaml | llamactl project apply -f -
```

---

## Electron Projects module

Click the folder-kanban icon in the activity bar. Each registered
project gets a row with:

- **Name + path** (click the name to open the detail card).
- **RAG binding** — `<node>/<collection>` or "no rag block".
- **Routing policy heatmap** — one badge per task kind →
  declared target.
- **Actions** — `Index` (disabled when `spec.rag` is absent),
  `Detail`.

Detail card (opened by clicking the row):

- Full manifest YAML (read-only).
- Routing-policy table: declared target + live-resolved target per
  task kind. The "Resolved (live)" column calls the
  `projectRoutePreview` tRPC procedure so operators see exactly
  where dispatch would route *right now*, including budget
  overrides when they eventually land.
- Live routing-decision feed (2s poll on `projectRoutingJournal`)
  showing recent `project:<name>/<taskKind>` chat calls: elapsed
  time, task kind, resolved target, reason badge
  (matched / fallback-default / project-not-found / over-budget).
- Remove button (dialog-confirmed; doesn't touch indexed data).

---

## Troubleshooting

- **"project 'X' not found"** from `project route` → run
  `llamactl project list` to confirm the name. Project names come
  from `metadata.name` (which defaults to the `project add <name>`
  argument, not the directory basename).
- **"no rag block declared"** from `project index` →
  `spec.rag.{node,collection}` is required. Edit the manifest
  directly at `~/.llamactl/projects.yaml` or re-run
  `project add` with `--rag-node` + `--rag-collection`.
- **`project:<name>/<taskKind>` chat call returns `private-first`
  unexpectedly** → check the decision journal:
  ```sh
  tail -f ~/.llamactl/project-routing.jsonl
  ```
  The `reason` field tells you why. Common cases:
  `fallback-default` means the task kind isn't in `spec.routing`;
  `project-not-found` means a stale project name;
  `over-budget` means the daily USD ceiling was hit (when enforced).
- **CLI binding reports unhealthy** in `llamactl agent cli doctor`
  → the CLI probably isn't logged in on that machine. Most
  presets' `--version` probe works even when logged out, so an
  unhealthy result typically means the binary is missing from
  `$PATH`. SSH onto the agent's machine + run the CLI by hand.
- **`project index` stalls** → the underlying pipeline run is
  probably waiting on a slow embedder. Check
  `llamactl rag pipeline logs project-<name>` for live journal
  entries; the pipeline's own timeout + error-handling apply.
- **Cost-guardian says no spend but I see CLI calls** → CLI
  subscription calls land in `$LLAMACTL_CLI_JOURNAL_DIR` as
  byte-counts, not USD. Integration with cost-guardian's dollar
  snapshot is a follow-up slice.

---

## Roadmap (not in v1)

- **Budget enforcement.** The `budget.usd_per_day` field is
  declared but enforcement against cost-guardian's
  `nova.ops.cost.snapshot` MCP roundtrip is a follow-up. The
  resolver ships with a pluggable `checkBudget` hook that just
  no-ops today.
- **Per-project `UsageRecord` attribution.** Phase 3 packs
  `project:<name>/<taskKind>/<target>` into
  `UsageRecord.route`, but the router hasn't been taught to
  stamp it on outbound writes yet. A cross-repo commit adds
  optional `project?` + `subscription?` fields on
  `UsageRecordSchema` in `@nova/contracts`.
- **Multi-stage routing** (`pipeline:<name>` target) — chain a
  local summarizer → subscription-CLI review → cloud-API final
  pass as one task kind.
- **Open-Chat deep-link.** Projects already integrate with the
  Chat module indirectly (the renderer can pick
  `project:<name>/<taskKind>` as a node); the one-click
  "Open Chat" shortcut on a project row is a small UX
  follow-up once the Chat module's node picker gains a
  project-selector.
- **Live budget visualization** in the Electron detail page —
  replaces the "declared-only" budget display once cost-guardian
  snapshots are wired.
