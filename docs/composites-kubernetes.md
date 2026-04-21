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
