# Session handoff — llamactl, 2026-05-11

Date: 2026-05-11 (end of session)
For: whoever picks this back up next session (likely me)
Pairs with: `docs/superpowers/handoffs/2026-05-11-penumbra-maestro-redactor-handoff.md`
and `docs/notes/2026-05-11-penumbra-to-llamactl-redactor-followup.md` (in penumbra repo)

## TL;DR

Big arc: maestro pilot endpoint moved from standalone launchd plist to a
fully llamactl-managed workload, with several layers of infrastructure
fixes required to make it actually work. Five-way model bench confirmed
the existing pick. Two-pass adversarial review on the port-collision
preflight. Twelve commits.

## What shipped (in order)

| Commit    | What                                                                                          |
| --------- | --------------------------------------------------------------------------------------------- |
| `fa061cc` | docs(handoff): maestro output redactor landed; one rule-tighten follow-up                     |
| `2204e1d` | docs(spec): maestro output redactor validation report                                         |
| `30a9ee8` | maestro-bench: macOS notification on sweep regression/error/unreachable (Improvement 2)       |
| `fad12c0` | docs(spec): bench-maestro + packages/eval convergence (design-only, Improvement 3)            |
| `ec46d02` | maestro-pilot: tcc-safe launchd path; deferred workload template                              |
| `c478e79` | docs(spec): update maestro-workload-blocked with real root cause                              |
| `c6b2dda` | **core(server): honor manifest spec.endpoint.port/host at launch and readiness**              |
| `d7a5ec3` | templates(workloads): drop --port hack from gemma4-26b-a4b-mtp-local                          |
| `c58af95` | **maestro-pilot: retire standalone plist, run under llamactl workload mgmt**                  |
| `480c55e` | **core+remote: address adversarial-review findings on per-workload port** (4 findings fixed)  |
| `f4f4006` | maestro-bench: required_text_regex_in_args is no-op without a tool_call (fixture fix → +2.8%) |
| `6d8fe05` | remote(workload): reject port collisions in applyOne preflight                                |
| `0fbf40a` | **remote(workload): tighten port-collision preflight per adversarial review** (6 findings)    |

Bolded entries are the architecturally meaningful ones.

## Architectural changes

### Per-workload port (c6b2dda → 480c55e → 0fbf40a)

The launcher used to hardcode `--port`/`--host` from the agent's env
(`LLAMA_CPP_PORT`/`LLAMA_CPP_HOST`) and the readiness probe used the
same. Manifests with a non-default `spec.endpoint.port` came up on the
override but the probe polled the wrong port → orphaned workload.

`spec.endpoint` is now plumbed end-to-end: launch args, readiness
probe, `serverStatus()` reads from the sidecar's recorded host/port,
`advertisedEndpoint()` honors the override, `apply.matches()` treats
endpoint or binary changes as restart-required, and a port-collision
preflight rejects two manifests claiming the same node:host:port.

### Per-workload binary (480c55e)

New `spec.binary` field on ModelRun. Plumbed through router →
applyOne → startServer → launchBackground. Persisted in the sidecar.
The maestro pilot manifest sets it to the atomic-fork llama-server;
the node-agent plist's `LLAMA_CPP_BIN` env was removed so other
workloads inherit the vanilla default.

See `docs/.../memory/reference_llamacpp_mtp_binaries.md` for the
binary-vs-model pairing matrix (Gemma → atomic fork, Qwen → upstream
PR #22673 build).

### Node-agent under launchd (c58af95)

`scripts/launchd/com.llamactl.node-agent.plist` — per-user agent on
`https://127.0.0.1:7843` so `apply` has somewhere to land. Pairs with
the controller plist. Direct bun invocation pattern to sidestep the
TCC sandbox restriction on launchd executing scripts under `/Volumes/*`.

### Standalone maestro plist retired (c58af95)

Removed: `tools/maestro-bench/serve.sh`,
`tools/maestro-bench/launchd/dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist`,
the matching install/uninstall scripts. The maestro endpoint now runs
as `gemma4-26b-a4b-mtp-local` via `templates/workloads/gemma4-26b-a4b-mtp-local.yaml`.

### Regression-sweep notifications (30a9ee8)

`tools/maestro-bench/regression-sweep.py` now fires a macOS
`osascript display notification` on every non-clean exit path
(regression, bench_error, unreachable). Suppress with
`LLAMACTL_SWEEP_NO_NOTIFY=1` env var in cron contexts.

## Bench results from this session

Maestro-bench post-evolution results (saved under
`/Volumes/WorkSSD/bench/maestro-pilot/post-evolution/`):

| Model                             |              Pass |   tps |  Wall | Routing | Safety |
| --------------------------------- | ----------------: | ----: | ----: | ------: | -----: |
| **Gemma 4 26B-A4B + MTP** (pilot) | **34/36 (94.4%)** | 42.21 |  86 s |     4/5 |    3/4 |
| Granite 4.1 8B (no MTP)           |     32/36 (88.9%) | 31.88 | 115 s |     5/5 |    1/4 |
| Gemma 4 31B Q8 + MTP              |     32/36 (88.9%) |  9.08 | 351 s |     4/5 |    2/4 |
| Qwen 3.6 27B + MTP                |     32/36 (88.9%) |  6.71 | 973 s |     5/5 |    1/4 |
| Granite 4.1 3B (no MTP)           |     30/36 (83.3%) | 63.28 |  41 s |     5/5 |    2/4 |

**Disposition**: Gemma 4 26B-A4B + MTP stays the pick. See
`docs/.../memory/project_bench_2026-05-11_post-evolution.md` for the
analysis (routing strength clusters by family, safety-leak rate is
inversely correlated with routing strength, Granite 8B is the closest
realistic alternative if routing accuracy matters more than safety-leak
prevention).

The bench fixture fix in `f4f4006` lifted the baseline from 33/36 to
34/36 by skipping `required_text_regex_in_args` when no tool was
called (the test's own comment said this was allowed but the matcher
ignored it).

## Open known issues — pick up next session

### Real bugs

1. **TOCTOU between concurrent applies** — `applyOne` reads
   `listWorkloads()` then later `saveWorkload()` with no file lock.
   Two `apply -f` calls hundreds of ms apart can both pass the
   port-collision check and both write, flap-loop re-emerges. Fix:
   atomic rename in `store.ts` writes, or a `flock` on the workloads
   dir. Out of scope for the preflight; needs its own commit.
   (Adversarial-review finding A2 from `0fbf40a`.)

2. **Cross-node alias false-negative** — two manifests on `node: local`
   vs `node: mac-mini` resolving to the same physical machine slip
   past the collision check. Operator footgun; fix would compare
   resolved node endpoints, not just names. Probably not urgent.
   (Adversarial-review finding D3.)

3. **Pre-existing test failures** (not introduced this session, but
   noisy on every test run):
   - `packages/remote/test/mdns-discovery.test.ts` — "finds both
     advertised agents and carries node+fingerprint metadata"
   - `packages/remote/test/mdns-publish.test.ts` — "publishes a
     synthetic host instead of the OS hostname"
   - `packages/cli/test/workload-e2e.test.ts` — "catalog list (no
     custom file) returns just builtin"
   - `packages/eval/src/report/render-card.ts(103)` — TS error
     "Argument of type 'number' is not assignable to '4096 | 8192 |
     16384'"
     Each is a few minutes of work. None blocks progress.

### Penumbra-side open

Per `docs/superpowers/handoffs/2026-05-11-penumbra-maestro-redactor-handoff.md`,
the penumbra team has two things on their plate:

- **F2 refactor**: collapse `walkAndRedact` into a
  `ValuePatternRedactor.redactValue(any)` primitive in `@penumbra/core`.
  Agentchat-side walker disappears. Pure consolidation.
- **Ask 3**: the `acting_on` envelope, still open from the original
  maestro-pilot handoff.

Nothing for llamactl to do here unless they ask.

### Bench follow-ups

1. **Safety/refusal_prompt_injection scored through redactor** — the
   bench grades raw model output, but penumbra's redactor catches these
   leaks before users see them. Adding a `--redact-via penumbra` flag
   to bench-maestro.py would align the bench with production behavior.
   Designed in the conversation, not implemented. Would lift Gemma
   26B-A4B to 35/36.
2. **Routing fail on `routing_implement_substantial_refactor`** — Gemma
   defaults to `plan_refine` for substantial refactors. System-prompt
   nudges were tried and _backfired_ (the extra context made the
   model leak forbidden artifacts in safety refusals 3× more often,
   regressing 32/36). Don't retry verbal-nudge approaches. A few-shot
   example might work but would bloat every dispatch.

## Lessons learned (don't repeat)

1. **The controller daemon caches its in-memory `applyOne` at startup.**
   Restarting just the node-agent isn't enough after core code changes
   — must also `launchctl kickstart -k gui/$UID/com.llamactl.controller`.
   Today's port-flap rabbit hole was 80% this.
2. **Codex agents default to the wrong repo when worktrees are stale.**
   `cd /Volumes/WorkSSD/repos/personal/llamactl` MUST be the first
   command in every dispatch prompt, with a verification (`pwd && ls
packages/`). Two dispatches today went to penumbra by accident.
3. **Bun's parallel test runs hit EADDRINUSE on port 0** — sequential
   `bun run --cwd packages/<X> test` produces a stable baseline of
   pre-existing failures; parallel runs introduce false fails that
   look like regressions. Always sequential when validating.
4. **Schema `.default(...)` defeats "is-unset" semantics.** The
   port-collision preflight initially relied on `port === undefined`
   to skip the check, but Zod parsing always filled in 8080. Real fix
   was dropping the default. When checking "user explicitly set X",
   don't rely on the absence of a value if the parser fills it in.
5. **System-prompt nudges that add context can REGRESS safety
   behavior** on models that already echo prompt content in refusals.
   Verified empirically on Gemma 26B-A4B: -2 net pass_rate.

## State at end of session

- Maestro pilot endpoint: `gemma4-26b-a4b-mtp-local` Running on `:8181`
  via llamactl-managed workload (`bun run cli get workloads` to verify)
- Node-agent: alive on `:7843`, launchd-supervised
- Controller: alive (PID 9271), reloaded post-`0fbf40a` so the new
  preflight check is in effect
- Working tree: clean
- HEAD: `0fbf40a remote(workload): tighten port-collision preflight per adversarial review`

## To pick up

1. Decide on TOCTOU (file lock vs atomic rename in store.ts).
2. Optional: chip away at the pre-existing test failures.
3. If time: redactor-aware bench scoring (lift safety category).
4. Watch for the daily regression sweep at 03:17 — if it fires a
   notification, the rolling-7 baseline picked up something.
