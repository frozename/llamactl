# Maestro continuation prompt — 2026-05-15 pm late

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate substantive code via `chain_start`; hand-code only when the worker/daemon won't boot.

**This session was a pivot.** The afternoon picked up the parser-trace plan from `maestro-continuation-2026-05-15-pm.md` but immediately hit a network blocker (off home LAN, mac-mini at 192.168.68.76 unreachable). We pivoted to network-independent work: a static analysis of the parser bug, a defensive patch to penumbra's ACP adapter, and a new direction the user wants to explore — **giving llamactl the ability to train / fine-tune models** so we can specialize a Qwen variant for the home-mgmt task and the memory-efficacy classifier task. The fine-tune work is unstarted; this note exists to seed that session.

## What this session shipped

### penumbra (committed)

**`8c76ed3 fix(agentchat/stdio-acp): cache toolCallId → title for failed update tool_name`** (this session)

The afternoon session's parser-bug investigation had the framing wrong. After reading `acp-agent.js` end-to-end, the truth is: `tool_call_update {status: "failed"}` is emitted from exactly one site (`acp-agent.js:2007`, the `tool_result` branch), and the spread from `toolUpdateFromToolResult` returns `{}` or `{content: [...]}` for every MCP tool. **Title/kind are intentionally absent on every MCP failure.** So `tool_name: null` in dispatch_events is the default for ha_pulse failures too — we just never saw them because ha_pulse usually succeeds.

This means the chain_start_simple-vs-ha_pulse divergence the prior session was chasing is NOT in claude-agent-acp's parser. It's upstream (either penumbra-mcp's handler errors, or llama.cpp's `--jinja` mishandling the tool definition). The parser trace still needs to happen — but with the right target.

Independent of root cause, this commit adds a per-prompt `Map<toolCallId, title>` populated at `tool_call` time and consulted as a fallback at `tool_call_update {status: failed}` time. Converts every past + future `tool_name: null` event into a usable name. Tiny change (~100 lines including a focused unit test that drives a fake session/update stream).

Dispatched to `codex-acp-fast` (handoff `abbc88cf-998f-4c3e-9579-5a78dd0bca45`). Worker timed out at the 8min watchdog without emitting `dispatch.end`, but the worktree diff was complete and clean — 34/34 `stdio-acp.test.ts` tests pass. Cherry-picked the diff to penumbra main rather than retrying the dispatch. Worktree torn down.

### llamactl (uncommitted, docs-only)

**`docs/notes/parser-bug-hypothesis-2026-05-15-pm.md`** (this session) — full static-trace findings:
- The `tool_call_update`-with-`failed`-status wire shape (one emission site, no title/kind for MCP tools).
- Why the afternoon session's framing was wrong.
- Two remaining hypotheses for why `chain_start_simple` fails specifically (penumbra-mcp handler errors vs. llama.cpp `--jinja` tool-definition mishandling).
- Concrete 5-step trace plan for when LAN is back: `--verbose` flag, mcp-allowlist-proxy stderr tee, penumbra-mcp stderr, two-tick differential, decision tree.

No code changes in this repo this session.

## The new direction (next session's headline)

**Give llamactl a "training" / "fine-tuning" surface so we can specialize local models for the workloads we already run.** Two concrete pilot targets the user named:

1. **Fine-tune Qwen3 for home-mgmt.** The current Qwen3-8B Q4_K_M on mac-mini :8090 is general-purpose. Home-mgmt's protocol (Priority-0 pending_goals, then per-tick `ha_pulse` → `state_get` → short-circuit-or-act → `state_set`) is highly structured. A small SFT or LoRA on a few dozen well-shaped (tool-call) ticks could (a) drop the standing_brief from ~3k tokens of system prompt to ~200 tokens, (b) eliminate the schema-confusion failures we've been chasing, (c) cut latency by ~30% if the model stops "thinking" through the protocol every tick. The afternoon's parser-trace work is also the right corpus generator for this — every successful ha_pulse trace IS one training example.

2. **Fine-tune Qwen3 for the memory-efficacy classifier.** The memory-efficacy bench landed 2026-05-15 (`project_qwen_5model_sweep_2026-05-15.md`) plateaued at 97.5% bucket_accuracy with `recall_miss` F1 stuck at 67% on Qwen3-8B Q4_K_M, and `memory_ignored` unreachable across all 5 models tested. Fine-tuning on the existing 470-finding corpus (which has the actual gold labels) should push both numbers. This task has the cleaner data story — it's already a classifier, not a multi-turn agent.

**Seed reference (now captured):** the user pointed at `https://www.reddit.com/r/LocalLLaMA/s/saMjzeR6mu`. WebFetch is blocked for reddit but the user pasted the gist. Full recipe + gotchas saved as memory `reference_tinyforge_zero_recipe.md` (linked in `MEMORY.md`). One-paragraph summary:

> **tinyforge-zero** — self-play SFT. The base model invents a problem + small test suite, attempts to solve N times, and the interpreter (Python for code, SymPy for math) decides which attempts pass. Training pairs are `(broken_attempt, working_attempt)` from the same model; no human-written data. Repo: `github.com/ranausmanai/tinyforge-zero`. Sample lift: Qwen 2.5 7B base HumanEval 25 → 112; Qwen 3 4B 79 → 106. Cost: ~$3.50 / 95min H100 for the 14B run. LoRA output.

### How the recipe maps to our two pilots

- **Memory-efficacy classifier (the right first target).** Existing 470-finding labeled corpus is above the recipe's ~100-pair threshold. Verifiable judge = JSON schema validator + label correctness against the corpus. Plain LoRA SFT on the existing data is the smallest viable slice; self-play expansion is optional later. Direct comparator: `project_qwen_5model_sweep_2026-05-15.md` (Qwen3-8B Q4_K_M baseline: 97.5% bucket accuracy, `recall_miss` F1 67% plateau, `memory_ignored` unreachable).
- **Home-mgmt (harder, second).** Training data must be mined from dispatch_events to hit ~100 clean `(failure → success)` tool-call pairs. The cache patch in penumbra `8c76ed3` is precisely what makes that attribution tractable — failed ticks now carry real `tool_name`. Judge would check tool_use shape + per-tick protocol (did it call `ha_pulse` first? did it write `last_pulse_id`?). Probably plain SFT on expert traces first, not self-play.

### Critical recipe gotchas (don't repeat these)

- **Train BASE models only.** Qwen 3 8B+, 14B, 72B all regressed in the original experiments — no slack for the model to mine its own mistakes from. Apply to `Qwen3-8B-Base` or equivalent, NOT the Instruct variants we currently serve.
- **Below ~100 pairs, fine-tuning HURTS** vs. `-np 2`-style multi-slot sampling from the base. At 36 pairs, training narrowed output diversity enough that sampling lost variance. Standard "always fine-tune when you can" advice is wrong below the threshold.
- **(wrong → correct) only pairs teach self-doubt.** For math, Qwen 3 4B went 60% → 14% on MATH-500 from training on corrections alone. Mix in (correct → correct) examples.
- **Stop-token / grader bugs are session-killers.** The original author lost a day to a grader truncating model output before scoring; the model looked broken when the grader was the bug. Validate the judge sees what the model emits before trusting any result.
- **Iteration plateaus at round 2.** Don't waste cycles re-mining with the trained model.
- **Code recipe ≠ math recipe.** Different judges, different curricula. Memory-efficacy ≠ home-mgmt for the same reason.

### Open design questions for next session

These should be the first conversation, before any code:

- **Framework choice.** MLX-LM (native Apple Silicon, fastest on M4 Pro for inference but historically thin on training surface) vs. unsloth (best perf/$ on H100 RunPod; the recipe author used H100 + ~$3.50 / 95min) vs. axolotl (config-driven, ecosystem-standard). The reddit author shipped a `tinyforge-zero` repo we can crib from rather than greenfield. **First read:** clone the repo and inspect what it actually depends on; that's likely the path of least resistance.
- **Where in llamactl does training live?** New `packages/train/`? A subcommand on `llamactl` CLI? A new `kind: ModelTraining` workload (parallel to `kind: ModelRun`) that the daemon manages? Probably yes — gives us per-node training jobs with the same admission + GPU-budgeting machinery we already have for serving. RunPod is the natural compute provider, like our existing cloud-gateway pattern.
- **Output path.** LoRA adapter, ~100MB, swap at serve via `llama-server --lora-adapter`. Keep Qwen3-8B Q4_K_M base unchanged. The catalog/promote/auto-bench loop in `packages/eval` is the natural fit for verifying lift before fleet promotion.
- **Base model availability.** We currently serve Qwen3-8B (Instruct). Need to confirm Qwen3-8B-Base is available on HuggingFace and the same Q4_K_M re-quantization path works for LoRA loading at serve time.

### What this session decided to NOT do

- **No parser trace this session.** LAN-blocked. Hypothesis doc at `docs/notes/parser-bug-hypothesis-2026-05-15-pm.md` is the resumption point when home.
- **No retry of the timed-out codex dispatch.** The worktree diff was complete; cherry-picking was strictly cheaper than re-dispatching.
- **No `dispatch_land` attempt on the failed handoff.** The handoff was `failed` (watchdog, no `dispatch.end`); cherry-pick to main avoided the protocol-edge case.
- **No new memory entries written this session.** The fine-tune direction has no actionable bites yet; the parser-bug hypothesis is in a doc not a memory because it's a working theory, not a closed finding.

## Live state at session end

- penumbra daemon: still up from session start (PID 87343 per the prior continuation)
- penumbra worker: still up (PID 57690 per prior; bounced 3x in the prior session, untouched this one)
- home-mgmt: **paused** (carried from afternoon). working_memory still has the chain_start_simple pending_goal + stale last_pulse_id. Resume only with the parser-trace plan in mind, or clear pending_goals first.
- mac-mini llama-server (Qwen3-8B :8090): **unreachable** — off home LAN. Network the only blocker; daemon-managed config unchanged.
- M4 Pro llama-server (Gemma 4 26B-A4B-MTP :8181): not touched this session; status carried from prior note ("still running from the failed Path B test — fine to leave").
- penumbra repo: clean except for ~28 untracked session-note docs (`docs/notes/*.md`). Two new commits this session (mine: `8c76ed3`).
- llamactl repo: clean except for 6 untracked session notes (5 from prior sessions + `parser-bug-hypothesis-2026-05-15-pm.md` from this one). No code changes.

## Open follow-ups (concrete first moves per thread)

**Thread 1 — Fine-tune pilot (the new direction, headline for next session)**

1. Read `reference_tinyforge_zero_recipe.md` first — the recipe, gotchas, and threshold finding are all in there. The reddit URL was captured into that memory; no need to re-fetch.
2. Clone `github.com/ranausmanai/tinyforge-zero` somewhere local (`/Volumes/WorkSSD/repos/personal/tinyforge-zero` or a tools/ subdir). Inspect what it actually depends on — that constrains the framework choice (MLX-LM vs unsloth vs axolotl) more than abstract discussion will.
3. Confirm `Qwen3-8B-Base` (NOT `Qwen3-8B-Instruct`, which is what we currently serve) is available on HuggingFace and re-quantizable to Q4_K_M. The recipe REQUIRES base models — instruction-tuned variants regress.
4. Design conversation per the "Open design questions" bullets above. The first decision (framework) constrains everything else; use `AskUserQuestion` to surface it once you've inspected tinyforge-zero's actual deps.
5. Smallest viable slice: **memory-efficacy classifier first** (470-finding corpus is above the ~100-pair threshold; judge is trivial JSON+label validation). Get one LoRA trained end-to-end, load via `llama-server --lora-adapter` on top of `Qwen3-8B-Base` Q4_K_M, re-run the eval against `project_qwen_5model_sweep_2026-05-15.md` baseline. THAT establishes the loop. Home-mgmt second.
6. Memory search for any prior training/fine-tune context: `mcp__penumbra__memory_search` with `fine-tune`, `LoRA`, `MLX`, `unsloth`, `axolotl`. (This session: 0 hits — confirmed greenfield except for the recipe memory just landed.)

**Thread 2 — Parser trace (LAN-blocked)**

1. When back on home LAN: edit `templates/workloads/qwen3-8b-mac-mini.yaml` extraArgs to add `--verbose`; apply via `llamactl --node mac-mini apply`.
2. Tail `llama-server.log`: `llamactl --node mac-mini server logs --name qwen3-8b-mac-mini --follow > /tmp/qwen-verbose.log`.
3. Run the two-tick differential per `docs/notes/parser-bug-hypothesis-2026-05-15-pm.md` step 3-4.
4. The cache patch landed this session (penumbra `8c76ed3`) means dispatch_events from the failing tick should now show real `tool_name` values — that's a free improvement to the trace's signal quality.

**Thread 3 — Pre-existing bits from prior continuation that didn't progress**

- Daemon stale-sweeper bug (orphan ticks pile up across sessions; needs `stale_force_resolve` sweeper to run mid-life, not just at boot).
- Underscore-refactor cosmetic stragglers (~50 dotted references in test names/comments).
- mac-mini launchd-respawn noise (task #4 from prior note).

## Memories worth reading first

- **`reference_tinyforge_zero_recipe.md`** — the seed technique for the new direction. Read first.
- **`project_fine_tune_direction_2026-05-15.md`** — the initiative framing + how the recipe maps to our two pilots.
- **`project_qwen_5model_sweep_2026-05-15.md`** — the memory-efficacy bench plateau that the fine-tune pilot directly targets. Has the gap numbers (recall_miss F1 67%, memory_ignored unreachable).
- **`project_home_mgmt_long_lived_flow_2026-05-14.md`** — the home-mgmt protocol and model-selection A/B. Frames what fine-tuning needs to preserve.
- **`reference_claude_agent_acp_tool_call_wire_shape.md`** + **`docs/notes/parser-bug-hypothesis-2026-05-15-pm.md`** — the corrected framing of the parser bug (the prior `project_gemma_acp_tool_call_incompat_2026-05-15.md` memory's "claude-agent-acp parser bug" hypothesis is superseded; the real divergence is upstream).
- **`reference_llamacpp_mtp_binaries.md`** — the per-model binary map; fine-tuned adapters will need to load on whichever binary the workload spec pins.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5` (on this repo)
2. `cd /Volumes/WorkSSD/repos/personal/penumbra && git log --oneline -5` (verify `8c76ed3` is the head)
3. `mcp__penumbra__handoff_list_pending` → confirm clean
4. If on home LAN: prefer Thread 1 (fine-tune design conversation) over Thread 2 (parser trace). The parser trace is patient; the user explicitly named fine-tuning as the headline new direction.
5. If off home LAN: Thread 1 only.
