# Maestro continuation — 2026-05-16 pm-late

> Paste this as the kickoff message in the next session.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state. Keep commits/PR descriptions neutral. Delegate substantive code via `chain_start`; hand-code only when the worker won't boot, when a dispatch has structurally failed twice, or when the fix is a single small inline edit.

## What this session shipped (continues from 2026-05-16-pm note)

### Headline: home-mgmt FULLY working end-to-end for the first time since May-15

Took two cross-repo fixes + daemon+worker double-bounce. The 2026-05-16 13:30Z tick was the first since May-15 to:
- Dispatch its `chain_start_simple` diagnostic chain successfully (handoff `ac6ad346`, returned status=completed)
- Persist `last_intent_summary` AND `working_memory.updated_at` via `long_lived_self_state_set`

Confirmed live via dispatch_events + long_lived_get.

### llamactl commits (today, 7 total in chronological order)

- `9973241` train-script bundle: smoke chat-template thinking-off, kill_port grace, exp backoff on 503
- `ab46af5` 45 synthetic minority memory-efficacy findings
- `5a712e9` merge + stratified per-class split + new 4way-chat corpus + prep_chat.py framing knob
- `8a5d612` eval-classifier FRAMING=4way + chat-format extraction fixes + heredoc structural fix
- `3dcadd4` README counts refresh + `source` provenance flag on every gold-labels row
- `b64106d` tool-call grammar corpus v0 (30 rows mined from Qwen3+jinja) + eval-classifier per-class metric field-swap fix

### penumbra commits (today, 3 total)

- `133bb12` adversarial-review workflow prepends `cd ${ctx.cwd}` + `use_worktree:false` on per-persona + synthesizer dispatches. Verified live: full adversarial review of today's slice landed reviewers in the right repo.
- `4e9ff2f` chain-start route: soft-fall-back on unknown_project_id instead of HTTP 400. **Thread H part 1.**
- `0c6452b` isPenumbraMcp detects proxy-wrapped invocations via env[].MCP_PROXY_UPSTREAM. **Thread H part 2.**

## Thread H — the full diagnosis arc

The 6-tick orphan_recovered loop home-mgmt was stuck in had TWO compounding bugs:

**Bug A** ([[project_thread_h_unknown_project_id_2026-05-16]]): `chain_start_simple` schema has optional `project_id` with no enum constraint. The model fills it with its own agent identity "home-mgmt". Penumbra rejected with HTTP 400. Fixed by soft-fall-back (drop bad value, log warning, continue). Daemon restart picked it up.

**Bug B** ([[project_proxy_wrapped_mcp_env_injection_2026-05-16]]): the chokepoint that injects `PENUMBRA_LONG_LIVED_AGENT_ID` / `_TICK_ID` into MCP server env entries used a regex (`isPenumbraMcp`) that only matched direct `penumbra-mcp.ts` invocations. home-mgmt wraps penumbra-mcp via `mcp-allowlist-proxy.ts`, so the regex missed it → env vars never injected → spawned penumbra-mcp's `verifyRunningIdentity` threw `no_running_long_lived_tick` → state_get and state_set returned `output:null` for every call. Fixed by also checking `env[].MCP_PROXY_UPSTREAM`. Required BOTH daemon AND worker restart (the worker caches dispatch code).

**Hidden subtlety**: Bug B was masked because the chain wrapper reported `outcome=success` (the model gracefully exited after failures). For 4 ticks between 11:50 and 13:20 the wrapper looked clean but state was never written. Without inspecting dispatch_events for `agent.tool_call.failed`, you'd think home-mgmt was working.

**General lesson**: any future change in `packages/agentchat/src/adapters/` requires:
1. `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`
2. `launchctl kickstart -k -p gui/$(id -u)/dev.penumbra.worker`

## Tool-call grammar corpus v0 (Thread K, partially shipped)

Mined 30 gold-standard prompts through Qwen3-8B + `--jinja` to capture textbook OpenAI tool_calls:
- 26 positive (correct tool emission across memory_search, ha_pulse/get_state/call_service, chain_start[_simple], long_lived_self_*, memory_observe/recall, task_create)
- 4 negative (model correctly replies in text when no tool needed)

Files:
- `packages/train/corpora/tool-call-grammar/seeds.json` — 30 seed prompts
- `packages/train/corpora/tool-call-grammar/mine_qwen3.py` — replayer
- `packages/train/corpora/tool-call-grammar/gold-corpus.jsonl` — captured tool_calls

Reproducible: spin Qwen3-8B with `--jinja` on :19099, run `python3 mine_qwen3.py --seeds seeds.json --port 19099 --out <new-corpus>.jsonl`.

Key finding from this work: [[reference_qwen3_jinja_tool_call_gold_standard]] — Qwen3-8B + jinja already produces what claude-agent-acp expects. The premise behind tool-call fine-tuning shifted: it's defense-in-depth for when grammar parsing soft-fails, not a primary fix for what's broken in production.

## Adversarial review of today's corpus changes — verdict landed

Synthesis at `.penumbra/reviews/2026-05-16T04-41-12.358Z/synthesis.md` (8 personas + synthesizer; security timed out, performance silent).

Headline: "Reject as-is; fix correctness blockers first." Five high-sev findings:
1. ✅ **Eval pipeline metric contract** (architect) — Fixed in `b64106d`. The per-class table emit was `class|tp|fp|fn|prec|rec|f1` but the report-writer was reading fields 4/5/6 (fn/prec/rec). Slice 2c "precision" column actually showed FN counts.
2. **Label-invariant violations** (data_correctness) — Spot-checked 15 syn-mr-* (all defensible). 15 syn-mi-* have ~4 borderline cases where "memory dropped before model receives it" is arguably recall_miss not memory_ignored. Not session-blocking; documented.
3. **Evaluation invalid due to majority dominance** — known trade-off, accepted for v0.
4. **Synthetic merged into canonical without partition flag** — Addressed in `3dcadd4` (added `source: canonical|synthetic` field).
5. **Deterministic mod-10 split risks family leakage** — synthetic IDs sort together, all minority class instances cluster in the same bucket per per-class mod-10. Worth a future fix; not session-blocking.

## Slice 2c headline (memory-efficacy 4-way)

Qwen3-8B + LoRA on stratified 4way-chat: **identical predictions** vs base on all 49 test rows. Macro-F1 = 0.4918 for both, delta = 0. The test split has only 1-2 minority samples per class; n is too small to measure adapter value. Toolchain works; whether LoRA earns its keep is still unanswerable.

Full report: `packages/train/.spike-work/eval-4way-qwen3-8b-chat/SLICE_2C_REPORT.md` (gitignored).

## Memories written today (8 total, all 2026-05-16-dated)

- `project_thread_h_unknown_project_id_2026-05-16` — Bug A diagnosis + fix
- `project_proxy_wrapped_mcp_env_injection_2026-05-16` — Bug B diagnosis + fix
- `reference_qwen3_jinja_tool_call_gold_standard` — Qwen3+jinja produces clean OpenAI tool_calls; use as labeler
- `project_eval_classifier_chat_format_bugs_2026-05-16` — three latent eval-classifier bugs surfaced + fixed
- `project_eval_classifier_metric_field_swap_2026-05-16` — architect's high-sev #1 confirmed + fixed
- (updated) `reference_adversarial_review_workflow_cwd` — adds the 133bb12 fix note

MEMORY.md index updated for all of these.

## Live state at session end

- **penumbra daemon**: pid 38905 (restarted twice today: once for `4e9ff2f`, then again coincidentally before `0c6452b`)
- **penumbra worker**: pid 41726 (restarted once today for `0c6452b`)
- mac-mini at 192.168.68.76: unreachable (carry-forward; off home LAN)
- **llamactl HEAD**: `b64106d`. Working tree has untracked `docs/notes/maestro-continuation-2026-05-16-*.md` files (today's session notes; can be committed when convenient).
- **penumbra HEAD**: `0c6452b`. Working tree may have unrelated work from other agents — leave it alone unless explicitly asked.
- **home-mgmt**: `status: active`. **Fully operational.** Latest tick at 13:30Z dispatched diagnostic chain to codex-acp-deep (handoff `ac6ad346`) which completed cleanly. Future ticks will follow the standing brief's per-tick protocol on subsequent firings (short-circuit when no anomaly, or dispatch if there's one).
- Probe llama-server on :19099: killed.
- HF model caches under `packages/train/.spike-work/` (gitignored).

## Open threads (concrete first moves)

### Thread K — Train smaller-than-8B LoRA on the new corpus

The strategic reframing from this session: tool-call fine-tuning is defense-in-depth, not a primary fix. But the corpus exists and the pipeline works, so worth pushing through.

**First move**: train Qwen3.5-4B + LoRA on `packages/train/corpora/tool-call-grammar/gold-corpus.jsonl`. Use the existing train-lora.sh pipeline. May need format conversion: the corpus is `{messages, tools, tool_choice, expected_tool_calls, expected_content}` — mlx-lm wants a chat-format input. The cleanest path is either (a) render the rows via Qwen's chat template to text and use raw-prompt training, or (b) coerce into `{messages: [user, assistant-with-tool_calls]}` and trust mlx-lm's chat-template-aware loss. Pick one and try.

Hyperparams to copy from today's headline pilot: ITERS=300, BATCH_SIZE=1, NUM_LAYERS=16, LORA_RANK=16. Eval = held-out subset of seeds (or new prompts) → measure parse-success rate via claude-agent-acp.

### Thread L — Watch home-mgmt stay healthy

Verify the next 2-3 ticks after this session ends. If anything regresses, the `dispatch_events` trail is the diagnostic surface (tool_call.failed events + daemon log warnings).

### Thread M — Slice 2c follow-ups still open

If returning to memory-efficacy work:
1. Audit borderline `syn-mi-*` rows (4 of 15 may be miscategorized as memory_ignored vs recall_miss).
2. Family-leakage fix: hash findingId before mod-bucketing (architect's high-sev #5) so synthetic IDs don't cluster.
3. Expand minority pool to 30-50 per class then re-stratify so test split has ≥3 of each minority class — only then can macro-F1 actually move.

### Thread N — Open ops items (low priority)

- gh-task-sync errored=15 in daemon log — some GH sync issue.
- task-refiner-primary/escalation `federation-tools-listTools-failed` (mcp_unavailable) — probably benign post-restart transient but worth a sanity check if it persists.

## First moves for next session

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__long_lived_get home-mgmt` → confirm `working_memory.updated_at` is recent (within ~10 min of now) and `last_intent_summary` shows the latest tick's behavior. If `updated_at` is still `2026-05-16 13:35:45` or earlier and now is >30 min later, home-mgmt regressed.
4. Pick a thread with the user. Thread K is most strategic. Thread L is reactive (10 sec).
