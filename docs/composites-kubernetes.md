# Composites on Kubernetes

`CompositeSpec` can target a Kubernetes cluster instead of the local
Docker daemon. The schema is unchanged — set `runtime: kubernetes`
on a composite and the same services, workloads, rag nodes, and
gateway entries land in a per-composite namespace backed by
Deployments, StatefulSets, Services, PVCs, and Secrets.

**K8s is opt-in.** Docker is llamactl's default runtime; nothing
about your onboarding requires a cluster. `llamactl doctor`
reports "kubeconfig absent / unreachable" as `info` (not `warn`)
unless it detects intent — either `LLAMACTL_RUNTIME_BACKEND=
kubernetes` in your environment or a persisted composite whose
`spec.runtime` is `kubernetes`. `llamactl init` picks docker
silently when k8s isn't reachable. If you never plan to use the
cluster, `llamactl doctor --skip=kubernetes` omits the probe
entirely.

v1 scope: k8s owns **supporting services** (chroma, pgvector,
future nginx/redis/DBs). Workloads (llama-server `ModelRunSpec`)
still dispatch through the llamactl agent on the target node —
running llama-server as a Pod is a multi-quarter follow-up covering
image publishing, GGUF delivery, GPU scheduling, and tensor-parallel
coordination across pods.

See `docs/composites.md` for the manifest basics; this doc covers
only the k8s-specific setup + troubleshooting.

---

## Prerequisites

- **Bun** (the runtime) recent enough to speak mTLS through
  `@kubernetes/client-node` — the fix merged in oven-sh/bun#26964
  (March 2026). If composite apply fails with TLS handshake errors,
  check `bun --version` and upgrade.
- **`~/.kube/config`** pointing at a cluster where the operator has
  create/get/delete on Deployments, StatefulSets, Services, PVCs,
  Secrets, and Namespaces. `kubectl auth can-i create namespace`
  returning `yes` is the quickest sanity check.
- **A StorageClass** — composites emit RWO PVCs without a
  `storageClassName` so the cluster's default class is used. k3s
  ships `local-path`; Docker Desktop's embedded k8s ships `hostpath`.
  On clusters without a default, pass `storageClassName` via the
  `KubernetesBackendOptions` (see below) or annotate a class as
  default (`storageclass.kubernetes.io/is-default-class=true`).

### Quickstart cluster options

**macOS (easiest):** Docker Desktop → Preferences → Kubernetes →
enable. `kubectl config use-context docker-desktop`. Comes with a
default StorageClass + a working kubeconfig.

**Linux (production-adjacent):** k3s.
```sh
curl -sfL https://get.k3s.io | sh -
# kubeconfig lands at /etc/rancher/k3s/k3s.yaml — copy to ~/.kube/config
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $USER ~/.kube/config
kubectl get nodes
```

Either environment is enough for single-node composites. Multi-node
composites need a second labelled node — see *Node addressing* below.

---

## Selecting the k8s runtime

Per composite, via the manifest:

```yaml
apiVersion: llamactl/v1
kind: Composite
metadata:
  name: kb-stack
spec:
  runtime: kubernetes      # docker | kubernetes, default docker
  services:
    - kind: chroma
      name: chroma-main
      node: local
      port: 8001
```

Or globally as an env-var fallback when `spec.runtime` is omitted:

```sh
export LLAMACTL_RUNTIME_BACKEND=kubernetes
llamactl composite apply -f kb-stack.yaml
```

Precedence: `manifest.spec.runtime` > `LLAMACTL_RUNTIME_BACKEND` >
`docker` (the v1 default).

---

## What llamactl emits

Apply lands one **Namespace** per composite (`llamactl-<name>`) plus
the child resources below. Labels on every resource:

- `app.kubernetes.io/managed-by: llamactl`
- `app.kubernetes.io/instance: <composite>-<service>`
- `app.kubernetes.io/part-of: <composite>`
- `llamactl.io/composite: <composite>`
- `llamactl.io/component: service`
- `app: <service>` (selector key)

Drift detection uses the `llamactl.io/spec-hash` annotation on
Deployments, StatefulSets, Services, and Secrets. PVCs are **never
replaced** after creation — storage migrations are dangerous; that
gate moves behind an explicit opt-in in a future slice.

### Chroma (stateless service)

```
Deployment  chroma-main
Service     chroma-main                (ClusterIP)
PVC         chroma-main-data           (when persistence.volume set)
Secret      chroma-main-secrets        (when service has secrets)
```

`strategy.type: Recreate` to match the single RWO PVC.

### pgvector (stateful service)

```
StatefulSet pg-main
Service     pg-main                    (headless, clusterIP: None)
Service     pg-main-client             (ClusterIP — clients use this)
Secret      pg-main-secrets            (carries POSTGRES_PASSWORD)
             (PVCs materialize per-pod via volumeClaimTemplates)
```

The headless Service is mandatory for any StatefulSet — its DNS
records are what `StatefulSet.spec.serviceName` resolves to.
External clients connect through `pg-main-client.llamactl-kb-stack.svc.cluster.local:5432`.

---

## Node addressing

Composite's `node` field is llamactl's logical name. k8s has its
own node registry. For multi-node setups, pre-label the kubelet
host once per llamactl node:

```sh
kubectl label node <kubelet-hostname> llamactl.io/node=mac-mini-gpu
```

v1 composites targeting a non-`local` node emit a `nodeSelector`
that requires this label. The sentinel `node: local` omits the
selector so the scheduler picks any node — which is the right
default for single-node clusters.

---

## Reaching services from outside the cluster

Services emit ClusterIP endpoints (`<svc>.<ns>.svc.cluster.local`).
From inside another pod, that resolves. From the operator's laptop,
it doesn't. Two quick options:

**`kubectl port-forward`** — dev-loop-fast:

```sh
kubectl -n llamactl-kb-stack port-forward svc/chroma-main 8001:8000
# now http://127.0.0.1:8001 hits chroma
```

**Ingress (proper)** — v1 doesn't emit Ingress resources yet; that's
the nginx-handler follow-up. For now bring your own Ingress or
LoadBalancer if you need external access.

### `serviceType` override (k8s-only)

Each service spec accepts an optional `serviceType:
ClusterIP | NodePort | LoadBalancer` that maps onto the emitted
k8s `Service.spec.type`. Default is `ClusterIP` (the value above).
Changing it triggers drift detection and recreates the Service on
the next apply.

```yaml
services:
  - kind: chroma
    name: chroma-main
    port: 8000
    serviceType: NodePort        # k8s auto-assigns 30000-32767
  - kind: pgvector
    name: pg-main
    port: 5432
    serviceType: LoadBalancer    # Docker Desktop K8s binds localhost:5432
```

- **`NodePort`** — k8s picks the port in the 30000-32767 range;
  llamactl never hardcodes one. On Docker Desktop K8s / a single-
  node cluster you hit it at `localhost:<nodePort>`.
- **`LoadBalancer`** — Docker Desktop K8s transparently binds the
  service's `port` to `localhost`. On a real cluster with a cloud
  provider, the cluster allocates an ingress IP/hostname visible in
  `status.loadBalancer.ingress`.
- **`ClusterIP`** (default) — no change from the current behavior;
  use `kubectl port-forward` from the operator's laptop.

Rag nodes whose `backingService` targets a non-`ClusterIP` service
auto-wire their binding to the host-reachable URL (`http://
localhost:<nodePort>` for NodePort; `http://<lb-ingress>:<port>` or
the localhost fallback for LoadBalancer). Other consumers that read
`resolvedEndpoint` continue to see the in-cluster DNS name — only
the rag-binding path branches.

StatefulSet services (pgvector and similar) retain their mandatory
headless companion at `clusterIP: None` regardless of the override;
only the accompanying `-client` ClusterIP Service takes on the
override type.

### ConfigMap volumes

Generic `kind: container` services on the k8s runtime can mount a
`v1.ConfigMap` as an inline-data volume. Keys under `data` become
files inside the container, one file per key.

```yaml
services:
  - kind: container
    name: sirius-main
    image: { repository: sirius/gateway, tag: '1.4.0' }
    volumes:
      - containerPath: /config
        configMap:
          name: sirius-config
          data:
            providers.yaml: |
              - name: openai
                baseUrl: https://api.openai.com/v1
            routes.yaml: |
              - path: /v1/chat/completions
                upstream: primary
          defaultMode: 0o444          # optional; k8s default is 0644
```

- `name` is the `v1.ConfigMap` object name created in the composite
  namespace. llamactl upserts the ConfigMap (create on first apply,
  replace on spec-hash drift) before the Deployment/StatefulSet
  apply so the pod schedules cleanly on the first pass.
- `data` is a literal key→string map. Each entry lands as
  `/config/<key>` inside the container.
- `defaultMode` (octal) sets the file permission bits. Omit for the
  k8s default of `0644`.
- Docker runtime **rejects** this variant at apply time with
  `spec-invalid: volumes[N]: configMap mounts require runtime:
  kubernetes; use hostPath or name for docker`. Pick a bind mount
  or a named volume on the Docker path.
- `configMap`, `hostPath`, and `name` are mutually exclusive — the
  schema requires exactly one.

Updating the `data` block on the next apply replaces the ConfigMap
in place; llamactl deliberately does not restart pods on ConfigMap
change. Operators whose workloads need an immediate mount refresh
should either `kubectl rollout restart` the Deployment or use
projections (follow-up slice).

---

## Destroy

`llamactl composite destroy <name>` against a k8s composite short-
circuits to **one call**: `DELETE namespace llamactl-<name>`. k8s's
cascade GC removes every child — Deployments, StatefulSets,
Services, Secrets, and PVCs — in one pass, matching what operators
expect from `kubectl delete namespace`.

PVCs go away with the namespace regardless of `--purge-volumes`
(that flag is for the Docker path, which needs explicit opt-in to
remove anonymous volumes).

Non-service components (rag node kubeconfig entries; workload llama-
server processes on the agent) still clean up through the per-
component loop so operator data on other control planes stays
consistent.

---

## Troubleshooting

### `kubernetes unreachable: connection refused`

`~/.kube/config` is pointed at a cluster that isn't up or isn't
reachable from this host. `kubectl get nodes` first.

### `spec-invalid: failed to resolve secret 'POSTGRES_PASSWORD' (ref='env:X')`

Same secret-resolver error path as Docker. Check `echo $X` in the
shell running `llamactl`. Secrets can also live in macOS Keychain
(`keychain:service/account`) or a file (`file:/path`) — see
`packages/remote/src/config/secret.ts` or AGENTS.md § "Secret
references".

### `pending — StorageClass not found` (on a fresh cluster)

The cluster has no default StorageClass. Either set one:

```sh
kubectl patch storageclass <your-class> \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

…or pass an explicit `storageClassName` into the KubernetesBackend
options at the call site. A manifest-level override is a follow-up.

### Apple Silicon: image pull errors for `amd64`-only images

k8s pulls via the node's runtime, so the error surfaces pod-side
rather than at apply. Prefer multi-arch image tags (e.g.,
`pgvector/pgvector:0.8.2-pg18-trixie` publishes arm64 + amd64).
Pinning an amd64-only tag on an arm64 kubelet fails at runtime with
`exec format error`.

### pgvector StatefulSet crashloops with "unused mount/volume"

The default `persistence.mountPath` is `/var/lib/postgresql` to
match pg18's expected data-directory layout. When you pin
`image.tag` to a pg16/pg17 variant, override the mount path to
restore the legacy location:

```yaml
services:
  - kind: pgvector
    image: { repository: pgvector/pgvector, tag: '0.7.4-pg17-trixie' }
    persistence:
      volume: pgdata
      mountPath: /var/lib/postgresql/data
```

pg18+ requires a single mount at `/var/lib/postgresql` and manages
`data/` as an image-owned subpath.

### Readiness timeout after 60 s

`llamactl` polls the controller's `status.readyReplicas` up to 60 s
by default. Common causes: the image is still pulling (check
`kubectl -n llamactl-<composite> describe pod/<name>-*`), or the
pod's readinessProbe is failing. Extend the timeout through
`KubernetesBackendOptions.readinessTimeoutMs` when the cluster has
slow pulls.

### PVC drift warning

PVCs aren't replaced after creation — a spec-hash mismatch on a
PVC is left as-is with only the Deployment/StatefulSet getting
refreshed. If storage really needs to change, destroy the composite
(with or without `--purge-volumes`) and re-apply.

---

## What's next (roadmap)

- **Workloads as Pods** — image + GGUF delivery pipeline + GPU
  device plugins; multi-quarter.
- **Ingress handler** — `{ kind: 'ingress', routes: [...] }` emits
  `networking.k8s.io/v1.Ingress` so external access doesn't need
  `kubectl port-forward`.
- **Multi-replica services** — requires ReadWriteMany storage or
  per-pod PVCs. Today every service is `replicas: 1`.
- **Per-manifest storageClassName** — add to `ServiceSpec` so
  operators don't have to default at the class level.
- **CRD + custom controller** — only when we need cluster-side
  reconciliation (self-healing, admission webhooks, policy
  enforcement). Today's llamactl-as-client mirror-of-Helm works.
- **Secret rotation** — today's Secret is created once; rotating
  requires a Secret update + pod restart.
- **PodSecurityStandards enforcement** — namespace labels so
  hardened clusters accept our pods without manual fixups.
