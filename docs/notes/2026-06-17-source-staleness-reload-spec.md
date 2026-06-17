# Control-plane source-staleness detection + auto-reload

> Fixes the gap found 2026-06-16: long-running control-plane services run from a git
> checkout, load their code/schema at startup, and silently mishandle new schema fields
> (zod strips unknown keys) until manually restarted. The controller ran 5 days stale;
> nobody noticed. A passive warning could go equally unnoticed, so the core fix is
> **automatic** self-reload, with a loud warning and an explicit deploy command as
> complements.

This note carries the design rationale followed by an **As-built (post-review)**
section recording what actually shipped and the limitations an operator must know.

## Environment (verified)
- 4 services run from `packages/cli/src/bin.ts` via launchd, all `KeepAlive=<true/>`
  (boolean → launchd ALWAYS restarts after any exit) with `ThrottleInterval=30`
  (`com.llamactl.{controller, fleet-supervisor, internal-proxy, node-agent}`). So a
  clean `process.exit(0)` IS a reload — launchd restarts the service with fresh code,
  and the throttle caps any reload churn at ≤2/min.
- Loops: controller `runReconcilePass` every `intervalMs` (default 10s); fleet-supervisor
  tick every `intervalMs` (default 30s). internal-proxy / node-agent are long-running
  HTTP servers with **no loop boundary** — they can't self-reload; the deploy command
  (below) is their only reload path.

## Signal: the running source's git HEAD
The deploy that caused the bug was a `git pull` adding the completionProbe schema field
while the controller kept running pre-pull code. So **the repo HEAD sha is the staleness
signal**: `startupRev != currentRev` ⇒ the on-disk source changed since this process
started ⇒ it is stale.
- `getSourceRevision()` (packages/core): `git -C <repoRoot> rev-parse HEAD` via
  `execFileSync` (no shell). `repoRoot` is derived from the running module path
  (`fileURLToPath(import.meta.url)` → walk up to the dir containing `.git`). Returns the
  sha, or `null` on any git failure / non-checkout.
- **Limitation (documented):** only detects *committed* changes. Uncommitted local edits
  don't move HEAD. Acceptable — deploys here are git pulls.

## Mechanism
1. **At startup**, each wired service captures `startupRev = getSourceRevision()` and logs
   whether detection is **ARMED** (`source-staleness reload ARMED at <sha>`) or **OFF**
   (`null` ⇒ not a git checkout — e.g. a compiled binary). Off ⇒ detection disabled for
   that process (fail-safe: never reload on an unknown rev).
2. **At a safe boundary** (after a completed pass/tick, before the sleep), read
   `currentRev = getSourceRevision()` and advance a pure stale-streak reducer:
   - `null`/empty read → NOT stale, streak unchanged (a read error is not a rev change).
   - `currentRev === startupRev` → not stale; streak resets to 0.
   - `currentRev !== startupRev` → streak + 1.
3. **Debounced reload:** act only once the streak reaches `reloadStaleChecks` (default 2)
   — a transient mid-`git pull` index state can't trigger a spurious reload.
4. **On confirmed staleness:** emit a structured warning (stderr + a `fleet-source-stale`
   journal entry where the service has one), then — if auto-reload is enabled —
   `process.exit(0)` at the boundary so launchd reloads fresh code.
5. **Auto-reload toggle:** on by default; disable with `--no-reload-on-source-change`.
   When disabled, the warning still fires (once per transition — see as-built) so the
   stale state can't be missed.

## Deploy command (complement)
`llamactl infra restart-control-plane [--dry-run]`: discover the control-plane launchd
labels from `launchctl list` at runtime (NOT from repo plists — the controller is
registered live-only with no plist on disk), then `launchctl kickstart -k
gui/<uid>/<label>` each. Covers the proxy/agent, which has no loop boundary to self-reload.

## Files
- NEW `packages/core/src/sourceRevision.ts` — pure stale-streak reducer + git-rev reader.
- EDIT `packages/cli/src/commands/controller.ts` — startupRev capture + boundary gate.
- EDIT `packages/fleet-supervisor/src/loop.ts` (+ `supervisor.ts` injection) — tick boundary.
- NEW `restartControlPlane` in `packages/remote/src/infra/services.ts` + `infra.ts` wiring.
- Tests in the owning packages.

## Safety invariants (the risk surface)
- NEVER exit on a git-read error or `null` rev (only on a CONFIRMED rev change).
- NEVER exit mid-pass/mid-tick — only at the loop boundary, after the pass completes.
- Debounce ≥2 so a transient `git pull` index state can't spuriously reload.
- `exit(0)` (clean) so launchd treats it as a normal stop+restart. No tight loop: after
  reload the new process captures the NEW HEAD as its `startupRev`, so `startupRev ===
  currentRev` ⇒ streak 0 ⇒ it won't immediately re-exit (pinned by a reload-loop test).
- Injectable rev-reader + exit fn so tests never shell out or kill the process.

---

## As-built (post-review, 2026-06-17)

Shipped across 5 commits (`5fb8708` core, `20ad256` supervisor, `c8dc428` controller,
`5369378` restart-control-plane, `265b10e6` review-hardening). Three adversarial review
lenses (risk / correctness / integration) ran on the green branch; the lock-brick
hypothesis was **disproven** (a reloading controller's `process.exit(0)` skips the
`finally` lock release, but the next controller steals the orphaned lock via the existing
dead-PID steal path — a reload is indistinguishable from a crash, which is already
handled). The review drove these hardening changes:

- **ARMED/OFF startup logging** (controller + supervisor) — see Mechanism step 1. Without
  it, a service on a compiled binary is silently inert (see limitation below).
- **Fail-closed allowlist** for `restart-control-plane`: targets are restricted to
  `CONTROL_PLANE_LABELS` (the 4 known services), not every `com.llamactl.*` job — a stray
  `StartInterval` cron (e.g. `com.llamactl.memory-cleanup`) matches the prefix but must
  never be force-kickstarted off schedule.
- **Log on transition, not per boundary**: the warning + journal entry fire only when the
  `(currentRev, reloading)` signature changes. Prevents unbounded stderr growth under
  `--no-reload-on-source-change`, where the source stays changed forever.
- **`execFileSync`** (no shell) for the git read; **CRLF strip** on launchctl labels;
  **`--node` rejected** on `restart-control-plane` (launchd is per-machine).

### Limitations an operator must know
1. **Compiled-binary nodes are NOT self-reloading.** Inside a `bun build --compile`
   binary, `import.meta.url` resolves under `/$bunfs/...`, so `getSourceRevision()`
   returns `null` and detection is OFF (the startup log says so). The mac-mini supervisor
   runs the compiled binary today — it relies entirely on `restart-control-plane` (or a
   reinstall) after a deploy. This is correct, not a bug: a frozen binary's "staleness" is
   a different concept (binary version), and the source-tree HEAD it was built from moving
   does not mean the running binary changed.
2. **`restart-control-plane` is darwin + local-machine only** and not `--node`-aware — run
   it on each node's shell. It hard-restarts the proxy/agent, dropping in-flight requests;
   `--dry-run` previews targets first.
3. **Committed changes only** — a `git pull` deploy moves HEAD; an in-place edit without a
   commit does not.

### Known follow-up (out of scope here)
- `~/.llamactl/logs/*.stderr.log` have no rotation repo-wide (pre-existing, independent of
  this feature). The log-on-transition change bounds *this* feature's contribution, but
  the unrotated logs remain a separate cleanup.
