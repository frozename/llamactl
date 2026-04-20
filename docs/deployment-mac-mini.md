# Deploying llamactl on a fresh Mac mini

A checklist for turning a clean macOS host into a llamactl fleet
node. Every step is a single command you can paste; the tail of the
document covers troubleshooting for the two steps that commonly
trip up first-time deployments (LaunchAgent loops, FDA grants).

Estimated time: 20 minutes (plus model-cache rsync, which runs
unattended).

---

## 1. Prerequisites

- macOS 14+ on Apple silicon or Intel.
- Admin account (you will need `sudo` for `/usr/local/bin/`
  installs).
- Bun 1.3+ on PATH if building from source. Skip Bun if you intend
  to install from a signed release via `llamactl artifacts fetch`.
- Two APFS volumes (or one, if you can live without the split):
  - `AI-DATA` — runtime state, fast scratch, agent workdirs.
  - `AI-MODELS` — GGUFs, HuggingFace cache, Ollama models. Large
    and mostly read-only after first sync.
- If the Mac mini needs to be reachable from a remote MacBook,
  WireGuard (or Tailscale) already configured and peered.

---

## 2. Clean-slate prep

Remove prior AI stacks if any — they fight for ports (`11434`,
`7843`, `8080`) and for HuggingFace cache locations:

```sh
# Ollama, if present
brew uninstall --cask ollama 2>/dev/null || true
rm -rf ~/.ollama

# LM Studio CLI, if present
rm -rf ~/.lmstudio

# Any prior llamactl install
launchctl bootout gui/$(id -u)/com.llamactl.agent 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.llamactl.agent.plist
sudo rm -f /usr/local/bin/llamactl-agent
```

---

## 3. Dotfiles + DEV_STORAGE

Clone your dotfiles, apply baselines, then a `~/.zshrc.local` that
defines `DEV_STORAGE` and the model-cache env vars:

```sh
git clone https://github.com/<you>/dotfiles ~/.dotfiles
cd ~/.dotfiles && ./install.sh
```

Contents of `~/.zshrc.local` (create if absent):

```sh
export DEV_STORAGE=/Volumes/AI-DATA
export HF_HOME=/Volumes/AI-MODELS/huggingface
export HUGGINGFACE_HUB_CACHE=/Volumes/AI-MODELS/huggingface/hub
export LLAMA_CPP_ROOT=/Volumes/AI-MODELS/llama.cpp
export LLAMA_CPP_MODELS=/Volumes/AI-MODELS/llama.cpp/models
export LLAMA_CACHE=/Volumes/AI-MODELS/llama.cpp/.cache
export OLLAMA_MODELS=/Volumes/AI-MODELS/ollama
```

Symlink `~/DevStorage` to the AI-DATA volume so any script that
expects `$HOME/DevStorage` still works:

```sh
ln -sfn "$DEV_STORAGE" "$HOME/DevStorage"
```

The two-volume split is deliberate: `AI-DATA` holds the read-write
state of running agents + bench history + journals, so it can live
on a smaller fast SSD, while `AI-MODELS` holds the hundreds of GBs
of GGUFs and HF cache that are mostly read-only and can live on a
larger slower volume. If you only have one volume, point both env
groups at `$DEV_STORAGE` and move on.

---

## 4. Clone repos + install deps

```sh
mkdir -p "$DEV_STORAGE/repos/personal"
cd "$DEV_STORAGE/repos/personal"
git clone https://github.com/frozename/nova
git clone https://github.com/frozename/llamactl
cd llamactl && bun install
```

nova is a sibling, not a workspace — llamactl consumes it via
`file:../../../nova/packages/*`. `bun install` in llamactl resolves
both.

---

## 5. Build the binary

From the llamactl repo root:

```sh
bun run build:agent
```

Result lands at
`$DEV_STORAGE/artifacts/agent/darwin-arm64/llamactl-agent`
(or `darwin-x64` on Intel). Single-file, no runtime needed on the
target.

Alternative: skip the build and pull a signed release instead —
`llamactl artifacts fetch --version=v0.4.0 --verify-sig`. See
`docs/releases.md` for the full fetch flow.

---

## 6. Agent init

Generates the TLS cert, bearer token, and `agent.yaml`, and emits
a bootstrap blob the MacBook consumes in step 9:

```sh
$DEV_STORAGE/artifacts/agent/darwin-arm64/llamactl-agent agent init \
  --dir=$DEV_STORAGE/agent/mac-mini \
  --host=$(ipconfig getifaddr en0) \
  --bind=0.0.0.0 \
  --port=7843 \
  --san=$(ipconfig getifaddr en0),$(hostname -s).local,127.0.0.1 \
  --json > ~/mac-mini-bootstrap.json
```

`--host` is what the bootstrap blob advertises — typically the LAN
IP. `--san` controls which names/addresses the TLS cert is valid
for; include the IP, `.local` hostname, and loopback so the
MacBook can reach the agent however it routes.

---

## 7. Install as a LaunchAgent

```sh
llamactl agent install-launchd \
  --scope=user \
  --binary=$DEV_STORAGE/artifacts/agent/darwin-arm64/llamactl-agent \
  --dir=$DEV_STORAGE/agent/mac-mini
```

This resolves the binary (copies to `/usr/local/bin/llamactl-agent`
by default), renders the plist, writes it to
`~/Library/LaunchAgents/com.llamactl.agent.plist`, runs `plutil
-lint` on it, and loads it via `launchctl`. On success you get a
summary: label, PID, binary path, log dir.

Add `--dry-run` first if you want to see the rendered plist + the
`launchctl` commands before committing.

---

## 8. Full Disk Access grant (one-time, GUI)

This step has to happen through the GUI — `tccutil` can't grant
FDA to an arbitrary binary. Over Screen Sharing from the MacBook:

1. Open **System Settings → Privacy & Security → Full Disk
   Access**.
2. Click **+**, navigate to `/usr/local/bin/llamactl-agent`, add
   it, toggle it on.
3. Kick the service so it picks up the new grant:

```sh
launchctl kickstart -k gui/$(id -u)/com.llamactl.agent
```

Why this is needed: the agent reads certs from `--dir` (usually on
an external volume) and enumerates models under
`$LLAMA_CPP_MODELS` (also external). `launchd`-spawned processes
don't inherit the Terminal's FDA grant, so the binary needs its own
grant. The grant sticks to the binary path, so reinstalls over
`/usr/local/bin/llamactl-agent` inherit it automatically.

---

## 9. Smoke tests

On the Mac mini:

```sh
curl -sk https://127.0.0.1:7843/healthz
# -> ok
```

On the MacBook:

```sh
BLOB=$(ssh mac-mini 'jq -r .blob < ~/mac-mini-bootstrap.json')
cd /Volumes/WorkSSD/repos/personal/llamactl
bun run packages/cli/src/bin.ts node add mac-mini --bootstrap "$BLOB"
bun run packages/cli/src/bin.ts node test mac-mini
```

`node test` returns node facts (arch, core count, llama.cpp build,
bench history if present). If it does, the node is in the fleet.

---

## 10. Troubleshooting

**LaunchAgent loops with exit 78, no `stderr.log` appears** — TCC
is blocking writes to the external `--log-dir`. `install-launchd`
defaults `--log-dir` to `$HOME/.llamactl-launchd-logs/` which lives
on the internal volume, so this only bites if you overrode
`--log-dir` to an external path. Move the log dir back to internal
storage.

**Process starts but `curl https://…:7843/healthz` times out** —
almost always a missing FDA grant on the binary. Verify with:

```sh
launchctl print gui/$(id -u)/com.llamactl.agent | head -40
log show --predicate 'subsystem == "com.apple.TCC"' --last 2m
```

Look for `AuthValue: denied` on `kTCCServiceSystemPolicyAllFiles`
against `/usr/local/bin/llamactl-agent` — that confirms FDA is
missing. Redo step 8.

**Binary won't start after reboot** — the LaunchAgent label is
scoped to `gui/<uid>`, which needs a login session. For a truly
headless machine with no auto-login, use `--scope=system` instead
(LaunchDaemon, runs from boot without a login).

---

## Alternatives

Step 5 (local build) can be replaced by `llamactl artifacts fetch
--version=<tag> --verify-sig` for signed release installs. Step 7
can be replaced by `--from-release=<tag>` or `--from-source` to
skip the explicit `--binary=` pointer; both fold fetching/building
into the install-launchd command itself. The install flow ends
identically — `/usr/local/bin/llamactl-agent` under launchd,
serving the same `agent.yaml`.
