# Improvement 1 (Gemma 4 MTP as llamactl workload) — blocked

Date: 2026-05-11
Status: blocked on infrastructure prerequisite

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

`llamactl apply -f <manifest>` calls `workloadApply.applyOne` which
calls `getNodeClientByName('local')`. The kubeconfig
(`$DEV_STORAGE/config`) declares:

```yaml
- name: local
  endpoint: https://127.0.0.1:7843
  certificateFingerprint: sha256:ab7c…
```

Apply tries to contact a node-agent on `https://127.0.0.1:7843` and
fails with `Unable to connect`. Nothing is listening on that port.

`launchctl list | grep llamactl` shows only `com.llamactl.controller`
(the workload reconciler that watches
`$DEV_STORAGE/workloads/`). The actual per-node agent that `apply`
talks to isn't running.

## Why the granite workloads ran fine despite this

The granite41 workloads we saw running earlier this session were
applied at some prior moment when the node-agent was up, then the
agent stopped but the spawned `llama-server` PIDs kept running on
their own. The reconciler in the controller doesn't supervise them in
real time — it's the per-node agent that does, and it's not online.

So those servers were running orphaned, not actively managed. The
`mcp__llamactl__llamactl_workload_delete` calls succeeded because
they read the manifest, killed the tracked PID directly, and removed
the file. They didn't go through the node-agent path.

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

When the local node-agent is brought back up (separate effort —
investigate `com.llamactl.node-agent` plist or equivalent, listening
on 7843 with the cert pinned by the kubeconfig), the path is:

1. `launchctl unload ~/Library/LaunchAgents/dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist`
2. confirm port 8181 is free
3. `LLAMA_CPP_BIN=/Volumes/WorkSSD/src/llama.cpp-atomic/build/bin llamactl apply -f templates/workloads/gemma4-26b-a4b-mtp-local.yaml`
4. confirm `/health` on 8181, `llamactl get workloads` shows it
5. delete the launchd plist + install/uninstall scripts + serve.sh,
   plus `~/Library/LaunchAgents/dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist`
   and `~/.local/bin/llamactl-maestro-serve.sh`

Until then: Improvement 1 stays blocked.

## What this revealed

The node-agent absence is a real footgun. We thought the maestro
endpoint was outside llamactl management — turns out *all* local
workloads have been outside real-time management since whenever the
agent last stopped. Worth a separate investigation: do we want the
agent auto-started by launchd, do we want the controller to subsume
the node-agent role for `local`, or are we OK with the current
"apply-and-orphan" pattern for local-node workloads?

That's an llamactl-architecture question, not a maestro-pilot
question. Not solving it here.
