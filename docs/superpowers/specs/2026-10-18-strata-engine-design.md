# Strata engine adapter — host a GGUF through Strata

Status: design, implemented
Date: 2026-10-18
Predecessor: MLX Sub A spec (`docs/superpowers/specs/2026-05-18-mlx-engine-sub-a-design.md`),
which introduced the `EngineAdapter` registry + `kind: ModelHost`.

## 1. Goal and scope

llamactl gains a third engine adapter, `strata`, alongside `llamacpp`
and `omlx` (`packages/core/src/engines/strata.ts`). It hosts one GGUF
model through a Strata deployment so AMD/HIP hosts can serve GGUF via a
Strata build with an MTP head, reusing the `kind: ModelHost` lifecycle
already built for oMLX (apply / reconcile / status / teardown, the same
route table, the same `/v1/models` proxy surface).

Out of scope: multi-model hosting, remote-node placement beyond `local`,
and any Strata-internal tuning — those stay in Strata's own run config.

## 2. What the engine runs

A single ModelHost process is the Strata HTTP server: the `strata-server`
symlink (a Python interpreter) launching `serve/server.py` with
`--engine strata --config <file>`. That server in turn spawns a **native
engine child** — the actual inference worker — as a direct child in the
server's own process group (a plain `subprocess.Popen`, no `setsid` /
`start_new_session`). llamactl signals the whole process group when the
server leads its own group (llamactl's detached spawn), and only the
server pid otherwise; the adapter is responsible for reaping the engine
child, which can outlive the server.

## 3. ModelHost contract

The adapter's `validateSpec` + `prepareLaunch` enforce:

- `spec.binary` is required (no PATH fallback) and its basename must be
  `strata-server`. llamactl identifies a running host by argv0 basename,
  so the symlink name is the only stable process handle.
- `endpoint.host` must be loopback or `0.0.0.0`. The run config's `host`,
  if present, must also be loopback. Strata is loopback-only here.
- Exactly one `hostedModels` entry.
- `extraArgs[0]` must end in `serve/server.py`; `extraArgs` must contain
  the pair `--engine strata` and a `--config <file>` whose target exists.
- `extraArgs` must NOT contain `--host` or `--port` — the adapter owns
  them and appends `{endpoint.host}` / `{endpoint.port}` after extraArgs.
- The `--config` file must parse as a JSON object. Within it:
  - `args[--native]` must resolve to the models dir — `LLAMACTL_MODELS_DIR`,
    falling back to `LLAMA_CPP_MODELS` — joined with `<hostedModel.rel>`
    (the rel must not escape the models dir) and that file must exist.
  - `model_name` or `aliases[]` must contain the hostedModel rel's
    basename, so the host advertises the model llamactl expects.

## 4. Readiness

`probeReady` delegates to `pollUntilModelIds`, which reports ready as soon
as `GET /v1/models` returns any model id, bounded by `spec.timeoutSeconds`
(same poll as oMLX). It does not match the id against the hosted model —
that check lives in the ModelHost adoption path
(`packages/remote/src/server/modelhost.ts`), which adopts a live host only
when its advertised ids include the hosted model's rel or basename.

## 5. Teardown

The native engine child is a direct child in the server's process group, so
a group-wide signal reaches it only when the server leads that group
(llamactl's detached spawn); an adopted server that is not a group leader
gets only its own pid signalled. `gracefulShutdown` waits for the server pid
alone, yet the engine can keep running after the server exits while it
releases its ~80 GiB of mappings / GPU memory. The adapter collects engine
children — matched by a standalone `--serve` argv token — while the server is
still alive to parent them, then:

1. Identity gate: if the recorded pid's identity cannot be verified
   (recycled pid, or its command no longer matches the expectation),
   teardown returns without signalling anything, mirroring
   `gracefulShutdown`'s refusal. A mismatched server must not take an
   unrelated process tree down with it.
2. Graceful SIGTERM to the server with a 60 s grace window.
3. Poll up to 180 s for each collected engine child to exit — so a restart
   never overlaps two engines — since `gracefulShutdown` has already returned
   once the server pid is gone.
4. Guarded SIGKILL on any child still alive — only after re-confirming
   `--serve` is still in its command line, so a recycled pid is never
   killed.

## 6. Child-env note (HIP / ROCm)

The ModelHost child env is built from an allowlist
(`CHILD_ENV_ALLOWLIST` in `packages/remote/src/server/modelhost.ts`):
only a fixed set of variables is inherited, and HIP / ROCm variables
(`HIP_VISIBLE_DEVICES`, `ROCR_*`, the AMD runtime paths, etc.) are not on
it — they get dropped even when present in the host environment. So the
Strata run config must carry them itself: the run config's `exe` wrapper
and its `env` block are where HIP / ROCm are set, since the adapter's
child env will not supply them.

## 7. Pilot template

`templates/workloads/strata-host-local.yaml` is a single-model `local`
pilot: `kind: ModelHost`, `spec.engine: strata`, `strata-server` binary,
loopback `:8080`, and the required `--config` extraArg. The manifest
comments restate the argv0-symlink, `serve/server.py`, and
`--native`/`aliases` requirements that prepareLaunch rejects on.

## 8. Switching the hosted model

Two settings name the model, and `prepareLaunch` refuses to launch while
they disagree (§3):

- the manifest's `spec.hostedModels[0].rel`, relative to the models dir
  (`LLAMACTL_MODELS_DIR`, falling back to `LLAMA_CPP_MODELS`);
- the run config's `args[--native]`, an absolute path that must equal
  `<models dir>/<rel>`.

When only one of them changes, every reconcile pass fails with
`strata run-config <file> --native must be <models dir>/<rel> (models dir + ModelHost spec.hostedModels[0].rel "<rel>"); got <path>. Update the run-config --native and the manifest rel together.`
The host stays down until both agree. `controller serve` logs the error once
to stderr as a `WARN` line, repeats it every 10 minutes while it lasts, and logs
one line when the host recovers. It also records a `ReconcileError` condition
(reason, message, first and last seen, failing-pass count), which
`llamactl describe workload <name>` prints under `Conditions:`.

Change the pair as one edit:

1. Run config:
   - `--native`: the new shard;
   - `--ple-gguf`, `--pack` and the tokenizer: the files that belong to the
     new quant;
   - `model_name` / `aliases`: must contain the new rel's basename (§3).
2. Manifest:
   - `spec.hostedModels[0].rel`: the new shard, relative to the models dir;
   - `spec.resources.expectedMemoryGiB`: the new resident footprint, since
     admission budgets against it.
3. Validate before anything restarts. The drift restart tears the running
   engine down before `prepareLaunch` reads the new run config, so an
   inconsistent pair takes the seat down instead of being rejected up front:

   ```sh
   models="$LLAMACTL_MODELS_DIR"   # or $LLAMA_CPP_MODELS
   rel=<new rel>
   jq -r '.args as $a | $a[($a | index("--native")) + 1]' <run-config>.json
   # must print exactly: $models/$rel
   test -f "$models/$rel" && echo present
   jq -r '.model_name, (.aliases // [])[]' <run-config>.json | grep -Fx "$(basename "$rel")"
   ```

4. Apply the manifest (`llamactl apply -f`, or edit it in the workloads dir).
   The spec hash changes with `rel`, so the controller restarts the host with
   the new pair on its next pass. Editing only the run config changes no hash:
   nothing restarts until the host is bounced, and then it fails as above.
5. Watch `llamactl describe workload <name>` and the controller's stderr until
   the host is Running again.

## 9. Memory budget and co-located jobs

A resident Strata seat pins most of a 128 GB unified-memory host. On the Z13
(124 GiB visible, 8 GiB swap) it holds about 90 to 97 GiB: the expert cache in
GTT plus the PLE table (about 27 GiB, mlocked under `--ple-io ram`, reclaimable
under `--ple-io mmap`). That leaves about 25 to 30 GiB for everything else. A
typed `eslint` or a full `bun test` can take 10 to 27 GiB, so two of them beside
the seat exhaust memory. The kernel OOM killer then picks Strata: its score
counts the ~27 GiB of file pages it can see but not the GTT, and killing it
frees about 97 GiB.

Rules for the seat host:

- Dev jobs must run memory-capped and serialized, e.g. inside
  `systemd-run --user --scope -p MemoryHigh=… -p MemoryMax=… -p MemorySwapMax=…`.
  A scope does not accept `OOMScoreAdjust=` (systemd 255 rejects it); wrap the
  command in `choom -n 900 --` to make the job the preferred victim. Job-side
  containment, admission and serialization are tracked in
  frozename/penumbra#250.
- Lower the seat's OOM priority. The user manager runs at
  `OOMScoreAdjust=100` and its units inherit a higher default (200 on the
  Z13). A hand-written user unit for the controller can set
  `OOMScoreAdjust=100`, the floor for an unprivileged unit under that manager;
  the engine is spawned as the controller's child and inherits it. Optionally
  add `MemoryLow=` for reclaim protection of the seat's page cache (it does not
  cover GTT).
- A negative `OOMScoreAdjust` needs privilege the user manager does not have:
  it takes a root-owned drop-in (for example on `user@<uid>.service`, which
  moves the floor for every unit under that manager) or a system unit with
  `User=`.

### Seeing an OOM kill

On Linux, `controller serve` reads its own cgroup's `memory.events` after each
pass. The engine runs in the controller's cgroup, and the kernel bumps
`oom_kill` there when it kills it. When the counter rises in the pass that
finds a local ModelHost engine dead, the controller logs
`modelhost/<name>: engine was OOM-killed (cgroup oom_kill N); restarting`
and records an `OOMKilled` condition (count, last seen, counter value) next to
the host's restart count (`restarts`, `lastRestartAt`, `lastRestartReason`).
A death without an OOM kill logs `engine had exited unexpectedly; restarted`.
Without cgroup v2 (macOS, cgroup v1 hosts) there is no OOM attribution, but
deaths are still logged and counted as restarts.

The last counter value is persisted in `<workloads dir>/.controller-oom.json`.
Under systemd's default `OOMPolicy=stop`, an engine OOM kill stops and
restarts the controller unit as well; with `KillMode=process` the cgroup and
its counter survive that restart, so the new controller still attributes the
kill on its first pass. `OOMPolicy=continue` keeps the controller running
through the kill instead.

Conditions live in `modelhost.conditions.json` beside `modelhost.state` in the
workload's runtime dir. Stopping a host keeps them; deleting the workload
removes them.
