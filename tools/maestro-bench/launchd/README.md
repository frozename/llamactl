# Launchd supervisor for the regression sweep

The maestro pilot endpoint (Gemma 4 26B-A4B + MTP at `:8181`) used to
have its own standalone launchd plist in this directory; it has been
retired in favor of the llamactl-managed workload path. See:

- `templates/workloads/gemma4-26b-a4b-mtp-local.yaml` — the manifest
- `scripts/launchd/com.llamactl.node-agent.plist` — the per-user
  node-agent plist (required for `llamactl apply` to reach the local
  node and for `restartPolicy: Always` to actually supervise the
  workload across crashes)
- Commits `c6b2dda` (core: per-workload port) and `d7a5ec3` (template
  cleanup) — the unblock that made llamactl-managed workloads viable
  for non-default ports.

To bring up the maestro endpoint from scratch on a new machine:

```sh
cp scripts/launchd/com.llamactl.node-agent.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.llamactl.node-agent.plist
llamactl apply -f templates/workloads/gemma4-26b-a4b-mtp-local.yaml
```

This directory now only ships the regression-sweep plist.

## Regression sweep (daily at 03:17 local)

- `dev.llamactl.maestro-regression-sweep.plist` — launchd manifest
- `install-sweep.sh` / `uninstall-sweep.sh`
- Runs `tools/maestro-bench/regression-sweep.py` against the live
  `:8181` endpoint, archives per-run JSON under
  `$DEV_STORAGE/bench/maestro-pilot/regression/`, compares current
  pass_rate / aggregate_decode_tps to a rolling-median baseline over
  the last 7 runs.
- Exit codes (surfaced via stderr to launchd's logs):
  - `0` — clean, baseline updated
  - `1` — regression past threshold (10% pass drop or 20% tps drop)
  - `2` — server unreachable
  - `3` — bench harness exited non-zero
  - `4` — couldn't parse the bench output
- Markers: `regression-marker.json` is written on `1`/`2`/`3` and
  deleted on a clean run, so a simple `test -f` is enough to detect
  a known-bad state. `latest.json` always reflects the most recent
  successful run.
- macOS desktop notification fires on non-clean exit
  (`LLAMACTL_SWEEP_NO_NOTIFY=1` suppresses in cron-only contexts).
