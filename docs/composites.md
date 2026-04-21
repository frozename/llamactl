# Composites — declarative multi-component infra

A **Composite** is a manifest that declares a whole scene — model(s),
gateway(s), RAG node(s), and supporting container services (chroma,
pgvector, nginx, redis, future databases) — as one atomic unit.
`llamactl.composite.apply` walks the declared dependency DAG, brings
each component up in order, rolls back on failure, and persists the
final status on disk.

The applier is runtime-agnostic: v1 targets the Docker Engine API,
later phases will plug in a Kubernetes backend behind the same
`RuntimeBackend` interface.

---

## When to use it

Reach for a composite when you want several components to come up or
go down together and you care about the ordering between them:

- "Spin up a chroma instance + a rag node that points at it."
- "Deploy a 7B llama-server + register it with the sirius gateway."
- "Stand up pgvector + a rag node + a llama-server that calls the
  rag for context."
- Future, once handlers land: "Nginx in front of the llama-server,
  routing `/v1` + `/api/rag`."

Stick to bare `llamactl node add` / `llamactl workload apply` for
single-component changes — composites add an orchestration layer
that only pays off when there are dependencies to manage.

---

## Prerequisites

- **Docker daemon** reachable via `/var/run/docker.sock`. On macOS,
  Docker Desktop exposes the socket by default. Linux: check
  `systemctl status docker`. Podman's `podman system service`
  exposes a Docker-compatible socket — export `DOCKER_SOCKET` to
  point llamactl there.
- **Kubeconfig** — any RAG nodes referenced in the composite get
  upserted into the current context's cluster at apply time.
- **Disk** — composites persist under `~/.llamactl/composites/`
  (override with `LLAMACTL_COMPOSITES_DIR`). Chroma + pgvector
  volumes take whatever path you declare in `persistence.volume`.

---

## Anatomy of a composite manifest

```yaml
apiVersion: llamactl/v1
kind: Composite
metadata:
  name: kb-stack                    # lowercase alphanumeric + hyphens

spec:
  services:          # container-backed supporting infra
    - kind: chroma
      name: chroma-main             # composite-scoped unique
      node: local
      port: 8001
      persistence:
        volume: /var/lib/llamactl/chroma-main
        mountPath: /data

  workloads:         # llama-server model runs (ModelRunSpec shape)
    - node: local
      target: { kind: rel, value: "qwen2.5-7b.Q4_K_M.gguf" }
      extraArgs: ["--ctx-size", "8192"]
      workers: []
      restartPolicy: OnFailure
      gateway: false
      timeoutSeconds: 60

  ragNodes:          # register as kind:'rag' nodes in kubeconfig
    - name: kb
      node: local
      binding:
        provider: chroma
        endpoint: ""                # resolved from backingService
        extraArgs: []
      backingService: chroma-main   # wires endpoint from the service's resolvedEndpoint

  gateways: []       # thin wrappers around existing gateway-handlers (sirius, embersynth)

  dependencies:
    - from: { kind: rag, name: kb }
      to:   { kind: service, name: chroma-main }

  onFailure: rollback                # or 'leave-partial'
```

Notes:

- `workloads[]` uses the plain `ModelRunSpec`. The composite
  synthesizes a `metadata.name` = `spec.node` at apply time (v1
  constraint: one workload per node inside a composite).
- `ragNodes[].backingService` auto-wires the binding's `endpoint`
  to the resolved service URL — you don't have to hard-code
  `http://127.0.0.1:8001` anywhere.
- `services[].serviceType` (optional, `ClusterIP` | `NodePort` |
  `LoadBalancer`) is k8s-only — docker runtime exposes services
  through `hostPort` already and ignores the field. See
  [`composites-kubernetes.md`](./composites-kubernetes.md) for the
  external-exposure options.
- `dependencies[]` is the explicit DAG. The applier also infers edges
  (rag→service via `backingService`, gateway→workload via
  `upstreamWorkloads`), so you usually don't need to declare those.
- Cycles are rejected at parse time; the error names the components
  in the cycle.

---

## Apply / destroy flows

**From the CLI** (planned wrapper — tRPC is the primary entrypoint
today):

```sh
llamactl composite apply -f kb-stack.yaml          # wet run
llamactl composite apply -f kb-stack.yaml --dry-run  # preview DAG
llamactl composite destroy kb-stack                # tear down
llamactl composite list
llamactl composite get kb-stack
```

**From the Electron UI**: open the Composites module in the activity
bar (`Boxes` icon). Three tabs:

- **List** — every registered composite with its phase badge.
- **Apply** — author (textarea YAML editor), dry-run to preview the
  topological order + implied edges, then wet-apply.
- **Detail** — selected composite's metadata, component tree grouped
  by kind, live status, destroy-with-confirmation.

**From ops-chat**: ask natural-language questions.

- "deploy chroma + a 7B model on local with a rag node pointing at the
  chroma" — the planner emits a single `llamactl.composite.apply`
  step with the YAML inline.
- "tear down the kb-stack composite" — `llamactl.composite.destroy`
  (tier-3; requires the type-the-name confirmation).
- "list my composites" — `llamactl.composite.list` (tier-1 read).

**From MCP clients**: the facade exposes `llamactl.composite.{apply,
destroy,list,get}`. Inputs mirror the tRPC procedures 1:1.

---

## Lifecycle + idempotency

Every call to `compositeApply` with an unchanged manifest is a
cheap no-op:

1. Applier computes a topological order of components.
2. For each service, `RuntimeBackend.ensureService(deployment)`:
   - Inspects the container by name.
   - If present + `llamactl.spec.hash` label matches → leave alone.
   - If present + hash differs → stop + remove + recreate.
   - If absent → pull image + create + start.
3. Workloads reuse the existing `workload/apply.ts` pipeline
   (diff rel + extraArgs against the live `serverStatus`, restart
   only when they drift).
4. RAG nodes upsert into the kubeconfig with the resolved endpoint.
5. Gateways trigger the existing gateway-handler reload (sirius /
   embersynth configs).

On any failure:

- `onFailure: rollback` (default) — walk previously-applied
  components in reverse and tear each down. Final phase: `Failed`.
- `onFailure: leave-partial` — stop and leave whatever's up running.
  Final phase: `Degraded`.

Persisted status includes a per-component `state` (`Ready` /
`Failed`) and an `appliedAt` ISO timestamp.

---

## Troubleshooting

### `backend-unreachable: docker daemon unreachable`

Docker isn't running or the socket path is wrong. Check
`docker ps`. On Mac set `DOCKER_SOCKET=/var/run/docker.sock`
(default) or point at Podman's socket if that's what you're
running.

### `image-pull-failed: manifest unknown`

The tag you requested doesn't exist on the registry. Pin to a known
good tag (e.g. `chromadb/chroma:1.5.8`, `pgvector/pgvector:0.8.2-pg18-trixie`).

### `platform-mismatch: image X is linux/amd64, host is darwin/arm64`

You're on Apple Silicon and the image has no `arm64` variant. Bump
to a newer tag or use a multi-arch image. Emulation via `--platform`
is not wired in v1.

### Apply completes but rag node search returns nothing

Chroma's `chroma-mcp` binary isn't running inside the container by
default — the `chromadb/chroma` image exposes the *HTTP* API on
port 8000. The chroma RAG adapter branches on the binding's endpoint
shape:

- `endpoint: http://...` / `https://...` → native REST v2 client
  (`/api/v2/tenants/default_tenant/databases/default_database/...`).
  Verified against `chromadb/chroma:1.5.8`.
- anything else → legacy stdio `chroma-mcp` subprocess (still useful
  for local dev without a running container).

The HTTP path requires `query_embeddings` for search and
`embeddings` for upsert — chroma v2 no longer auto-embeds at the
transport layer. Attach an embedder by setting
`rag.embedder: { node: <embedder-node>, model: <model-name> }` on
the binding; the adapter reuses the same delegation helper as
pgvector so operators can swap vector stores without swapping
embedders. If the binding has no embedder and the caller doesn't
pass `filter.vector` (search) / `doc.vector` (store), the adapter
surfaces `invalid-request` with a clear message.

### pgvector `CREATE EXTENSION vector` missing after first boot

The `pgvector/pgvector` image ships the extension but does not
auto-enable it. The llamactl pgvector adapter now runs
`CREATE EXTENSION IF NOT EXISTS vector` + the per-collection
`CREATE TABLE IF NOT EXISTS` automatically on the first `rag.store`
for a given collection, so a fresh pgvector service is usable
without `psql -c 'CREATE EXTENSION …'`. Operators who prefer to
drive schema out-of-band can still mount an init script at
`/docker-entrypoint-initdb.d/*.sql`.

### pgvector crashloop: "unused mount/volume"

The default `persistence.mountPath` changed to `/var/lib/postgresql`
to match pg18's expected data-directory layout. If you pinned
`image.tag` to a pg16 or pg17 variant, re-add the pre-18 default
explicitly:

```yaml
persistence:
  volume: /var/lib/llamactl/pgvector-main
  mountPath: /var/lib/postgresql/data   # pg16/pg17 only
```

The pg18+ image moves `data/` to an image-managed subpath under
`/var/lib/postgresql`; mounting directly at the `data` path on pg18
triggers the "This is usually the result of upgrading the Docker
image without upgrading the underlying database using pg_upgrade"
crashloop with the suggestion to mount a single volume at
`/var/lib/postgresql`.

### Destroy removed the container but the kubeconfig still shows the rag node

`destroyComposite` processes components in reverse DAG order; if a
teardown step failed for the rag node (e.g., `removeNode` threw),
the service may still have been destroyed. Rerun `composite destroy`
— the destroy loop is tolerant of partial state.

---

## Shipped since v1

- **Kubernetes backend** — `spec.runtime: 'kubernetes'` targets a
  cluster via `@kubernetes/client-node`. See
  `docs/composites-kubernetes.md`.
- **Live event streaming on `compositeStatus`** — in-memory event
  bus keyed by composite name. Subscribers get the full run buffer
  on connect + live events until the applier emits `done`.
- **CLI wrappers** — `llamactl composite {apply,destroy,list,get,status}`
  land operator workflows in the shell without the UI or a curl
  against the tRPC endpoint.
- **`--purge-volumes` flag on destroy** — opt-in on the Docker
  runtime; reaps anonymous volumes tied to the container. Named
  volumes + bind mounts stay operator-owned. (k8s destroy always
  cascades via namespace delete.)
- **Unified secret management** — `env:` / `$VAR` /
  `keychain:service/account` / `file:/path` all resolve through
  one path. See AGENTS.md § "Secret references".
- **Gateway upstream-threading** — composite gateway handlers
  receive resolved upstream endpoints + providerConfig.
- **`ServiceSpec.secrets` at spec level** — every service spec
  (chroma, pgvector, generic container) can declare secret refs
  that become env entries on Docker or `v1.Secret` + `secretKeyRef`
  on Kubernetes.
- **`llamactl init`** — wizard + three quickstart templates at
  `templates/composites/`.
- **`llamactl doctor`** — probes agent / docker / k8s / keychain
  readiness.

## What's next (roadmap)

- **nginx handler** — `{ kind: 'nginx', routes: [{ path, upstream }]
  }` drives an nginx container with auto-generated config. Foundation
  for ingress patterns.
- **redis + key-value databases** — same pattern; registering a
  DB-kind handler alongside chroma/pgvector.
- **Generic database handler** — postgres (non-pgvector), mysql,
  mongo, with env-driven init scripts.
- **Pipelines → Composite bridge** — export a pipeline as a reusable
  composite.
- **Upstream workloads + providerConfig wiring** — today the gateway
  entry's `upstreamWorkloads` + `providerConfig` fields are captured
  and threaded to the handler, but sirius/embersynth handlers don't
  yet auto-populate their catalogs from the context. That last mile
  is a follow-up.
- **Cross-node service replicas** — v1 runs each service on one
  node. Add `replicas` + node-affinity rules — now within reach on
  the k8s backend.
- **Healer → composite re-apply** — when a component flips to
  Degraded, the self-healing loop could auto-trigger
  `composite.apply` with the last-known good manifest.
