# Maestro continuation prompt — 2026-05-16 am-late

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query the live sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate substantive code via `chain_start`; hand-code only when the worker/daemon won't boot or when prior dispatches for the same task have failed structurally.

**This session was the natural follow-on to the am note's Threads F/A/B and a productive detour through chat-template training. It also turned up a silent eval-parser bug that had been distorting every parse-rate number from earlier today.** Six commits landed. Two persistent memories were updated (the LoRA Instruct result) and two new ones written (the jq trap + the workflow-cwd bug).

## What this session shipped

### Commits (in order)

- **`5c454f9` test(train): dispatch routing verification probe** — Thread F. Single-line marker `packages/train/scripts/HELLO_FROM_DISPATCH.md`. Verified penumbra's `1f4d769` + `444edb0` routing fixes landed: a `codex-acp-fast` dispatch from a llamactl session with `use_worktree:false` + explicit `cd` now actually lands in llamactl, not penumbra. The format-patch dance from yesterday is no longer needed.

- **`6555003` fix(train): eval-classifier.sh — jq-based response parser + full-response capture** — Thread A.1. Replaced the awk char-counter `extract_first_json_object` with a python helper that's `in_string`/`escape` aware. New parser also extracts inner JSON from the `.content` field of the /completion outer response. Predictions JSONL now stores full `model_text` and `raw_response` instead of a 180-char `response_head`. Dispatched to codex-acp-fast, 32s wall.

- **`3c5285a` fix(train): eval-classifier.sh — wait for port to be bindable across server swaps** — Thread B.1. Surfaced live during Thread B base-eval: the base llama-server failed to bind port 18099 after the adapter server was killed, because TIME_WAIT held the socket. Existing `kill_port` only checked `lsof -ti` for live PIDs. Added `wait_port_bindable()` that attempts a python `socket.bind` with TIMEOUT=60s after the kill loop. Dispatched to codex-acp-fast.

- **`9acc524` chore(train): drop stale dispatch-routing probe marker** — Deleted `HELLO_FROM_DISPATCH.md` from `5c454f9` now that routing is verified.

- **`1f5b886` feat(train): chat-formatted memory-efficacy binary corpus (mlx-lm chat schema)** — Added `packages/train/corpora/memory-efficacy/prep_chat.py` and emitted `binary-chat/{train,valid,test}.jsonl` (378/46/46) in mlx-lm `chat` format (`{"messages": [{"role": "user", ...}, {"role": "assistant", ...}]}`). Dispatched to codex-acp-fast — transport closed after writing files but before commit; finished by hand.

- **`091e16a` feat(train): eval-classifier.sh — WRAP_CHAT_TEMPLATE knob for chat-format adapters** — Adds `WRAP_CHAT_TEMPLATE=${WRAP_CHAT_TEMPLATE:-0}` env knob + `wrap_chat_template()` helper that emits the exact Qwen3 chat wrapper with thinking disabled:
  ```
  <|im_start|>user
  {prompt}<|im_end|>
  <|im_start|>assistant
  <think>

  </think>

  ```
  When set, the wrap is applied at the `/completion` POST. Reported in the EVAL_REPORT.md `## Setup`. Default UNCHANGED. Dispatched to codex-acp-fast, 26s.

- **`6b8ff3a` fix(train): preserve false memory_related predictions** — The big surprise of the session. `jq -r '.memory_related // empty'` was silently dropping every `{"memory_related": false}` model output because jq's `//` treats both `null` AND `false` as falsy. **Every parse-rate number from earlier today was under-counted** — only "true" classifications were ever counted as parsed. Patch swaps all five jq sites (extract_pred outer + content-inner + fallback + extract_gold + summary counters) to `(if has("memory_related") then .memory_related else empty end)`. Dispatched to codex-acp-fast, 18s. Smoke check verified: `echo '{"memory_related":false}' | jq -r '...' ` now prints `false` instead of empty.

### The real Thread B / Thread C eval numbers (post-parser-bug-fix)

The original am-note Thread B run reported "LoRA hurts Instruct by -8.7pp." That number was distorted by the parser bug. Re-scored against the saved predictions JSONLs (regex on `model_text`) with the correct `false`-preserving extractor:

| variant                                               | parse rate    |
|-------------------------------------------------------|---------------|
| Qwen3-8B-Base                                         | 12/46 = 0.261 |
| Qwen3-8B-Base + LoRA (raw `prompt`+`completion`)      | 21/46 = 0.457 (+19.6pp) |
| Qwen3-8B-Instruct (raw, no wrap)                      | 24/46 = 0.522 |
| Qwen3-8B-Instruct + LoRA (raw, no wrap)               | 21/46 = 0.457 (-6.5pp) |
| **Qwen3-8B-Instruct (chat-fmt corpus, wrap at eval)** | **46/46 = 1.000** |
| **Qwen3-8B-Instruct + LoRA (chat-fmt corpus, wrap)**  | **46/46 = 1.000** |

Two real signals:

1. **Chat-template wrap saturates parse rate at 100%** for both base and adapter on this task. The LoRA's "teach the model to output JSON" hypothesis has no headroom left to add value — the chat template alone solves the format problem. To measure if the LoRA can add value to memory-efficacy classification on this corpus, you need a harder downstream metric than parse rate (the test set has only 1 positive row, n=1; F1=1.0 across the table is meaningless).

2. **Without chat-template wrap, raw `prompt`+`completion` LoRA on Instruct still hurts** by -6.5pp (was -8.7pp under the broken parser, similar direction but smaller magnitude). The raw-format training collides with Instruct's chat-template instincts. The same LoRA on **Base** *helps* by +19.6pp because Base has no chat-template behavior to disturb.

**Production decision reaffirmed:** keep bare Qwen3-8B-Instruct + chat template (which `/v1/chat/completions` already does in production). The fine-tune toolchain works end-to-end (training, bridge, GGUF, eval), but on THIS task with THIS corpus, LoRA can't earn its keep through format alone.

### Adversarial review — known structural failure

Attempted three ways and all failed:

1. `mcp__penumbra__workflow_run({name: "adversarial-review", cwd: "/Volumes/WorkSSD/repos/personal/llamactl", args: {base_ref: "14ca8dd"}})` — workflow fired but reviewer fan-out ran in **penumbra's worktree** (branch name `agent/<uuid>`). All 7 personas reported `14ca8dd not resolvable` → empty diff → 0 findings. The output dir routed correctly to llamactl's `.penumbra/reviews/` but the actual git ops happened in penumbra.

2. Same workflow with `args: {content_path: "/tmp/.../diff.diff"}` — reviewers ignored the content_path and ran their own `git diff main..HEAD` in penumbra's worktree, again empty. Plus `/tmp/` is outside gemini-acp-pro's allowed workspace.

3. Manual fan-out via 3 parallel `mcp__penumbra__chain_start` calls to claude-acp-sonnet / codex-acp-deep / gemini-acp-pro with explicit `cd /Volumes/WorkSSD/repos/personal/llamactl` + diff content embedded in prompts — claude-acp-sonnet and codex-acp-deep ignored the prompt entirely and ran the maestro session-init sequence ("Clean slate. What would you like to work on?"). Gemini engaged but reported `/tmp/` outside its workspace.

Self-synthesized findings instead (captured in this note and the LoRA memory). Memorized the workflow bug as `reference_adversarial_review_workflow_cwd.md`. Worth a real fix in penumbra's workflow runtime: per-persona `chain_start` calls should propagate the workflow's `cwd` arg.

### home-mgmt — resumed (Thread D)

Was `status: paused`. Verified state via `long_lived_get`:
- `pending_goals` has ONE legitimate user-staged probe — dispatch ONE chain_start_simple to codex-acp-deep with a plan-only diagnosis of "153 unavailable HA entities" (real ops issue from open thread).
- `last_pulse_id` is the stale `sha256:stale-injected-2026-05-10` marker but harmless — no real pulses have fired since May 14 so there's nothing to dedup against.
- Last real audit entry was May 14 22:24 — normal `ha:ha_pulse` + `ha:ha_get_state` execution before pause.

Decision per recommendation + user: just `long_lived_resume`. No clearing.

After resume, first 3 ticks at +10, +20, +30 min showed:
- Tick 1: `orphan_recovered` (chain dispatched as `conv-707400a2`, worker died mid-tick, recovered on boot)
- Tick 2: `orphan_recovered` (chain dispatched as `conv-03842b79`, same pattern)
- Tick 3: `concurrency_skip` (next cron fired while prior recovery was still in flight)

So home-mgmt IS firing and dispatching, but each tick is orphan-recovering rather than completing cleanly. Working memory hasn't updated (still has old `updated_at: 1778828307363`). The pending_goal will keep retrying every 10 min until one tick completes the dispatch + `long_lived_self_state_set` cleanly. **Watch this in the next session** — if it's still orphan-recovering after a few more cycles, there may be an underlying worker stability issue worth investigating.

## Three more latent bugs surfaced (not fixed)

1. **`train-lora.sh` smoke step fails on Qwen3 thinking mode.** Smoke POSTs to `/v1/chat/completions` and Qwen3 enters thinking mode by default → `content:""` while all tokens go into `reasoning_content`. Smoke step reports FAIL even when training succeeded (confirmed live on both Instruct training runs today). The adapter GGUF is intact regardless; eval works fine. Fix would be: pass `enable_thinking: false` in the chat-completions payload, or switch smoke to use `/completion` with a wrapped prompt, or add `--reasoning off` to the smoke-server invocation.

2. **`kill_port` uses `kill -9`** which skips llama-server cleanup. Metal residency sets might leak across many eval cycles. SIGTERM-first with a short grace would be cleaner.

3. **Eval 503-retry loop is 60×0.5s = 30s of wall per affected row.** With intermittent 503s during high-load runs that can add minutes. Smarter would be exponential backoff or fewer retries.

## Live state at session end

- penumbra daemon + worker: up (last `launchctl list | grep penumbra` showed both).
- mac-mini at 192.168.68.76: unreachable (carried from prior; still off home LAN).
- M4 Pro `llama-server`: nothing left running on :18099 (eval driver killed cleanly).
- Production llamactl-managed `llama-server` on :8181 (Gemma 4 26B-A4B-MTP): untouched.
- llamactl HEAD: `6b8ff3a` (parser false-coalesce fix). Working tree clean except untracked `docs/notes/*.md`.
- home-mgmt: `status: active`. Trying to dispatch the staged codex-acp-deep diagnosis every 10 min; first 2 attempts orphan-recovered, 3rd concurrency-skipped. Real outcome pending.
- HF model caches under `packages/train/.spike-work/`:
  - `memory-efficacy-binary-qwen3-8b/`: Qwen3-8B-Base + binary-format LoRA (yesterday's pilot)
  - `memory-efficacy-binary-qwen3-8b-instruct/`: Qwen3-8B-Instruct + binary-format LoRA (today's Thread B pilot)
  - `memory-efficacy-binary-qwen3-8b-instruct-chat/`: **Qwen3-8B-Instruct + chat-format LoRA (today's headline pilot)**
  - `eval-binary-qwen3-8b-instruct-v2/`: Instruct vs Instruct+LoRA raw eval (post port-fix)
  - `eval-binary-qwen3-8b-instruct-chat/`: Instruct vs Instruct+LoRA chat-wrap eval (100% / 100%)
- Adapter weight files: each `gguf/adapter.gguf` ~39MB; base models ~16GB.

## Memories updated/written this session

- `project_lora_instruct_no_win_2026-05-16.md` — UPDATED with corrected post-parser-fix numbers. The headline shifted from "-8.7pp regression" to "saturated at 100% with chat wrap; -6.5pp regression without wrap."
- `reference_jq_false_coalesce_trap.md` — NEW. `jq // empty` drops `false`. Use `(if has("key") then .key else empty end)`. Saved with example + symptoms + recovery.
- `reference_adversarial_review_workflow_cwd.md` — NEW (earlier in session). Penumbra's adversarial-review workflow ignores `cwd` arg; reviewer fan-out lands in penumbra worktree. Workaround: manual `chain_start` fan-out with explicit `cd` per prompt.

## Memories worth reading first

- `project_lora_instruct_no_win_2026-05-16.md` — the corrected production answer
- `reference_jq_false_coalesce_trap.md` — read before touching any jq parser logic in eval-classifier.sh or similar
- `reference_adversarial_review_workflow_cwd.md` — read before using `mcp__penumbra__workflow_run({name: "adversarial-review"})` from a non-penumbra session
- `reference_penumbra_dispatch_routing.md` — original chain_start cwd bug; today's 5c454f9 probe confirmed the user's fix landed correctly
- `project_fine_tune_toolchain_landed_2026-05-16.md` — original toolchain ship note (yesterday); still accurate but supersede the lift number with the new memory

## Open follow-ups (concrete first moves per thread)

**Thread G — Hard downstream metric for LoRA value**

Format-adherence is saturated at 100% with chat-template wrap. To learn whether LoRA adds value on this task, build a balanced corpus. Either:

1. **Expand the test set with synthetic positives.** Generate ~50 new memory-related findings using codex-acp-spark or a multi-labeler ensemble. Re-split, re-train, re-eval. Measure F1 on positive class.
2. **Switch to the 4-way framing.** The 4-way corpus (`packages/train/corpora/memory-efficacy/4way/`) discriminates `missed_registration / recall_miss / memory_ignored / not_memory_related`. Even with `valid`+`test` at 100% majority-class, training on the 4-way framing exercises the classifier head more. Re-eval would need its own gold-extraction logic but the eval driver already handles `classification` field via `extract_gold`.

**Thread H — Watch home-mgmt unblock**

- Re-check `long_lived_get` after a few more tick cycles. If working_memory hasn't updated (last `updated_at` still `1778828307363`), home-mgmt has NOT completed any tick cleanly since the resume.
- Inspect what's making ticks orphan-recover. The 5-min `bounds_wall_clock_ms: 360000` should be plenty for a single chain_start_simple. Either the chain itself is hanging or worker boot is racing the tick.
- If a tick DOES complete, check `chain_history` for the new dispatched handoff_id. The chain target was codex-acp-deep with a plan-only diagnosis request.

**Thread I — Fix the latent eval bugs**

Three small bundleable fixes (all in `packages/train/scripts/`):
1. `train-lora.sh` smoke: use `/completion` + chat-template wrap, or pass `enable_thinking:false` to chat-completions, so Qwen3 family doesn't fail smoke.
2. `eval-classifier.sh` `kill_port`: SIGTERM first, then SIGKILL after grace.
3. `eval-classifier.sh` 503-retry: exponential backoff (1s, 2s, 4s, max 30s total) instead of 60×0.5s.

Dispatch as one task to codex-acp-fast — should be <2min wall.

**Thread J — Penumbra workflow fix**

The adversarial-review workflow's reviewer fan-out doesn't honor `cwd`. This belongs in penumbra repo, not llamactl. Frame it as: "per-persona `chain_start` calls in `packages/penumbra-runtime/src/workflows/adversarial-review.ts` (or wherever) should propagate the workflow's `cwd` arg, currently they default to penumbra's own repo path." Verify the file path before dispatching.

**Thread K — Adversarial review of the train-package, properly**

Now that the workflow bug is known, retry via the manual chain_start approach — but with a different shape:
- Put the diff INSIDE the repo (e.g., `docs/notes/train-review-input.diff`) so it's in the reviewer's workspace.
- Use 2-3 reviewers max, all `codex-acp-fast`-tier (faster than the deep tier).
- Give each one a tighter, more specific brief than today's. Examples that DID work in past sessions: name a specific function and ask "what's the worst failure mode of this code?"

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__long_lived_get home-mgmt` → check `working_memory.updated_at`. If it changed from `1778828307363`, home-mgmt completed a tick. Look at `last_intent_summary` and any new chain_id in recent_ticks. If it didn't change, see Thread H.
4. Pick a thread above with the user. Thread H is reactive (just check). Thread I is a 5-minute cleanup bundle. Thread G is the next real experiment. Thread J unblocks proper adversarial reviews. Thread K is a fallback if the user wants today's train-package code reviewed regardless.
