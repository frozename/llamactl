# Tensor-parallel workloads

Split llama.cpp inference across multiple nodes via RPC, for models
that don't fit on one machine.

---

## When to use it

Tensor-parallel splits layer computation across multiple ggml
backends reached over TCP. Useful when a single model's weights
exceed any one machine's VRAM/RAM budget: a coordinator hosts a
subset of layers locally and offloads the rest to one or more
`rpc-server` workers, each holding its own shard. Only the
coordinator exposes the OpenAI-compat API; workers are invisible
to clients.

Not useful for small models. `rpc-server` adds a network round-trip
on every tensor operation; for a GGUF that fits in the
coordinator's RAM+VRAM with headroom for KV cache, single-node
inference is always faster. Reach for tensor-parallel only when no
single machine can hold the weights.

---

## Prerequisites

1. **All nodes built from the same llama.cpp commit.** Mismatched
   versions load the model but produce subtly-broken inference
   (tensors line up, semantics drift).
2. **`-DGGML_RPC=ON` set during llama.cpp CMake config.** Default
   builds don't include `rpc-server`. From your llama.cpp source
   tree:

   ```sh
   cmake -B build -DGGML_RPC=ON
   cmake --build build --target rpc-server llama-server
   ```

3. **Shared GGUF at the same relative path on every node** under
   `$LLAMA_CPP_MODELS` (rsync, NFS, or per-node `llamactl pull
   file`). The coordinator loads the model; workers serve their
   shard after the coordinator routes the graph.
4. **Reachable network between coordinator and workers.** The
   coordinator opens a TCP connection to each `rpcHost:rpcPort`;
   worker-side firewalls must allow it.
5. **llamactl agents installed on every participating node.** See
   [`./deployment-mac-mini.md`](./deployment-mac-mini.md) for the
   per-node install flow.

---

## Preflight

Run `rpc-doctor` on every node that will run `rpc-server`:

```sh
llamactl agent rpc-doctor                  # local node
llamactl agent rpc-doctor --node=gpu-box   # remote via kubeconfig
llamactl agent rpc-doctor --json           # structured output
```

Happy-path output:

```
ok
  path: /Users/you/DevStorage/src/llama.cpp/build/bin/rpc-server
  LLAMA_CPP_BIN: /Users/you/DevStorage/src/llama.cpp/build/bin
```

Failure modes and remedies:

- `LLAMA_CPP_BIN-unset` — export `LLAMA_CPP_BIN` in the shell or
  the LaunchAgent env block.
- `LLAMA_CPP_BIN-missing` — the path doesn't exist; fix the env
  or create the directory.
- `rpc-server-missing` — rebuild llama.cpp with `-DGGML_RPC=ON`.
- `rpc-server-not-executable` — `chmod +x $LLAMA_CPP_BIN/rpc-server`.

Apply-time preflight runs the same check and aborts with a
composed error, but `rpc-doctor` surfaces the failure before you
read the workload log.

---

## Manifest

A two-worker coordinator:

```yaml
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: qwen25-72b-cluster
spec:
  # Coordinator: hosts llama-server, exposes the OpenAI-compat API.
  node: workstation
  target:
    kind: rel
    value: Qwen/Qwen2.5-72B-Instruct-GGUF/qwen2.5-72b-instruct-q4_0-00001-of-00011.gguf
  # Flags passed to the coordinator's llama-server. The --rpc <csv>
  # flag is appended automatically when spec.workers is non-empty;
  # don't include it here.
  extraArgs: ['--host', '0.0.0.0', '--port', '8080', '--ctx-size', '8192']
  # Worker pool: each starts rpc-server before the coordinator launches.
  workers:
    - node: gpu-box-1
      rpcHost: 192.168.1.20
      rpcPort: 50001
      extraArgs: []
      timeoutSeconds: 30
    - node: gpu-box-2
      rpcHost: 192.168.1.21
      rpcPort: 50001
      extraArgs: []
      timeoutSeconds: 30
  restartPolicy: Always
```

Notes:

- `spec.node` is the coordinator — it must reach every
  `rpcHost:rpcPort` in the `workers` list.
- `target.kind: rel` resolves `value` against each node's
  `$LLAMA_CPP_MODELS`. Every node needs the file at the same
  relative path.
- `rpcHost` is what the worker's `rpc-server` advertises and what
  the coordinator dials — typically the worker's LAN IP.
- `rpcPort` must be unique per worker within the manifest; apply
  does not detect collisions.
- `timeoutSeconds` caps the coordinator's wait for a worker's
  `rpc-server` to become reachable (default 30). Bump for cold-disk
  shard loads.

---

## Apply and observe

```sh
# Apply against the coordinator's context.
llamactl apply -f qwen25-72b-cluster.yaml

# List + inspect.
llamactl get workloads
llamactl describe workload qwen25-72b-cluster

# Per-node server status (coordinator first, then each worker).
llamactl --node=workstation server status
llamactl --node=gpu-box-1 server status
llamactl --node=gpu-box-2 server status
```

Success looks like:

- `describe workload` reports `status.phase: Running`.
- The coordinator's `server status` shows `state: up`, a non-zero
  pid, and an `extraArgs` list that includes
  `--rpc 192.168.1.20:50001,192.168.1.21:50001`.
- Each worker tracks its `rpc-server` alongside `llama-server`
  under the same status surface.

To confirm the OpenAI API surface is live, hit the coordinator
directly: `curl http://192.168.1.10:8080/v1/models`.

---

## Teardown

```sh
llamactl delete workload qwen25-72b-cluster
```

Tears down in reverse order: the coordinator's `llama-server`
stops first, then each worker's `rpc-server`. Bound TCP ports free
up within a few seconds of SIGTERM.

---

## Troubleshooting

### Apply aborts with `worker-preflight-failed`

The apply path ran `rpcServerDoctor` on every worker and at least
one returned `ok: false`. The error message lists each failing
node with its `reason` and `hint`. Rerun `llamactl agent rpc-doctor
--node=<name>` on the failing node to confirm, then fix the
underlying cause (usually a missing `rpc-server` binary — see
Prerequisites).

### Worker's `rpc-server` starts but the coordinator can't connect

Check the bind on the worker, then probe from the coordinator:

```sh
# On the worker
sudo lsof -iTCP:50001 -sTCP:LISTEN    # expect rpc-server on 0.0.0.0:50001

# On the coordinator
nc -vz 192.168.1.20 50001
```

A refused/timed-out connect is usually a macOS Application Firewall
rule on the worker or a LAN router ACL. Grant `rpc-server` inbound
permission (System Settings → Privacy & Security → Firewall) or
open the port upstream.

### Coordinator starts but inference hangs or returns garbage

Mismatched llama.cpp versions. Confirm every node runs binaries
built from the same commit:

```sh
llama-server --version
rpc-server --version
```

Rebuild stragglers from the shared commit. GGUF mismatches
(different quantizations at the same relative path) also surface
as hangs; verify with `shasum -a 256
$LLAMA_CPP_MODELS/<target.value>` on each node.

### Coordinator dies when a worker goes down

`rpc-server` is not resilient to peer failure: if a worker exits
mid-inference, the coordinator's `llama-server` exits too. Recover
the worker, then `llamactl apply -f` the same manifest again — the
apply path detects the coordinator is down and re-runs the full
start sequence. For automated recovery on healthy→unhealthy
flips, subscribe the workload to the healer loop
(see [`../AGENTS.md`](../AGENTS.md) § Self-healing loop).

---

## Alternatives

If tensor-parallel latency is unacceptable, three single-machine
strategies usually close the gap:

- **Smaller quantization** — Q4_K_M → Q3_K_M or Q2_K may fit the
  model on one machine with acceptable quality loss.
- **Speculative decoding** — `--model-draft` pairs a small draft
  with a large target for faster tokens without RPC; works best
  when vocabularies match.
- **Partial offload** — `--n-gpu-layers <N>` splits layers between
  GPU and CPU on one machine; useful when VRAM is the bottleneck
  but RAM is plentiful.
