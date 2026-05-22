# Maestro continuation prompt — 2026-05-22 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories


- `t2:985a7cb7-9ee2-4acf-8d12-ef082ad2e605` — Test-driven development workflow for engine registry

- `t2:3e993c19-dda3-4c29-8fb5-ac7e3106c8d1` — Split behavior change

- `t2:c0aa8d5a-3c76-456d-a7bb-dd854741dd9b` — Project commit workflow

- `t2:dcab4575-4056-4507-8eac-7ab9cf2c8ade` — README update requirement

- `t2:44dbaa8d-949d-4217-bbb1-f0d807353073` — Audit of synthetic `memory_ignored` rows

- `t2:b1dbbc85-3faa-43ae-aa4b-bcb901d9d923` — Handling of Hugging Face download lock during training

- `t2:1e0fd3a7-4972-4b44-8588-5b42eee890ef` — Escalated permissions for spike-work output directory

- `t2:602d2db5-6b25-4363-a4e9-2306e8dcac65` — Report shape adjustment for 4-way metrics

- `t2:982c51f8-9b01-45f7-a599-3bd50baf96b6` — Spike-work directory usage for train/eval artifacts

- `t2:c8759fac-3439-4426-b54e-b6503fdf46a2` — Eval script extended for 4-way framing

- `t2:e61173b3-fbf0-40c8-a7fa-aaad53882a75` — Parser enhancement for classification script

- `t2:7285722b-ae9a-4927-9e43-870ba2390b2c` — Commit message specification


### Commits since midnight

```
8e20729 feat(tools): threshold-driven memory cleanup LaunchAgent for mac mini
```

### Commit context (bodies)


**`8e20729756f27963484da38f346799e987074052`** — feat(tools): threshold-driven memory cleanup LaunchAgent for mac mini

Adds a 15-min interval LaunchAgent that kills the macOS background
daemons known to accumulate RAM on a 16 GB box running multi-model GPU
workloads (mediaanalysisd, photoanalysisd, photolibraryd, siri*,
spotlight*, sirittsd, TextThumbnailExtension, iconservicesagent).

Trigger is below-threshold (default 130000 free pages ≈ 2 GB).
Override via LLAMACTL_MEM_THRESHOLD_PAGES env. Daemons respawn on
demand so the kill is operationally safe (Photos opening, Spotlight
query, Siri invocation all bring them back).

Logs every run to ~/.llamactl-launchd-logs/memory-cleanup.log with
before/after free-page counts so we can see operational impact.

Install on mac-mini:
  scp tools/mac-mini-memory-cleanup.sh \
      mac-mini:/Users/<user>/.llamactl-agent/
  scp tools/com.llamactl.memory-cleanup.plist \
      mac-mini:~/Library/LaunchAgents/
  ssh mac-mini 'launchctl bootstrap gui/$(id -u) \
      ~/Library/LaunchAgents/com.llamactl.memory-cleanup.plist'




### Diff against main

```

```

### Dispatch summaries this session


- `99abdaa8-360d-4a11-b215-a5c9fd923f56` → **claude-acp-sonnet** [failed] — failures: ["cancel.dispatched","cancel.received"]

- `c745845f-1672-4b7e-98a9-6419c18391b9` → **codex-acp-fast** [failed] — failures: ["cancel.dispatched","cancel.received"]

- `1a2f8388-63e9-46c8-a861-e87a71c94c29` → **home-mgmt** [failed] — failures: ["cancel.dispatched","cancel.received"]

- `e68502dc-b499-48d2-9c98-681f9660eb83` → **gemini-acp-pro** [failed] — failures: ["cancel.dispatched","cancel.received"]


### Pending handoffs



## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
