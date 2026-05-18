# Maestro continuation prompt — 2026-05-11 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories


- `t2:d0150802-72ec-497e-a98a-3bae79a0a040` — Architectural Decision: Thread `branch_base` Through Narrowest Path

- `t2:af3adbd5-befc-485d-aa6d-738295850a6b` — User Preference: Focus on Smallest Failing Tests First (TDD Approach)

- `t2:6cb9bd73-1d13-4676-a67f-9ed231d4eb68` — Long-Lived Domain Fact: Worktree Manager Supports `baseRef`

- `t2:cf9101f6-dcf9-4c9a-829d-a1ba9a2dbfc3` — Trap: Initial Worktree Test Idea Inadequate

- `t2:9086cc0a-a279-48b9-bae5-5ceac263466e` — Trap: Schema Layer vs. Actual Table Mismatch

- `t2:67d7899a-f88c-40c2-8bb5-f183d4a17e3a` — User Preference: Stage Only Intended Source and Test Edits

- `t2:a63852e5-1ff3-4a72-9c8d-d6e040acc3d9` — Project Rule: Handoff Writer and Schema Must Persist `branch_base`

- `t2:166d6ea2-1cab-40c9-98c2-6b1df41dacc8` — Typecheck guard for tasks indexing

- `t2:c9a4b7de-c5ed-479d-9e3a-566fb3e8b718` — Focused test suite for parser and sweeper edge cases

- `t2:8323dd8a-3e25-43dc-8134-3d2a6dcf1d50` — Repository-wide typecheck noise exclusion

- `t2:ad32fc1f-b7e7-409f-ac91-403bb4ff4c27` — Inline per-task prose into plan-runtime leaf prompts

- `t2:b9b1798e-00b5-45a6-81ca-6276feabff7e` — Regression Test Suite for Search Queries


### Commits since midnight

```
2d4f05f remote(mdns): assert synth host via PublishedAgent.host instead of mock state
3823442 maestro-bench: optional --redact-via penumbra scoring + --category filter
2340168 docs(handoff): end-of-session 2026-05-11 pm — open issues closed, dispatch routing notes
e84bcda remote(workload): thread resolveNodeIdentity through reconciler + composite paths
dc1b235 remote(workload): atomic save + per-dir mutex; resolve node aliases in port-collision check
755b2cb remote(test): make bonjour-service mock functional for discovery
7a09685 cli(test): refresh catalog builtin count after granite-4.1 additions
291253b eval(report): keep depth literal types when iterating retrieval scores
3dbe187 docs(handoff): end-of-session 2026-05-11 — open issues + pickup plan
0fbf40a remote(workload): tighten port-collision preflight per adversarial review
6d8fe05 remote(workload): reject port collisions in applyOne preflight
f4f4006 maestro-bench: required_text_regex_in_args is no-op without a tool_call
480c55e core+remote: address adversarial-review findings on per-workload port
c58af95 maestro-pilot: retire standalone plist, run under llamactl workload mgmt
d7a5ec3 templates(workloads): drop --port hack from gemma4-26b-a4b-mtp-local
c6b2dda core(server): honor manifest spec.endpoint.port/host at launch and readiness
c478e79 docs(spec): update maestro-workload-blocked with real root cause
ec46d02 maestro-pilot: tcc-safe launchd path; deferred workload template
fad12c0 docs(spec): bench-maestro + packages/eval convergence (design-only)
30a9ee8 maestro-bench: macOS notification on sweep regression/error/unreachable
fa061cc docs(handoff): maestro output redactor landed; one rule-tighten follow-up
2204e1d docs(spec): maestro output redactor validation report
4ccbc93 docs(plan): maestro output redactor implementation plan (penumbra)
6cd0f1b docs(spec): maestro output redactor design (penumbra Ask 1 input)
0fbe342 docs(handoff): ack to penumbra team; Ask 5 done, validation pass queued
7577adb maestro-bench: regression-sweep harness + daily launchd plist
5491bce docs(handoff): wiring-ready handoff for penumbra team
9791ffe maestro-pilot: serve.sh + launchd manifest + wiring doc
cc89a1b docs(handoff): penumbra-team replies on maestro pilot follow-ups
6e9d37e docs(handoff): penumbra-team handoff from local-maestro pilot
454fb65 maestro-bench: expand from 8 to 36 tasks across 10 categories
d8e83b4 tools(maestro-bench): penumbra maestro-role bench
7372228 docs(mtp): point at inline suggestion on #22673 (PR #22941 was closed procedurally)
a58a931 mtp(qwen): root-cause investigation + upstream fix at PR #22941
```

### Commit context (bodies)


**`2d4f05f22bedb6658c3cc899ba0a89a6f8d6c23d`** — remote(mdns): assert synth host via PublishedAgent.host instead of mock state

publishAgentMdns now returns the synthesized host alongside `stop`. The
companion test asserts on that return field rather than reaching into
the vi.mock factory's `__lastPublished()` closure.

Under bun's single-process test runner vi.mock hoisting can race with
transitive imports from other suites, leaving __lastPublished undefined
when mdns.test.ts ran late in the file order. In isolation the test
passed (2/2); in the full remote suite that one test reported
"Received: undefined". With the assertion moved to the return value the
test no longer depends on the mock's internal state.

Full remote suite: 1394 pass / 6 skip / 0 fail (was 1393 / 1).



**`3823442e3b615caa5cf1cc8b29966e4fa96ff1cd`** — maestro-bench: optional --redact-via penumbra scoring + --category filter

Adds two CLI flags to bench-maestro.py:

  --redact-via {none,penumbra}   filter the haystack used for
                                 forbidden_text_regex through penumbra's
                                 MaestroOutputRedactor before regex match,
                                 so the bench score aligns with what users
                                 actually see after the runtime safety net.
  --category <name>              run only tasks in one category (faster
                                 iteration when smoke-testing one slice).
  --redact-known-agents <list>   override the known-agent set the redactor
                                 uses; defaults to the local fleet.

New helper at tools/maestro-bench/redact-haystack.ts is a one-shot bun
script that imports MaestroOutputRedactor from the colocated penumbra
checkout, reads {text, knownAgents} on stdin, writes {decision, content,
hits} on stdout. The Python harness shells out per grade() call when
redact-via is set; on subprocess timeout/error it falls back to the raw
haystack and appends an explicit "redactor invocation failed: ..."
reason — fail open with diagnostic, never silent.

Smoke (model=gemma4-26b-a4b-mtp-local, --category safety):

  raw scoring        3/4   refusal_prompt_injection fails on "exfiltrat"
  --redact-via penumbra  3/4   same — the redactor reports the response is
                                "clean" (no secret-shaped values), but the
                                forbidden pattern matches the topic word
                                "exfiltration" in the model's refusal
                                language ("...participating in any form of
                                data exfiltration...").

So the predicted 34/36 -> 35/36 lift did not materialize for this run.
The model's leak mode here is topic-word echo, not literal-secret echo;
the redactor cannot scrub topic words without over-redacting. The infra
remains correct and useful: when a model does echo a literal S
[…truncated]



**`2340168bc72150ed2d6e04a40161c82d49599f4d`** — docs(handoff): end-of-session 2026-05-11 pm — open issues closed, dispatch routing notes




**`e84bcda27c531974a54c6eed596ee6ec20afba19`** — remote(workload): thread resolveNodeIdentity through reconciler + composite paths




**`dc1b23561e9d5a19d32ab5b535e42d8f164c2d07`** — remote(workload): atomic save + per-dir mutex; resolve node aliases in port-collision check

Two adversarial-review findings from commit 0fbf40a:

A2 — TOCTOU between concurrent applies. The previous preflight read
`listWorkloads()` and the caller wrote `saveWorkload()` after applyOne
with no in-process serialization, so two concurrent `workloadApply`
mutations hundreds of ms apart could both pass the port-collision
check and both write — re-introducing the flap-loop the preflight was
meant to prevent. Adds:

  - saveWorkload writes to `<target>.tmp.<pid>.<rand>` and renames,
    so a partial write can't leave truncated YAML on disk and a
    second writer can't clobber an in-progress write.
  - withWorkloadsMutex queues async work keyed by workloadsDir; the
    router's workloadApply wraps applyOne + saveWorkload under it,
    so list→check→save runs atomically within one controller process.
    Cross-process coordination still relies on the existing
    .controller.lock file.

D3 — cross-node alias false-negative. The collision filter compared
`spec.node` names verbatim, so two manifests on `local` and
`mac-mini` resolving to the same physical agent slipped past. applyOne
now accepts an optional `resolveNodeIdentity(name) => string | null`
in opts; the filter buckets by identity-or-name. router.ts wires it
to `kubecfg.resolveNode(cfg, n).node.endpoint`; the CLI workload and
expose paths wire it the same way. When the resolver returns null
(unknown node), the filter falls back to name-equality so a typo
doesn't accidentally relax the check.

Regression coverage in workload-concurrency.test.ts: concurrent
applies on the same host:port pick exactly one winner; cross-node
aliases that resolve to the same endpoint collide; nodes that resolve
to distinct endpoints don't.



**`755b2cb3cf39c3b5b5c0d2df53baf88b07a122f4`** — remote(test): make bonjour-service mock functional for discovery

The mdns discovery test publishes two agents via startAgentServer and
then expects discoverAgents to surface both. The previous mock stubbed
publish to a single `lastPublished` slot and returned an inert find()
browser, so every call to discoverAgents resolved to an empty list and
the discovery test was flaky-failing in isolation.

Replace the mock with a shared in-memory registry: publish() records
into a Set, find() emits each registered service on the next tick to
the browser callback, and stop() removes its entry. The synthetic-host
test still reads __lastPublished and works the same way. With this the
file now passes 2/2 in isolation; the remaining cross-file flake on
the synthetic-host test in full-suite parallel runs is a separate
bun-mock-hoisting issue documented in the previous handoff's lessons.



**`7a09685d77a4f5fdf6f3ff975931d4b07031c8e0`** — cli(test): refresh catalog builtin count after granite-4.1 additions

The builtin catalog grew from 10 to 12 entries when the granite41-8b-q4
and granite41-3b-q4 rows were added for the agentic-eval fleet, but the
count assertion never moved. Bump it and also assert the last two lines
contain the new entries so a future addition is caught explicitly rather
than failing on a silent count drift.



**`291253bb8b52f5ddf7891cbe763d09c23d54ab7c`** — eval(report): keep depth literal types when iterating retrieval scores

`[4096, 8192, 16384]` widens to `number[]` without `as const`, so the
map(depth => scores.get(depth)) call fails type-checking against
`Map<4096 | 8192 | 16384, number>`. Narrow the array literal back to
its key type so tsc agrees the lookup is well-typed.



**`3dbe187685614a3bfdcb7d54ab74b0cd73cac95d`** — docs(handoff): end-of-session 2026-05-11 — open issues + pickup plan




**`0fbf40a6afa5bd205282ace10ed0bca01b64e00e`** — remote(workload): tighten port-collision preflight per adversarial review

Six fixes to 6d8fe05:
- schema: drop .default() on endpoint.host/port so "unset" really
  means unset; launcher already falls back to env (Fix 1)
- preflight: skip candidates whose persisted status is
  phase=Failed/reason=PortCollision so a previously-rejected manifest
  doesn't poison the next preflight (Fix 2)
- preflight: return action='pending' instead of 'unchanged' on
  collision to match other early-error paths (Fix 3)
- test: round-trip through parseWorkload so unset-port coverage
  exercises the real production parser (Fix 4)
- preflight: normalize ::1 ↔ 127.0.0.1 as same host (Fix 5)
- test: assert on stable token (reason 'PortCollision') instead of
  full message in most tests (Fix 6)



**`6d8fe05fa61fc853aa7fa47b827413cd0d2d0e2e`** — remote(workload): reject port collisions in applyOne preflight

Two manifests on the same node with the same spec.endpoint.host:port
flap each other in the reconciler — second apply succeeds, controller
keeps restarting both, server bounces between PIDs every 15s. Detect
the collision at apply time by scanning other manifests in the
workloads dir and reject with a clear message before the workload
lands in the store.

Self-name is excluded so edit-and-re-apply still works. Unset
spec.endpoint.port is skipped (the bind port is determined by the
agent's LLAMA_CPP_PORT env, not known at apply time on the CLI side).
0.0.0.0 wildcard host is treated as colliding with any other host on
the same node.

Adds optional workloadsDir override on applyOne so the test injects a
temp dir; existing call sites are unchanged.



**`f4f4006ff7c8a7c59912db5e1fdd762c3c9ea931`** — maestro-bench: required_text_regex_in_args is no-op without a tool_call

The handoff_inspect_then_approve_multiturn test had a comment saying
"we accept either approve-with-id or a 'I'll wait for explicit go-ahead'
non-tool response", but the assertion fired unconditionally — when the
model picked the non-tool path (correctly), first_args was empty, the
regex didn't match against an empty string, and the test failed despite
the model doing what the test claimed to allow.

Guard with `if req_args_rx and first_args:` so the check only enforces
when a tool was actually called. The h-XYZ-7f3a multi-turn case is
unaffected because its expect_tool already requires a specific tool —
a non-tool response would fail expect_tool first.

Lifts pass_rate from 33/36 (91.7%) to 34/36 (94.4%).



**`480c55e9ad9d81c501983985ceed6bfb328ab52f`** — core+remote: address adversarial-review findings on per-workload port

Four findings from the review of c6b2dda, all fixed in one pass:

1. advertisedEndpoint() ignored the launch override. Mirror endpoint()'s
   signature and thread the override through every call site in
   startServer (~10 sites). The advertised URL now matches the bind.

2. serverStatus reported the agent's default port even when the sidecar
   pointed elsewhere, so status.endpoint/advertisedEndpoint disagreed
   with reality and the workload manifest persisted a stale endpoint
   string. Synthesize both URLs (and the /health probe URL) from the
   sidecar's host/port when validSidecar; otherwise fall back to env
   defaults. ServerStatus gains host + binary fields; status callers
   updated.

3. LLAMA_CPP_BIN was hardcoded in the node-agent plist, affecting every
   workload that agent launches. Added spec.binary to the ModelRun
   schema, plumbed it through router.serverStart -> applyOne ->
   startServer -> launchBackground, persisted into the sidecar, and
   removed the env hardcoding from the plist. Vanilla is the default;
   the maestro workload sets spec.binary to the atomic-fork build dir.
   readServerState tolerates sidecars without the binary field
   (backward-compat for any state file written before this commit).

4. apply.matches() ignored spec.endpoint and spec.binary, so changing
   only the port (or only the binary) silently skipped the restart and
   the new value never took effect. matches() now also compares
   endpoint host/port and binary against the live sidecar values.

Tests:
- New regression in server.test.ts for spec.binary -> spawn args
- ServerStatus shape change rippled to test mocks in workload-apply-
  preflight, gateway-handlers, composite-apply, composite-pipeline-
  apply, composite-pipeline-destroy

Manual verification: workload gemma4-26b-a4b-mtp-local applied via the
new path, llamactl describe shows endpoint=advertisedEndpoint=
http://127.0.0.1:8181 with host/port/binary populated from the sidecar.



**`c58af950f0491bff2a2a52d82ae70c1561abb299`** — maestro-pilot: retire standalone plist, run under llamactl workload mgmt

With c6b2dda (per-workload port honored at launch + readiness) and
d7a5ec3 (template cleanup) in place, the maestro pilot endpoint can
finally run as a regular llamactl-managed workload. This commit:

- Adds scripts/launchd/com.llamactl.node-agent.plist — per-user
  launchd plist for the local node-agent (required so `apply` has
  somewhere to land and so restartPolicy actually supervises the
  spawned llama-server). LLAMA_CPP_BIN is set to the atomic-fork
  build dir for the MTP head args. Follows the controller plist
  pattern (direct bun invocation, no intermediate bash) to sidestep
  the TCC restriction on launchd executing scripts under /Volumes/*.
- Deletes the now-redundant standalone artifacts:
  tools/maestro-bench/serve.sh,
  tools/maestro-bench/launchd/dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist,
  install.sh, uninstall.sh.
- Trims the launchd README to its remaining concern (regression sweep
  only) and points readers at the new bring-up sequence.
- Drops the maestro-workload-blocked status doc — no longer blocked.

Bring-up: install the node-agent plist, then
`llamactl apply -f templates/workloads/gemma4-26b-a4b-mtp-local.yaml`.



**`d7a5ec317269cadb66a2e2cfa5197d8629b6e1ac`** — templates(workloads): drop --port hack from gemma4-26b-a4b-mtp-local

Workaround was needed only while server.ts hardcoded LLAMA_CPP_PORT into the launch args. With spec.endpoint.port now honored, the workload comes up on 8181 cleanly without extraArgs trickery.



**`c6b2dda88a7e9f7459bfef03b64a9a7fbed95058`** — core(server): honor manifest spec.endpoint.port/host at launch and readiness

The launcher hardcoded --port/--host from the agent's LLAMA_CPP_PORT/HOST env and the readiness probe used the same. Manifests that set spec.endpoint.port to anything other than the agent default would come up on the override (via llama.cpp honoring later flags if extraArgs hacked one in) while the readiness probe still polled the wrong port, leaving the workload orphaned. Plumb spec.endpoint through startServer → launchBackground so port/host become per-launch overrides, and use them for the readiness probe too. Regression test covers both the spawn args and the probe URL.



**`c478e79b4244db0e28bd191bb40bfda2303248e3`** — docs(spec): update maestro-workload-blocked with real root cause

Initial blocker (node-agent not running) is fixable in-session — agent.yaml
exists with matching fingerprint; bringing the agent up unblocks the
connection step.

Real blocker is structural: server.ts launchBackground reads --port from
the agent's LLAMA_CPP_PORT env, not from the manifest's spec.endpoint.port.
A workload on a non-default port comes up on the override but the
readiness probe checks the agent's port and times out, leaving the
workload orphaned.

Doc now ends with a clean one-file unblock (resolve endpoint.port from
the manifest into launch args + readiness probe) plus the persistent-
node-agent plist as step two.

Template extraArgs gain --host/--port at the end as a hack-workaround,
documented, until step one lands.



**`ec46d02efacd8d2a4fb1680ddceebe614a099d4e`** — maestro-pilot: tcc-safe launchd path; deferred workload template

Two pieces tied to the same investigation:

1. Plist + install.sh fix: launchd's sandbox refuses to execve files
   under /Volumes/* without Full Disk Access. The plist now points at
   ~/.local/bin/llamactl-maestro-serve.sh and install.sh copies the
   script there before loading. uninstall.sh cleans up the HOME copy.

2. Workload template at templates/workloads/gemma4-26b-a4b-mtp-local.yaml
   plus a status doc explaining why it's not currently applied. The
   apply path needs a node-agent on 127.0.0.1:7843 which isn't running;
   the manifest is ready for when that prerequisite is solved.



**`fad12c041830eff77d56b5f8c00e5096f62f4789`** — docs(spec): bench-maestro + packages/eval convergence (design-only)




**`30a9ee85ed41fd35f2f2ba0d4479d28c5312c8b5`** — maestro-bench: macOS notification on sweep regression/error/unreachable

Adds a best-effort notify_user() via osascript that fires on the three non-clean exit paths (regression, bench_error, unreachable). The marker file stays the source of truth; this just stops daily sweep failures from sitting unread. Suppress with LLAMACTL_SWEEP_NO_NOTIFY=1 in cron contexts where notifications would be noise.




### Diff against main

```

```

### Dispatch summaries this session


- `bd224346-270a-4495-89f6-c9c26c2eb7d7` → **codex-acp-fast** [ok, 156s] — failures: ["agent.tool_call.failed"]

- `ed937cd2-4aee-4fef-bbda-188577b779d2` → **codex-mini** [ok, 54s]

- `e68502dc-b499-48d2-9c98-681f9660eb83` → **gemini-acp-pro** [failed] — failures: ["cancel.dispatched","cancel.received"]


### Pending handoffs



## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
