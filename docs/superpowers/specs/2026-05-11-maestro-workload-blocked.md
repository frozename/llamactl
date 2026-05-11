# Improvement 1 (Gemma 4 MTP as llamactl workload) — blocked on design

Date: 2026-05-11
Status: blocked on llamactl architecture (per-workload ports not modeled)

## What we tried

Lift the maestro pilot endpoint (Gemma 4 26B-A4B UD-Q4_K_XL + MTP,
served by the atomic-fork llama-server on `127.0.0.1:8181`) out of its
standalone launchd plist (`tools/maestro-bench/launchd/dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist`)
and register it as a `ModelRun` workload managed by llamactl, matching
the granite41 template pattern.

## What we got

A workable manifest is in tree at
`templates/workloads/gemma4-26b-a4b-mtp-local.yaml`. It validates and
parses. It is **not** applied.

## Why it didn't land

Two obstacles, surfaced in order:

### Obstacle 1 (resolved): node-agent not running

`llamactl apply -f <manifest>` calls `workloadApply.applyOne` which
calls `getNodeClientByName('local')`. The kubeconfig
(`$DEV_STORAGE/config`) declares:

```yaml
- name: local
  endpoint: https://127.0.0.1:7843
  certificateFingerprint: sha256:ab7c…
```

The `local` node-agent on `https://127.0.0.1:7843` wasn't running.
`launchctl list | grep llamactl` showed only `com.llamactl.controller`
(the workload reconciler that watches `$DEV_STORAGE/workloads/`). The
per-node agent that `apply` talks to was offline.

**Fixed in-session:** `agent.yaml` was at the expected path
(`$DEV_STORAGE/agent.yaml`) with matching fingerprint. Running
`LLAMA_CPP_BIN=/Volumes/WorkSSD/src/llama.cpp-atomic/build/bin bun run
cli agent serve` brings it up. (Not persistent — needs a launchd plist
for that, which we intentionally did not add until obstacle 2 is
resolved.)

### Obstacle 2 (the real block): per-workload ports not modeled

With the agent running, apply moves past the connection step but hits
the structural issue: `packages/core/src/server.ts:668-675` in
`launchBackground` builds the llama-server argv as

```ts
const fullArgs = [
  '-m', opts.modelPath,
  '--alias', opts.resolved.LLAMA_CPP_SERVER_ALIAS,
  '--host', opts.resolved.LLAMA_CPP_HOST,
  '--port', opts.resolved.LLAMA_CPP_PORT,
  '-ngl', '999',
  ...opts.args,           // <- manifest extraArgs
];
```

`LLAMA_CPP_PORT` is the **agent's** env (default 8080), not derived
from the manifest's `spec.endpoint.port`. The manifest's
`endpoint.port: 8181` is descriptive — it's recorded in the manifest
status block but never injected into the launch args.

Workaround attempt: append `--port 8181` to `extraArgs` and rely on
llama.cpp honoring later flags. **The server does come up on 8181.**
But the readiness probe in `startServer` polls
`http://${LLAMA_CPP_HOST}:${LLAMA_CPP_PORT}/health` — the *agent's*
port, 8080 — and times out at 60s. The workload lands orphaned: server
process alive on 8181, registry empty.

So either:

1. **The manifest's `endpoint.port` becomes authoritative**: the
   launcher reads it and uses it for both `--port` and the readiness
   probe. This is the obvious fix and is what every other manifest
   system (k8s, nomad) does. One file changes:
   `packages/core/src/server.ts` resolves `endpoint.port` from the
   manifest into a per-launch override of `resolved.LLAMA_CPP_PORT`.
2. **One agent per port** is the current model: spin up multiple
   agents on different ports, each managing one workload. Plausible
   for clusters, terrible UX for one M4 Pro.

Until (1) is done, llamactl can't manage workloads with
non-default ports without orphaning them. This affects more than the
maestro pilot — any future "two local servers on different ports"
case hits the same wall.

## Why the granite workloads appeared to work

The granite41 workloads we saw running earlier this session were
applied at some prior moment when the node-agent was up. They
landed on the agent's default port (8080) and the agent process
later stopped — but the spawned `llama-server` PIDs kept running on
their own.

The reconciler in the controller doesn't supervise those PIDs in
real time. The `mcp__llamactl__llamactl_workload_delete` calls
succeeded because they read the manifest, killed the tracked PID
directly, and removed the file. They didn't go through the node-agent
path. In effect: granite was "managed" in the way our maestro
endpoint would be if we accepted the orphaning. Not actually
managed in real time.

## What we shipped anyway

- The template is in tree as a ready-to-apply manifest with a header
  comment pointing at this status doc.
- The launchd plist was kept (it had been deleted mid-task; restored
  from git).
- Found and fixed an unrelated bug: launchd's TCC sandbox refuses to
  execve scripts under `/Volumes/*` without Full Disk Access. The
  plist now executes `~/.local/bin/llamactl-maestro-serve.sh` and
  `install.sh` copies the script there. Before this change the plist
  flapped silently when re-loaded on a fresh user session (it had
  been working only because the original install happened before
  TCC tightened, or because Full Disk Access had been granted
  manually and lost).

## Unblock plan

Two pieces, in order:

1. **Per-workload port in the launcher** (single-file change to
   `packages/core/src/server.ts`): resolve `endpoint.port` /
   `endpoint.host` from the manifest into the launch args and the
   readiness probe. Today these fields are stored but ignored at
   launch. Add a unit test that applies a manifest with a non-default
   port and asserts the server lands on that port.

2. **Persistent node-agent plist** so the agent survives login.
   `agent.yaml` already exists at `$DEV_STORAGE/agent.yaml` with the
   right fingerprint. Plist needs to set `LLAMA_CPP_BIN` to the
   atomic-fork build dir as part of `EnvironmentVariables` — same
   TCC caveat applies (script outside `/Volumes/*`).

After both, the apply sequence becomes:

```
launchctl unload ~/Library/LaunchAgents/dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist
llamactl apply -f templates/workloads/gemma4-26b-a4b-mtp-local.yaml
curl http://127.0.0.1:8181/health   # green
llamactl get workloads              # shows it Running
```

And the standalone plist + serve.sh can finally be retired.

## What this revealed

llamactl's workload model is single-port-per-agent. That's an OK
default for a one-model-at-a-time laptop setup but breaks the moment
you want two workloads serving different models on different ports
from the same machine. The maestro pilot is the first concrete case
exposing this; it won't be the last (think: a code-completion model
on one port, a vision model on another, both managed locally).

The fix is small and well-scoped (Unblock step 1 above). Not in
scope for this session.
