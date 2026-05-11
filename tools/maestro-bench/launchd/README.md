# Launchd supervisor for the maestro pilot

**Status: opt-in only — requires Full Disk Access grant.** The atomic-fork
binary, the gguf files, and this very serve script all live under
`/Volumes/WorkSSD/`. macOS TCC blocks launchd-spawned child processes
from reading `/Volumes/*` unless the parent (`/bin/bash`) has been
granted Full Disk Access in System Settings → Privacy & Security →
Full Disk Access. Without that grant, attempting to load the plist
results in `last exit code = 126` (script not executable) — confirmed
empirically.

Two options:

## Option A — Foreground / tmux (recommended for pilot)

No system permissions required. Run the server in a long-lived
terminal session:

```sh
tmux new -s maestro-gemma4-26b-a4b-mtp \
  bash /Volumes/WorkSSD/repos/personal/llamactl/tools/maestro-bench/serve.sh
```

Detach with `Ctrl-b d`, reattach with `tmux attach -t
maestro-gemma4-26b-a4b-mtp`. Survives terminal closure but not reboot
(re-run after login).

## Option B — Launchd persistence (requires FDA)

If you accept the security tradeoff of granting Full Disk Access to
`/bin/bash`:

1. System Settings → Privacy & Security → Full Disk Access → `+` →
   add `/bin/bash` (or use `/usr/local/bin/bash` if you've installed a
   homebrew bash you prefer).
2. `bash tools/maestro-bench/launchd/install.sh`
3. Verify: `launchctl print gui/$(id -u)/dev.llamactl.maestro-gemma4-26b-a4b-mtp`

Uninstall: `bash tools/maestro-bench/launchd/uninstall.sh`.

## Files

Server (always-on):
- `dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist` — launchd manifest
- `install.sh` — copy plist to `~/Library/LaunchAgents/` and bootstrap
- `uninstall.sh` — bootout, delete, and kill residual server

Regression sweep (daily at 03:17 local):
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

## Why not just move everything to `$HOME`?

The atomic-fork checkout is ~6 GB, the Gemma 4 gguf is 17 GB. Moving
those under `$HOME` to satisfy TCC would split the source-of-truth from
the rest of the `/Volumes/WorkSSD`-anchored llamactl tooling. Pilot
intent is "verify the maestro works"; FDA grant is the lighter touch.
