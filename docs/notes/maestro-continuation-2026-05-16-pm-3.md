# Maestro continuation — 2026-05-16 pm-3

> Paste this as the kickoff message in the next session.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state
(`handoff_get`, `chain_wait`, `chain_get_response`); never query sqlite
directly except for forensics. Keep commits and repo-facing text neutral —
no AI/tool attribution. Delegate substantive code via `chain_start`;
hand-implement only when the worker/daemon won't boot, the dispatch sandbox
blocks something structural, or the edit is small and inline.

This is the **8th** continuation note for 2026-05-16. Prior `-pm-2.md` at
`75f6c35` ended at 16:05 UTC. This session ran 19:05–22:45 UTC and produced
3 commits in llamactl + 5 commits in penumbra (4 substantive + 1 spec).
Slot `-pm.md` was auto-rendered by the session-handoff workflow during
this session; this `-pm-3.md` is the narrative.

## The through-line

This session opened with the previous note's first follow-up: **verify the
production lift of the few-shot prompt** landed at `penumbra@2a57160`. That
single goal cascaded into a real engineering arc with five distinct phases:

1. **Discovery** — `memory_efficacy_jobs` was empty and the rebuild route
   returned HTTP 503 with no env config. Tracing it back through the
   daemon turned up a structural mismatch: the route gated on a sirius
   env var the daemon plist had never set, and the legacy code path was
   coupled to a 50-line OpenAI client misleadingly named `createSiriusChat`.
2. **Decouple refactor** — wrote a spec, dispatched the refactor to
   `codex-acp-fast`, hit a pre-existing test-isolation bug
   (`mock.module` on source paths didn't intercept barrel imports),
   patched it via opts injection, landed.
3. **Adversarial review of the refactor** — fanned out 8 personas;
   3 actionable findings on my work + 5 from unrelated commits pulled in
   by my over-wide base_ref. Fixed the 3 (dead constructor field, observability
   logs, shared `resolveJudgeConfig` helper) in a follow-up commit.
4. **Production validation attempt** — switched daemon to mac-mini Qwen3-8B,
   triggered rebuild → 120/120 batch timeouts (shared with home-mgmt under
   concurrency=4). Stood up a dedicated local Qwen3-8B workload at `:8085`,
   re-ran → 751/751 classified in 18 min, 0 failures. Hand-reviewed all 51
   minority-class predictions: **all 51 are false positives.** The corpus
   is adversarial code reviews, not memory-failure findings.
5. **Corpus bootstrap diagnosis** — discovered that `t2_memory_verification_events`
   is fully scaffolded (table, writer, route, MCP tool) but holds zero rows
   because the human path is the only producer and no operator workflow
   naturally invokes it. Filed a penumbra spec to auto-fire `verifyMemory`
   at lane close so labels accumulate passively.

The arc moved from "structural fix" through "validation attempt" to
"why we can't validate" — landing on a clear next-step spec rather than a
finished verification.

## What this session shipped — commit-by-commit

### Penumbra side (5 commits, all on `main`)

**Phase A — the sirius decouple:**

- `6ab47d5` `docs(specs): memory-efficacy classifier — sirius decouple` —
  hand-written spec capturing: why the rebuild was 503'd (daemon plist
  lacked `PENUMBRA_SIRIUS_BASE_URL`; runner construction at
  `serve.ts:817-819` returned a no-op without it); why even setting it
  would void validation (defaults to `gpt-4o` while eval used Qwen3-8B);
  what the cleanest fix looks like (drop "sirius" naming + default to
  local OpenAI-compatible llama-server).
- `aa863e6` `refactor(core,daemon): decouple memory-efficacy classifier from
  sirius naming + local-first defaults` — dispatched to `codex-acp-fast`
  (`agent_recommend` confidence: 56 samples, 32% raw success, ~2min wall).
  Worker did all 14 file changes but stalled before commit because `bun
  test` hit pre-existing baseline failures (schema v15/v17 drift, worktree
  integration tests, module resolution, port-in-use) unrelated to the
  rename. **Hand-fix:** the agent's `memory-efficacy-job-runner.test.ts`
  rename surfaced a latent `mock.module`-on-source-path bug (the runner
  imports its reader functions via the `@penumbra/core` barrel, so source-path
  mocks never applied — the test had been broken on main with a different
  symptom). Patched by adding optional injection points on
  `MemoryEfficacyJobRunnerOpts` (defaults to barrel imports; production
  wiring unchanged). 25/25 targeted tests then pass. Landed via
  `dispatch_land mode=squash force=true` because main diverged during the
  dispatch (`1cd8565` chore landed in parallel).
- `cdbe013` `refactor(core,daemon): tighten judge-chat surface per adversarial
  review` — hand-written follow-up addressing 3 actionable findings from the
  8-persona adversarial review:
  - **HIGH** dead `model` field in `createJudgeChat` constructor (the agent
    added it during rename; original `createSiriusChat` didn't have it).
  - **HIGH** silent failure mode on unreachable endpoint — added
    `log.info({baseUrl, model, usedDefault*}, "judge endpoint resolved")`
    at both call sites for observability.
  - **MEDIUM** duplicated env precedence — extracted `resolveJudgeConfig()`
    helper, used by both efficacy runner and dispatch-refine route.
    The other 4 findings (sync I/O, dispatch-routing-guard ambiguity,
    registry warning, etc.) were from unrelated commits pulled in by my
    over-wide `base_ref` choice in the review; explicitly deferred in the
    commit body. **Adversarial review artifacts** live at
    `.penumbra/reviews/2026-05-16T19-49-38.521Z/`.

**Phase B — the corpus bootstrap spec:**

- `f57c8a5` `docs(specs): auto-fire memory_verify on lane close — bootstrap
  M-track corpus` — hand-written spec for the smallest change that
  unblocks production verification. Why it matters: today's session
  discovered that the verification audit trail
  (`t2_memory_verification_events`) is fully wired infrastructure with
  zero rows ever written, because no production workflow naturally calls
  `memory_verify`. The spec proposes auto-firing it at lane close. Risk
  is low because the writer is battle-tested; we're just calling it from
  a new site. Includes acceptance criteria, idempotency check shape, env
  gate (`PENUMBRA_MEMORY_VERIFY_AUTO_FIRE`), and explicit out-of-scope on
  `recall_miss` detection (separate inverse-join extractor).

Two other penumbra commits landed in parallel during this session but
were not authored here (`1cd8565` chore on test cleanup, `62c6e28` fix on
`routes/memory.ts:200` reviewsDir bug — which I would have written
myself if it hadn't already shipped). They show in `git log` but the
narrative arc above is what this maestro shipped.

### Llamactl side (3 commits)

- `695e786` `templates(workloads): qwen3-8b-local — dedicated memory-efficacy
  judge on :8085` — hand-written. Created because the mac-mini Qwen3-8B
  at `:8090` is shared with home-mgmt under `-np 2`, and the first rebuild
  attempt against it produced 120/120 batch timeouts (every classifier
  batch under concurrency=4 hit the 30s judge-chat timeout). The dedicated
  local workload at `:8085` ran the same rebuild with 0 failures in 18 min.
  Has a hardcoded `binary:` path because `${env:LLAMA_SERVER_BIN}`
  interpolation isn't honored by the local control plane on `apply` —
  worth fixing eventually but not blocking.
- `397fc7e` `docs(notes): M-track few-shot production verification — corpus
  shape blocks the lift measurement` — hand-written. Captures the
  validation outcome: pipeline now works end-to-end (751/751 classified)
  but the production corpus is adversarial code reviews, not memory-failure
  findings. **All 51 minority-class predictions are false positives.**
  The offline `+20.6 pp macro-F1` result stands but production verification
  is blocked on data shape. Three remediation paths sketched.
- `f969838` `docs(notes): M-track corpus bootstrap — auto-fire memory_verify
  path` — hand-written. Captures the deeper diagnosis: penumbra has no
  labeled production data anywhere (`t2_memory_verification_events` empty,
  `obs_type` NULL, failure-mode body text 0 hits across 237 t2 rows). The
  infrastructure is built but the producer never fires. Points at the
  penumbra-side spec for the fix.

## Dispatches this session

| Handoff | Agent | Outcome | Notes |
|---|---|---|---|
| `e73f1842` | `codex-acp-fast` | ok (122s wall), did not commit | Did all 14 file changes for the sirius decouple but stalled at commit because `bun test` had pre-existing baseline failures. Worker's claim that the failures were "unrelated baseline drift" was correct, but the runner-heartbeat test it touched had its own mock-isolation bug that I had to hand-fix before landing. |
| `adversarial-review` (8 personas) | mixed | ok | 8/8 personas completed, synthesis landed. The MCP socket timed out at 60s wall but the workflow kept running and produced `.penumbra/reviews/2026-05-16T19-49-38.521Z/synthesis.md` at 16:56. Surfaced 1 confirmed bug (dead `model` field) + 2 confirmed cleanups; rest of findings were scope confusion from the wider `base_ref`. |

No retries. The codex-acp-fast stall before commit is documented in memory
(`reference_dispatch_stall_trap`) and confirmed again here.

## Live state at session end

- **Penumbra HEAD on main**: `f57c8a5` (auto-fire memory_verify spec)
- **Llamactl HEAD**: `f969838` (corpus bootstrap note)
- **Penumbra daemon**: alive, reloaded 3 times this session. PID at session end ~46xxx.
- **Worker**: alive, attached to daemon.
- **`qwen3-8b-local` workload**: running, PID 83291 at session-end, restartPolicy: Always. Bound to `127.0.0.1:8085`. Validated with a 7.6s realistic-batch ping test.
- **`launchctl setenv`** active for this user session (will not survive reboot):
  - `PENUMBRA_JUDGE_BASE_URL=http://127.0.0.1:8085`
  - `PENUMBRA_REVIEWS_DIR=/Volumes/WorkSSD/repos/personal/penumbra/.penumbra/reviews`
- **`~/.penumbra/reviews` symlink**: removed (env var supersedes it). The
  earlier `ln -s ... .penumbra/reviews` was a 5-minute workaround that
  served its purpose and then got cleaned up when `PENUMBRA_REVIEWS_DIR`
  came online via the prior-day `penumbra@62c6e28` fix.
- **`memory_efficacy_cache`**: 802 rows. Distribution: 751 `not_memory_related`,
  41 `missed_registration`, 6 `memory_ignored`, 4 `recall_miss`. All 51
  minority-class predictions confirmed FPs by hand-review.
- **Penumbra daemon plist** has NOT been edited; the two env vars above
  are transient `launchctl setenv`. Persisting them across reboot is an
  open operator decision.

## Open follow-ups (concrete first moves)

1. **Land the auto-fire memory_verify spec** at
   `penumbra/docs/specs/2026-05-16-memory-verify-auto-fire.md`
   (commit `f57c8a5`). The spec is implementation-ready: ~60 min of work,
   STANDARD class, low risk. After landing, give it 5-7 days of operation
   to accumulate ~100+ labeled rows in `t2_memory_verification_events`.
   First move: `mcp__penumbra__agent_recommend(task_type=implement_substantial)`
   and dispatch.

2. **Persist daemon env vars across reboot.** Add `PENUMBRA_JUDGE_BASE_URL`
   and `PENUMBRA_REVIEWS_DIR` to `~/Library/LaunchAgents/dev.penumbra.daemon.plist`
   `EnvironmentVariables` block. 5-minute PlistBuddy edit. Skipped this
   session because the plist is user-managed outside the repo and worth
   an explicit operator decision rather than silent overwrite.

3. **Build the `memory_efficacy_corpus_build` consumer** for verification
   events — only after #1 has accumulated data. Joins to `dispatch_events`
   for the original finding text. Output schema: 4-class labeled
   `.jsonl` ready for re-eval of the few-shot prompt's `+20.6 pp` lift on
   production-shaped data. Will close the M-track decision contract
   validation slice part C.

4. **`recall_miss` extractor spec** — separate effort, called out in the
   auto-fire spec's "Follow-on" section. Requires the inverse join:
   t2 state at dispatch time × similarity threshold × evidence the recall
   didn't fire. Don't conflate with the auto-fire path.

5. **Fix `${env:LLAMA_SERVER_BIN}` interpolation on llamactl's local-node
   apply path.** The `qwen3-8b-local.yaml` hardcodes the binary path
   because the env-ref doesn't expand. Probably a 10-line fix in the
   llamactl control plane; lives in this repo. Not blocking but pollutes
   the template fleet.

## Memories worth reading first

The session-handoff workflow's auto-recall surfaced t2 entries that don't
reflect this session's actual content (older worktree threads). The
actually-relevant memories for picking up this session cold:

- **`project_memory_efficacy_sirius_decouple_2026-05-16`** — explains the
  refactor's why + what; also has the production-validation appendix
  appended later in this session.
- **`project_m_track_production_corpus_shape_2026-05-16`** — the wrong-corpus
  diagnosis. Why the few-shot lift can't be verified on adversarial code
  reviews.
- **`project_m_track_corpus_bootstrap_2026-05-16`** — the bootstrap fix
  (auto-fire `memory_verify`). Required reading before opening follow-up #1.
- **`reference_adversarial_review_workflow_cwd`** — confirms the workflow's
  cwd handling is fixed (penumbra@133bb12 from yesterday); the review this
  session worked correctly against the llamactl repo.
- **`reference_dispatch_stall_trap`** — the codex-acp-fast "edits cleanly
  but stalls before commit" pattern. Saw it again this session on
  handoff `e73f1842`.

## Decisions worth not re-litigating

- **`createSiriusChat` is just an OpenAI client.** The 50-line implementation
  was always provider-agnostic; the naming was misleading. The rename to
  `createJudgeChat` plus the local-first defaults are the right shape.
  Don't re-debate.
- **Auto-fire at lane close is the right corpus producer.** Operator-driven
  `memory_verify` was tried (the MCP tool exists) and never used in 237 t2
  memories worth of operation. Friction is the binding constraint; the fix
  is to make labeling a side-effect of an operation operators already do.
- **The `+20.6 pp macro-F1` result stands as offline evidence.** Production
  verification can't happen on the current corpus. Don't take the
  "0% precision on minority predictions in production" as refutation of
  the offline result — different distributions; not the same question.
- **Test injection on production opts (the `MemoryEfficacyJobRunnerOpts`
  optional fields) is intentional.** The adversarial-review's
  `architect` persona flagged this as boundary leakage; the `simplicity`
  persona defended it as a pragmatic fix. I sided with `simplicity`
  because the alternatives (mock.module on barrel paths, factory wrappers,
  internal test helpers) were all worse for the size of the problem.

## What NOT in scope for next session

- The K-track is still frozen; the rename to `uncommon-v0` plus the
  re-entry conditions stand from the prior pm-2 session.
- The mac-mini Qwen3-8B at `:8090` should stay shared with home-mgmt
  under `-np 2`. Don't move the memory-efficacy classifier back to it;
  the dedicated local `:8085` workload is the right home for it.
- No work on Granite tuning, Gemma 4 E4B re-eval, or other model fleet
  optimization — deferred from earlier pm notes.
- Don't trigger another full `memory_efficacy_rebuild` against the
  current corpus expecting different results. The corpus shape problem
  is the constraint; rebuilding doesn't move it.

## First moves for next session

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `git -C /Volumes/WorkSSD/repos/personal/penumbra log --oneline -5` → confirm `f57c8a5` (auto-fire spec) is still on main
4. Read `penumbra/docs/specs/2026-05-16-memory-verify-auto-fire.md` end-to-end
5. `mcp__penumbra__agent_recommend(task_type=implement_substantial)` and dispatch the auto-fire wiring per the spec
6. While that's running, decide with the user whether to also do follow-up #2 (persist daemon env in plist) and #5 (fix env-ref interpolation in llamactl local-apply)
