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

- `dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist` — launchd manifest
- `install.sh` — copy plist to `~/Library/LaunchAgents/` and bootstrap
- `uninstall.sh` — bootout, delete, and kill residual server

## Why not just move everything to `$HOME`?

The atomic-fork checkout is ~6 GB, the Gemma 4 gguf is 17 GB. Moving
those under `$HOME` to satisfy TCC would split the source-of-truth from
the rest of the `/Volumes/WorkSSD`-anchored llamactl tooling. Pilot
intent is "verify the maestro works"; FDA grant is the lighter touch.
