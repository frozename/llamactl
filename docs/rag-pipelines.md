# RAG Pipelines — declarative ingestion for knowledge bases

A **RagPipeline** is a manifest that declares *how documents get into
a RAG node*: where to pull them from, how to chunk them, and which
collection to land them in. `llamactl rag pipeline apply -f …` persists
the manifest to disk; `llamactl rag pipeline run <name>` walks the
sources, runs the transforms, embeds each chunk, and stores the
results in the declared destination. Everything is auditable via a
per-pipeline JSONL journal; re-runs are dedupe-aware so unchanged
documents are never re-embedded.

For the retrieval side of the story (RAG *nodes* themselves — chroma
and pgvector backends), see [`docs/rag-nodes.md`](./rag-nodes.md).
This doc is the upstream half: getting content *into* those nodes.

---

## When to use it

Reach for a pipeline when you want ingestion to be:

- **Declarative.** The YAML manifest is the single source of truth.
  Re-apply + re-run is the workflow, not "write a one-off script."
- **Dedupe-aware.** The journal tracks `{doc_id, sha256(content)}`
  per source — a second run over an unchanged tree yields 0 new
  embed calls.
- **Composable.** Multiple sources (filesystem + http + git) fan
  into the same collection behind one name.
- **Audit-friendly.** `llamactl rag pipeline logs <name>` tails a
  structured JSONL journal — every fetched doc, every skip, every
  error, every run-start + run-complete.
- **Scheduled.** `schedule: @daily` (or `@hourly`, `@weekly`,
  `@every 15m`, …) hooks the pipeline into the long-running
  scheduler loop; no external cron required.

Stick to `llamactl rag store` for ad-hoc "drop these three
paragraphs into the collection" work — the pipeline harness is
overkill for a one-time poke.

---

## Prerequisites

- **A registered RAG node.** Pipelines ingest *into* nodes
  (`kb-pg`, `kb-chroma`, etc.) registered in your kubeconfig. See
  `docs/rag-nodes.md` for how to add one.
- **An embedder.** pgvector nodes need an `embedder` binding on
  the node (the operator-exposed `EmbedderPanel` in the Knowledge
  module toggles this). Chroma nodes embed internally and ignore
  the binding.
- **`git` in `$PATH`.** Only required for `kind: git` sources —
  the fetcher shallow-clones to a tmpdir by shelling out to the
  git binary.
- **Disk.** Pipeline state lives under
  `$DEV_STORAGE/rag-pipelines/<name>/{spec.yaml, journal.jsonl,
  state.json}`. Override the root via
  `LLAMACTL_RAG_PIPELINES_DIR`.

---

## Anatomy of a manifest

```yaml
apiVersion: llamactl/v1
kind: RagPipeline
metadata:
  name: llamactl-docs              # filesystem-safe identifier

spec:
  destination:
    ragNode: kb-pg                 # a rag-kind node in kubeconfig
    collection: llamactl_docs      # collection name in that node

  sources:
    - kind: filesystem             # see "Sources" below
      root: /Volumes/WorkSSD/repos/personal/llamactl/docs
      glob: "**/*.md"
      tag:                         # merged into every doc's metadata
        source: llamactl-docs
        repo: llamactl

  transforms:
    - kind: markdown-chunk         # see "Transforms" below
      chunk_size: 800
      overlap: 150
      preserve_headings: true

  schedule: "@daily"               # optional — scheduler loop fires
                                   #   when the next-run time arrives
  on_duplicate: skip               # skip | replace | version
  concurrency: 4                   # parallel doc pipelines per source
```

Every field is validated through a zod schema
(`RagPipelineManifestSchema`) at apply time. Invalid manifests
return `BAD_REQUEST` from the tRPC procedure with the Zod issues
verbatim — no silent defaults papering over typos.

---

## Sources

Three source kinds ship in v1. All share the same `tag:` optional
field (merged into each doc's `metadata`) and emit `RawDoc`s into
the transform pipeline.

### `kind: filesystem`

```yaml
- kind: filesystem
  root: /path/to/docs              # required
  glob: "**/*.md"                  # default "**/*"
  tag: { source: local-docs }
```

Walks `root` with the glob, yielding one doc per text file. Binary
files are skipped via a first-512-bytes printable-char heuristic.
Uses `Bun.Glob` when available, falls back to a recursive walker +
minimal glob translator on plain Node.

### `kind: http`

```yaml
- kind: http
  url: https://docs.example.com/   # required
  max_depth: 2                     # default 1, capped at 5
  same_origin: true                # default true
  ignore_robots: false             # default false — honors /robots.txt
  rate_limit_per_sec: 2            # default 2
  timeout_ms: 10000                # default 10_000
  auth:
    tokenRef: env:DOCS_TOKEN       # env: / keychain: / file: grammar
```

Breadth-first crawl from `url`. By default it fetches `/robots.txt`
once per origin and honors Disallow rules — set `ignore_robots:
true` only if you own the site or have explicit permission. The
token reference is resolved at fetch time via the shared
`env:`/`keychain:`/`file:` resolver and sent as a Bearer header.

### `kind: git`

```yaml
- kind: git
  repo: https://github.com/acme/docs.git    # https or git@host:org/repo.git
  ref: main                                 # optional, default HEAD
  subpath: docs                             # optional, restrict walk
  glob: "**/*.md"                           # default "**/*.md"
  auth:
    tokenRef: env:GITHUB_TOKEN              # optional, for private repos
```

Shallow-clones the repo into a tmpdir, walks the (optional)
subpath with the glob, removes the checkout when the source
finishes (successfully *or* on abort). https URLs with
`auth.tokenRef` set get rewritten to embed the token as
`x-access-token` basic-auth — GitHub / GitLab / Gitea style. SSH
URLs pass through unchanged (auth lives in the user's SSH
config).

---

## Transforms

Transforms run in declared order; each receives the upstream
doc stream and yields a new one. v1 ships a single transform
kind:

### `kind: markdown-chunk`

```yaml
- kind: markdown-chunk
  chunk_size: 800                  # default 800 chars
  overlap: 150                     # default 150 chars
  preserve_headings: true          # default true
```

Splits on Markdown headings (`#`/`##`/…), packs paragraphs into
`chunk_size`-bounded chunks, carries an `overlap` tail from one
chunk into the next so retrieval across boundaries keeps enough
context. With `preserve_headings: true` each chunk gets a
`# Heading > ## Subheading …` prefix so retrieval surfaces the
anchor without relying on the body text naming itself. Emitted
chunk IDs follow `<doc_id>#<n>`.

To ingest raw text with no transform (e.g. each source already
produces a single chunk), omit the `transforms` field entirely.

---

## Dedupe semantics — `on_duplicate`

Controls what happens when a `doc_id` reappears with *different*
content (same sha → always a no-op, regardless of mode). Three
values:

- **`skip`** (default). New chunks land alongside the old.
  Previously-stored chunks stay as orphans. Best when the rag
  node handles its own cleanup or the collection is write-once.
- **`replace`**. Before storing, union every prior ingestion's
  chunk IDs from the journal and call `adapter.delete` on them.
  Guarantees "one version per doc" in the store. Requires the
  rag node to expose `delete` (chroma + pgvector both do).
- **`version`**. Store the new chunks with IDs suffixed by the
  content sha — `<doc_id>@<sha12>#<n>` — so both versions
  coexist. First-time ingests stay bare so switching modes
  mid-stream doesn't bifurcate the ID space unnecessarily.
  Useful when historical retrieval matters.

The journal records `chunk_ids: []` on every `doc-ingested` entry,
so `replace` and `version` both have the full set of prior IDs to
reconcile against — no reliance on the transform's ID-shape
convention.

---

## Cost estimation

```yaml
spec:
  cost:
    per_chunk_usd: 0.0001       # optional; rate per stored chunk
    per_doc_usd: 0.0             # optional; rate per ingested doc
    currency: USD                # default USD
```

When present, each run's summary gets an `estimated_cost.usd`
field computed as `total_chunks × per_chunk_usd + total_docs ×
per_doc_usd`. The Pipelines tab surfaces the number next to the
last-run badge ("~$0.0032"). Rates are operator-declared because
retrieval adapters (chroma embeds internally; pgvector's delegated
embedder swallows `UnifiedEmbeddingResponse.usage`) don't surface
token counts through the `RetrievalProvider` contract today —
precise accounting is a follow-up that needs either an adapter
change in `@nova/contracts` or a side-channel embedder hook.

Absent → no estimate rendered. Honest silence over a false zero.

## Scheduling

```yaml
spec:
  schedule: "@daily"
```

Accepted grammar (v1):

- `@hourly` — top of every hour (UTC)
- `@daily` — midnight UTC
- `@weekly` — Sunday midnight UTC
- `@every 15m` / `@every 2h` / `@every 1d` — run-relative, from
  last-run

The scheduler itself is an agent-side loop:

```sh
llamactl rag pipeline scheduler                # runs until SIGINT / SIGTERM
llamactl rag pipeline scheduler --once         # single tick, then exit (cron-style)
llamactl rag pipeline scheduler --interval=60  # seconds between ticks (default 60)
```

On each tick the loop enumerates applied pipelines, compares each
one's `lastRun.at` + schedule grammar against now, and fires
anything due. One in-flight run per pipeline is enforced at a time —
a schedule tick that arrives while the previous run is still
ingesting journals a `schedule-skipped reason=in-flight` entry.

Absent `schedule:` = on-demand only. Operators run via
`llamactl rag pipeline run <name>` or the Pipelines-tab Run button.

---

## Running a pipeline

### CLI

```sh
llamactl rag pipeline apply -f templates/rag-pipelines/llamactl-docs.yaml
  # → applied rag pipeline 'llamactl-docs'
  #     path: $DEV_STORAGE/rag-pipelines/llamactl-docs/spec.yaml

# `-f -` reads from stdin, so draft + apply is one line:
llamactl rag pipeline draft "crawl https://docs.example.com daily" \
  | llamactl rag pipeline apply -f -

# Same shape works for clone-and-modify:
llamactl rag pipeline get llamactl-docs \
  | sed 's/@daily/@hourly/' \
  | llamactl rag pipeline apply -f -

llamactl rag pipeline run llamactl-docs
  # Ingests every file. Prints a RunSummary at the end.

llamactl rag pipeline run llamactl-docs --dry-run
  # Walks fetch + chunk, journals `doc-would-ingest`, skips adapter.store.

llamactl rag pipeline run llamactl-docs --json
  # Single-line RunSummary for piping.

llamactl rag pipeline list
  # One row per applied pipeline + its last-run summary.

llamactl rag pipeline get llamactl-docs
  # Prints the stored manifest as YAML.

llamactl rag pipeline logs llamactl-docs
  # Tails journal.jsonl. Default --tail=50; --follow polls every 500ms.

llamactl rag pipeline rm llamactl-docs
  # Deletes the spec + journal + state.
  # DOES NOT remove already-stored documents from the rag node.
```

### Electron — Knowledge > Pipelines

The Knowledge module carries a Pipelines tab with the same
surface:

- **List view** with last-run status badge, schedule, row-level
  Run (with `--dry-run` toggle), Logs (live journal tail), and
  Remove actions.
- **+ New pipeline** wizard — a 4-step stepper (Destination →
  Sources → Transforms → Review) that assembles the manifest
  client-side and applies it via `ragPipelineApply`.
- **Draft from description…** panel — types natural language in,
  extracts URLs / paths / schedule aliases / rag node hints, and
  emits a schema-valid YAML skeleton the operator can tweak
  before applying.

### MCP — `llamactl.rag.pipeline.*`

Every tRPC procedure mirrors to an MCP tool:

- `llamactl.rag.pipeline.apply` — takes `manifestYaml`, persists.
- `llamactl.rag.pipeline.run` — takes `name`, `dryRun`, runs.
- `llamactl.rag.pipeline.list` — enumerates + lastRun.
- `llamactl.rag.pipeline.get` — one manifest by name.
- `llamactl.rag.pipeline.remove` — wipes the pipeline dir.
- `llamactl.rag.pipeline.draft` — scaffolds YAML from a
  description.

Ops-chat dispatches the same tools (read tier for list/get/draft,
mutation-dry-run-safe for apply/run, mutation-destructive for
remove) so the agent can drive the whole surface end-to-end.

---

## Drafting from a description

```sh
llamactl rag pipeline draft "crawl https://docs.pytorch.org into kb-pg daily"
```

```yaml
apiVersion: llamactl/v1
kind: RagPipeline
metadata:
  name: docs-pytorch-org
spec:
  destination:
    ragNode: kb-pg
    collection: docs_pytorch_org
  sources:
    - kind: http
      url: https://docs.pytorch.org
      max_depth: 2
      same_origin: true
      ignore_robots: false
      rate_limit_per_sec: 2
      timeout_ms: 10000
  transforms:
    - kind: markdown-chunk
      chunk_size: 800
      overlap: 150
      preserve_headings: true
  concurrency: 4
  on_duplicate: skip
  schedule: "@daily"
```

The drafter is deterministic — no LLM. Extracts URLs (→ http or
git depending on `.git` suffix), filesystem paths (→ filesystem),
collection names (`collection <name>` phrase), schedule aliases
(`@daily`, `daily`, `every 15 minutes`), and rag node hints (matches
against `availableRagNodes` when provided). Warnings accompany the
output for anything it couldn't infer confidently
(missing URL/path, ambiguous rag node, default collection name).

Pipe into `apply -f -` once that wiring lands, or redirect to a
file and edit before applying.

---

## Observability

Every run appends entries to
`$DEV_STORAGE/rag-pipelines/<name>/journal.jsonl`. Kinds:

| Kind | When |
|---|---|
| `run-started` | at the top of every `runPipeline` call |
| `source-started` | before each source's fetcher runs |
| `doc-ingested` | per doc successfully stored (wet run) |
| `doc-would-ingest` | per doc processed in `--dry-run` |
| `doc-skipped` | per doc where `{doc_id, sha}` was already seen |
| `source-complete` | after each source completes |
| `error` | fetch / transform / store failure (non-fatal path) |
| `run-complete` | final summary: total_docs / total_chunks / elapsed_ms |
| `schedule-fired` | scheduler kicked a run |
| `schedule-skipped` | scheduler skipped (in-flight or bad schedule) |

`state.json` caches the last run's summary for `list` / UI use;
the journal is the source of truth.

The Pipelines tab polls `ragPipelineRunning` every 2s for a "is
this ingesting right now?" signal backed by an in-memory event
bus. The row's running badge appears optimistically on Run click
so sub-poll-cadence runs don't flash past invisibly.

---

## Common patterns

### Ingest the llamactl docs into kb-pg

```sh
llamactl rag pipeline apply -f templates/rag-pipelines/llamactl-docs.yaml
llamactl rag pipeline run llamactl-docs
# Then: llamactl rag ask kb-pg "how does on_duplicate: replace work?"
```

### Incremental crawl, daily

```yaml
metadata: { name: vendor-docs }
spec:
  destination: { ragNode: kb-pg, collection: vendor_docs }
  sources:
    - kind: http
      url: https://docs.vendor.com
      max_depth: 3
      rate_limit_per_sec: 1      # be a good neighbor
  transforms:
    - { kind: markdown-chunk, chunk_size: 800 }
  schedule: "@daily"
  on_duplicate: replace          # stale URLs get cleaned up
```

### Git repo with auth, private subpath

```yaml
metadata: { name: runbooks }
spec:
  destination: { ragNode: kb-pg, collection: runbooks }
  sources:
    - kind: git
      repo: https://github.com/acme/ops-runbooks.git
      ref: main
      subpath: incidents
      auth:
        tokenRef: keychain:github-token
  transforms:
    - { kind: markdown-chunk, chunk_size: 1200, overlap: 200 }
  schedule: "@hourly"
  on_duplicate: replace
```

### Versioned ingest (keep history)

```yaml
metadata: { name: legal-contracts }
spec:
  destination: { ragNode: kb-pg, collection: contracts }
  sources:
    - kind: filesystem
      root: /shared/legal
      glob: "**/*.md"
  transforms:
    - { kind: markdown-chunk, chunk_size: 2000, overlap: 0 }
  on_duplicate: version          # old + new coexist; queries see both
```

---

## Troubleshooting

- **"openAdapter failed"** in the journal → the destination rag
  node isn't reachable. For pgvector, check `PG_RAG_PASSWORD`
  and the endpoint; for chroma-mcp, check the subprocess spawn
  invocation in `rag-nodes.md`.
- **Every doc logs `skipping binary file`** → your glob is too
  wide. Narrow to `**/*.md` or similar.
- **`on_duplicate=replace requested but adapter has no delete
  binding`** → you wired a custom adapter that doesn't implement
  `delete`. Either implement it or stay on `skip`. The run
  continues; it just can't clean orphan chunks.
- **Crawl returns zero docs** → check `ignore_robots` and
  `same_origin`. Many docs sites disallow crawling in
  `/robots.txt`; flip `ignore_robots: true` only if you have
  permission.
- **`schedule-skipped reason=in-flight` repeating** → the previous
  run is stuck. Check the journal for an unpaired `run-started`
  without a matching `run-complete`, and restart the scheduler
  or the underlying agent to clear the in-memory `inFlight` set.
- **Scheduler never fires a `@hourly` pipeline** → confirm the
  scheduler loop is actually running
  (`ps aux | grep "rag pipeline scheduler"`), then check
  `journal.jsonl` for `schedule-fired` entries.

---

## Roadmap (not in v1)

- **Additional sources**: S3, Confluence, Notion, Slack, Linear.
  Plug them in as new fetchers under
  `packages/remote/src/rag/pipeline/fetchers/` — the registry is
  open-shut-closed.
- **Additional transforms**: sentence-splitter, semantic
  chunker, cross-encoder reranker, LLM-as-judge quality scorer.
- **File formats beyond markdown**: PDF, docx, OCR via
  unstructured.io-shaped adapters.
- **Distributed runs** with per-source parallelism, work-
  stealing, and a persistent "currently running" broadcast
  across agents. The in-memory event bus (see
  `packages/remote/src/rag/pipeline/event-bus.ts`) is the
  boundary that gets swapped out for a persistent one.
