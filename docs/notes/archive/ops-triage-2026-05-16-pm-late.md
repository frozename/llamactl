# Ops triage — 2026-05-16 pm-late (Thread N)

Surfacing two recurring warn-level patterns in `~/.penumbra/launchd.daemon.out.log` that need a penumbra-side fix. Both are non-fatal (no tick outcomes change), but they spam the log every cron boundary and mask other failures.

## (A) gh-task-sync — 100% error rate, growing

```
{"level":30,"linked":17,"pushed":0,"pulled":0,"errored":17,"msg":"gh-task-sync: linked=17 pushed=0 pulled=0 errored=17"}
```

Every linked task errors at sync time; `errored == linked` and grows as new GH-linked tasks land (15 → 17 over the past ~15 min). **Push/pull counts are stuck at 0** — sync is completely broken.

The per-task error isn't logged at warn level so the actual failure path is invisible. First investigation step: bump per-task error logging in the gh-task-sync loop, or grep for stack traces in `~/.penumbra/launchd.daemon.err.log` around any `task-link-gh` call.

Suspected: the same `gh pr list ... dial tcp ... i/o timeout` family of network errors that hit pr-orphan-sweeper on 2026-05-15, or a missing token / scope problem after the recent `gh_repo` → `remote.{kind,repo}` registry-schema change.

## (B) task-refiner-{primary,escalation} federation-tools-listTools-failed — 15-min cron race

```
{"level":40,"err":"mcp_unavailable","server":"penumbra","agent_id":"task-refiner-primary","msg":"federation-tools-listTools-failed"}
```

Fires exactly at `:00 / :15 / :30 / :45` every 15 minutes for both refiners simultaneously. Pattern: cron-fired refiner tick races against the MCP federation tool-registry being ready.

Once-per-cycle, then recovers (refiners still run successfully). Cosmetic from a behavior standpoint but spammy.

Fix shape: either delay the refiners' first listTools by N seconds after cron fire, or have the federation export a "ready" gate the refiner can await.

## (C) home-mgmt symptom of (B)

Same `mcp_unavailable` error, sporadic for home-mgmt (10-min cron). Aligns with cases where home-mgmt's tick happens to fire while the federation is mid-init (e.g., right after a worker restart). Last-tick outcomes are still `success` — only the listTools call is briefly unavailable, and the agent retries or skips that step.

## Cosmetic / benign (no action needed)

- (D) `session-summarize event scan exceeded cap; truncating` (limit=500, total=501) — truncation is graceful; the cap could be raised if the summary feels short.
- (E) `chain-start unknown_project_id home-mgmt; dropping and continuing` — the Thread H Bug A soft-fall-back working as designed. Will stop firing once home-mgmt stops sending `project_id="home-mgmt"` on chain_start_simple.
- (F) `worker watchdog timeout` (12:10, 13:25) — worker restarts from earlier dispatch fumbles in this session. Healed itself.
- (G) `pr-orphan-sweeper ... dial tcp ... i/o timeout` (2026-05-15 02:01) — one-off network blip a day ago.

## Suggested next moves

1. Penumbra session: read `~/.penumbra/launchd.daemon.err.log` around a recent `task_link_gh` to find the gh-task-sync stack trace. Add per-task error logging at warn level.
2. Penumbra session: investigate task-refiner federation-readiness race. Either add a startup-grace gate in the refiner's tick or add an MCP federation "ready" signal.
3. Keep an eye on (A)'s `errored` count — if it stops growing while `linked` keeps growing, the underlying issue may have self-resolved.
