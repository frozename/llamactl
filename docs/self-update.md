# Updating a source install: `llamactl update`

`llamactl update` moves a host that runs llamactl from a git checkout to a
newer commit, or back, without stopping the model hosts the controller
manages. It is for source installs: a checkout whose controller
(`controller serve`) and agent (`agent serve`) run
`packages/cli/src/bin.ts` with bun as services. A compiled
`llamactl-agent` binary is updated with `llamactl agent update` instead.

```bash
llamactl update                     # --check: fetch, show what would change
llamactl update --apply             # update to origin/main
llamactl update --rollback          # back to where the last update came from
```

> **Existing deployments: set two variables first.** By default the history
> goes to `update-history.log` in the llamactl state home (`$DEV_STORAGE`, else
> `~/.llamactl`) and no heavy-job lock is taken. A host that updated with an
> earlier script (for example `llamactl-z13/bin/llamactl-update`, whose history
> is `llamactl-z13/state/update-history.log`) or serializes memory-heavy jobs
> behind a lock file should set, in the services' environment file or the
> shell:
>
> ```bash
> LLAMACTL_UPDATE_HISTORY=<existing update-history.log>   # keeps --rollback's default target
> LLAMACTL_UPDATE_HEAVY_LOCK=<host heavy-job lock file>   # held around bun install
> ```
>
> Without `LLAMACTL_UPDATE_HISTORY` the first `--rollback` has no history to
> read and needs an explicit `<ref>`.

## `--check` (the default)

Runs `git fetch` and changes nothing else. It reports:

- the current branch and commit, the target (`origin/main`, or `--ref <ref>`)
  and the commits in between;
- whether `bun.lock` or any `package.json` changed, so `bun install` will run;
- the target commit's CI state, from the `check` workflow
  (`gh run list --commit <sha> --workflow check`; `unknown` without `gh` or a
  GitHub `origin`);
- the controller and agent services, the agent's `/healthz`, and every
  managed model host (pid, endpoint, ready, idle);
- everything `--apply` would refuse.

`--json` prints the same as one JSON object on stdout; progress lines go to
stderr.

## `--apply`

`--apply` refuses, and changes nothing, when:

- the checkout has tracked local changes;
- the target does not contain the current commit (not a fast-forward);
- the target's CI is not `success` (override with `--allow-red-ci`);
- a service is down, the agent's `/healthz` is not `ok`, or a managed model
  host is not ready;
- it runs inside the controller or agent unit it is about to restart;
- the services cannot be matched to this checkout (see
  [Service managers](#service-managers)), or a unit's main process is a
  managed model host;
- a systemd unit's `KillMode` (`control-group`, `mixed`) would kill other
  processes in its cgroup when stopped;
- a local `main` branch has commits the target does not contain (the switch
  below would move `main` off them);
- dependencies changed, `LLAMACTL_UPDATE_HEAVY_LOCK` is set, and the lock is
  not free within 30 min.

Then it appends `from=<branch>@<sha> to=<sha>` to the history file and runs,
in this order:

0. When dependencies changed and `LLAMACTL_UPDATE_HEAVY_LOCK` is set, take
   the heavy-job lock first, before anything is stopped, and hold it until
   the controller has been started again (step 4). Nothing is stopped while
   waiting for it.
1. Stop the controller. `controller serve` exits by itself about 20 s after
   the checkout's HEAD moves (its source-staleness reload), so it must be
   stopped before the switch. The model hosts keep serving: they are separate
   processes the next controller adopts.
2. Switch the checkout to the target on branch `main`
   (`git switch -C main <sha>`, tracking `origin/main`). The first update of a
   checkout on a feature branch leaves that branch where it was, as the
   rollback ref.
3. `bun install --frozen-lockfile --ignore-scripts`, only when dependencies
   changed. New code cannot start without its dependencies (llamactl imports
   `@novaproto/*` from npm). It runs in its own process group with a 15 min
   timeout; a timeout or a signal kills the whole group, so no install keeps
   writing `node_modules` afterwards.
4. Start the controller (and release the heavy-job lock).
5. Wait, up to 90 s, until the controller reports every managed model host
   `unchanged`, then check that each host kept its pid (a changed pid is a
   warning: the controller restarted that host).
6. Wait for the model hosts to be idle, up to `--wait-idle` seconds (default
   600). This is best-effort: the agent is restarted when the time is up.
7. Restart the agent. It never reloads itself; its port is down for a few
   seconds, so a request in flight may fail once.
8. Verify: HEAD is the target, both services are active, the agent's
   `/healthz` is `ok`, and every model host answers `/v1/models`. The worker
   RPC `inferenceRpc.negotiate` outcome is printed for information.

If any step fails, the same procedure runs back to the previous ref (the
agent is restarted again only if the failed run got that far), the history
records `rolled-back to …`, and the command exits 1. If the rollback fails
too, the history records `failed …` and the command says what to check.

Whatever happens (a failed step, a failed rollback, an unexpected error, or
SIGINT/SIGTERM), the last thing the command does is start the controller if
it is not running, so it is never left stopped. A rollback that has to wait
for the heavy-job lock (the forward run had already released it) waits up to
5 min before stopping anything, then goes ahead without the lock; the
install stays memory-capped.

SIGINT or SIGTERM stops the procedure after its current step (an install is
killed), skips the automatic rollback, starts the controller, records
`failed … interrupted`, and exits 130. The checkout may then be at either
ref: run `llamactl update --check`, and `--rollback` if needed. A third
signal exits at once without that cleanup.

## `--rollback [<ref>]`

Runs the same procedure to `<ref>`: `branch@sha`, a sha, or any git revision.
Without `<ref>` it reads the history, newest entry first:

- an update or a rollback that verified: go back to where it came from (so a
  second `--rollback` undoes the first);
- an update that failed and was rolled back: skipped (the checkout is already
  back), the entry before it decides;
- an update whose rollback failed too, or that never finished: go back to
  where it came from;
- a rollback that failed or never finished: retry it (go to its target), so a
  re-run never turns around half way.

`main@<sha>` resets `main` to that commit;
another branch is restored only if it still points at the recorded commit,
otherwise the checkout is left detached at it. A rollback refuses only on
tracked local changes, an unmatched service setup, or running inside a unit
it restarts; it does not check CI or health.

## History

One line per event, appended to `$LLAMACTL_UPDATE_HISTORY`, else
`update-history.log` in the llamactl state home (`$DEV_STORAGE`, else
`~/.llamactl`; the same base as the kubeconfig and the workloads dir). With
`DEV_STORAGE` set that is `$DEV_STORAGE/update-history.log`, which is not
where an earlier update script kept its history: point
`LLAMACTL_UPDATE_HISTORY` at that file to keep it (the line format is the
same).

```text
2026-10-21T21:28:23.000Z from=feat/strata-engine@5b5bc51… to=5b91e5c0…
2026-10-21T21:29:41.000Z ok 5b91e5c
2026-10-22T09:02:10.000Z rollback from=main@5b91e5c0… to=feat/strata-engine@5b5bc51…
2026-10-22T09:03:02.000Z failed 5b5bc51 rollback failed (switch: …index.lock…)
```

## Service managers

`llamactl update` only stops, starts or restarts a unit it has matched to this
checkout, and never looks processes up by name. If it cannot match both
services, `--apply` and `--rollback` refuse and say what to configure.

**systemd (Linux)**: user units, default `llamactl-controller.service` and
`llamactl-agent.service`. A unit with a default name must be loaded and its
`ExecStart` must run `<checkout>/packages/cli/src/bin.ts controller serve`
(or `agent serve`). A unit named with `--controller-unit`/`--agent-unit` (or
the matching environment variable) is trusted, with a warning when its
command line does not show the checkout, e.g. behind a wrapper script.
The model hosts the controller starts live in its cgroup, so the controller
unit needs `KillMode=process`: with `control-group` or `mixed`, the updater
refuses whenever the unit's `cgroup.procs` lists anything besides its main
process (when the cgroup is unreadable, it falls back to the model hosts found
through their pid files). The same holds for the agent unit. It also refuses
a unit whose main process is a managed model host, which catches a wrongly
named unit. Stops, starts and restarts go through `systemctl --user`.

**launchd (macOS)**: default labels `com.llamactl.controller` and
`com.llamactl.agent` in `gui/<uid>`. The controller is stopped with
`launchctl bootout` and started with `launchctl bootstrap` from the plist
launchd reports for it, so a job registered without a plist cannot be updated;
the agent is restarted with `launchctl kickstart -k`.

Bun: the update installs with the bun binary in the controller's (or agent's)
command line, else the one running `llamactl update`.

## Configuration

Flags win over environment variables. The updater also reads the controller
unit's environment (`systemctl show -p Environment -p EnvironmentFiles`, so
unit specifiers are expanded, with `EnvironmentFile=` overriding
`Environment=` as systemd applies them; launchd: the job's environment), so
these can live in the services' environment file:

| Flag / variable                                            | Meaning                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `--ref <ref>`                                              | Target for `--check`/`--apply` (default `origin/main`).      |
| `--allow-red-ci`                                           | Apply although the target's CI is not green.                 |
| `--wait-idle <s>`                                          | Idle wait before the agent restart (default 600).            |
| `--json`                                                   | Machine output.                                              |
| `--repo <dir>`                                             | Checkout to update (default: the one running the CLI).       |
| `--service-manager <m>`                                    | `systemd` or `launchd` (default: by platform).               |
| `--controller-unit <n>`, `LLAMACTL_UPDATE_CONTROLLER_UNIT` | Controller unit or label.                                    |
| `--agent-unit <n>`, `LLAMACTL_UPDATE_AGENT_UNIT`           | Agent unit or label.                                         |
| `LLAMACTL_UPDATE_HISTORY`                                  | History file (set it on existing deployments, see above).    |
| `LLAMACTL_UPDATE_HEAVY_LOCK`                               | Heavy-job lock, held from before the stop until the start.   |
| `LLAMACTL_UPDATE_AGENT_URL`                                | Agent base URL, when not derivable from its unit and config. |
| `LLAMACTL_UPDATE_CONTROLLER_LOG`                           | Controller stdout file, when the unit does not say.          |
| `LLAMACTL_UPDATE_GH_REPO`                                  | `owner/repo` for the CI lookup (default: from `origin`).     |

The unit names are read from the process environment and flags only (the
unit's own environment cannot name the unit). Model-host pid files, the agent
config and the default history path are resolved with the controller unit's
environment, which wins over the shell's, so the update sees the state the
services use even from a shell that does not load their environment file.

The controller's output is read from the file its unit writes stdout to
(`StandardOutput=append:…` from `systemctl cat`, with `%h`, `%u`, `%U`, `%t`
expanded; or launchd's `StandardOutPath`), else from the journal. Without
either, the updater only checks that the controller stays up for 25 s and that
the model hosts kept their pids.

When workload manifests exist but no running model host is found, `--check`
and `--apply` warn: the runtime dir the updater resolved is probably not the
services' (check `LOCAL_AI_RUNTIME_DIR`).

## Memory and locking

On Linux with `systemd-run` and `choom`, `bun install` runs as

```bash
systemd-run --user --scope --collect -q -p MemoryHigh=12G -p MemoryMax=16G -p MemorySwapMax=1G \
  -- choom -n 900 -- <bun> install --frozen-lockfile --ignore-scripts
```

(systemd 255 rejects `OOMScoreAdjust` on scopes, hence `choom`). Without those
tools it runs the plain install and warns.

`LLAMACTL_UPDATE_HEAVY_LOCK` is not wrapped around the install: the updater
holds an `flock(1)` on it from before the controller stops until the
controller has started (step 0 to 4), in a child process that lets go when the
updater exits for any reason. The lock wait therefore never counts against
the install's timeout, and never happens while the controller is down.

## Where to run it

From a terminal, or as its own transient unit:

```bash
systemd-run --user --unit llamactl-update --collect \
  <bun> <checkout>/packages/cli/src/bin.ts update --apply
journalctl --user -u llamactl-update -f
```

Never from inside the controller or agent service (for example a tool the
agent runs): restarting the unit would kill the update half way. The updater
checks its own cgroup (Linux) or parent processes (macOS) and refuses.

Once HEAD has moved, the running updater does not load modules from the
checkout; everything after the switch runs as child processes and HTTP
probes.

## Probes

- Agent: `GET https://<bind>:<port>/healthz` must return `ok`. The address
  comes from the agent unit's `--bind`/`--port`/`--dir` flags over its
  `agent.yaml`; a wildcard bind is probed on `127.0.0.1`. TLS is not verified
  (the agent's certificate is self-signed) and no credentials are sent.
- Model hosts: ready when `GET /v1/models` lists a model. Idle, checked in
  this order: a JSON `/metrics` reports `live.state` `idle` with nothing
  `queued` (Strata; preferred, since its `/slots` ignores queued requests and
  is empty while the engine is down); llama-server's `/slots` lists slots and
  none is processing; llama-server's Prometheus `/metrics` request gauges are
  zero. Anything else is unknown and does not block.

## Exit codes

`0` check done, up to date, applied, or rolled back on request; `1` refused,
failed (after an automatic rollback), or an error; `2` usage error; `130`
interrupted by SIGINT/SIGTERM (the controller was started again).
