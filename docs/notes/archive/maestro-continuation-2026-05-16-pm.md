# Maestro continuation — 2026-05-16 pm

> Paste this as the kickoff message in the next session.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state. Keep commits/PR descriptions neutral. Delegate substantive code via `chain_start`; hand-code only when the worker won't boot or prior dispatches have failed structurally.

## What this session shipped (continuing from am-late note)

### llamactl commits
- `9973241` train-script bundle: smoke chat-template thinking-off, kill_port grace, exp backoff on 503
- `ab46af5` 45 synthetic minority memory-efficacy findings (15 each of recall_miss/memory_ignored/missed_registration)
- `5a712e9` merge + stratified per-class mod-10 split; new 4way-chat corpus; prep_chat.py framing knob
- `8a5d612` eval-classifier FRAMING=4way + chat-format extraction fixes + heredoc structural fix
- `3dcadd4` README counts refresh + `source: canonical|synthetic` provenance flag on every gold-labels row

### penumbra commits
- `133bb12` adversarial-review workflow: prepends `cd ${ctx.cwd}` + `use_worktree:false` on per-persona/synthesizer dispatches. **Verified working** — 8/9 personas + synthesis all ran cleanly in llamactl repo during today's adversarial review.
- `4e9ff2f` chain-start route: soft-fall-back on unknown_project_id instead of HTTP 400. **Live and verified** — first fresh home-mgmt tick after daemon restart had zero chain_start_simple failures.

## Headline diagnosis: Thread H root cause + fix

home-mgmt orphan_recovered loop (running since am session) was caused by `chain_start_simple` schema's `project_id: z.string().optional()` being filled by the model with its own agent identity "home-mgmt". Penumbra's chain-start route rejected as `unknown_project_id` (HTTP 400). SDK marked tool_call failed → 11 retries → worker died.

**Fix**: penumbra@4e9ff2f converts hard-reject to soft-fall-back. **Daemon restart required** (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`) — done in this session, pid 66224. Live verification: first post-restart home-mgmt tick (chain `conv-5b69a16b`) had zero chain_start failures (only state_set failures, which are a separate transient issue from the stuck pre-restart claude-agent-acp session having a broken MCP connection — those will resolve when the in-flight tick is cancelled or finishes orphan-recovery).

### Yaml note (decorative)

`~/.config/agentchat/agentchat.yaml` home-mgmt escalation protocol: added "DO NOT pass project_id; the field is optional and your agent identity 'home-mgmt' is NOT a valid project. Let it default." This won't refresh the live agent's standing_brief (DB column doesn't reload from yaml). Future home-mgmt re-creations from yaml will inherit the hint. Server-side fix is authoritative.

## Slice 2c headline (memory-efficacy 4-way)

Qwen3-8B + LoRA on stratified 4way-chat (train=416/valid=50/test=49) makes **identical predictions** as base on all 49 test rows. Macro-F1 = 0.4918 for both, delta = 0. The synthesizer's "evaluation invalid due to majority dominance" critique is exactly right — n=1-2 minority samples per class is variance-bound, not measurable signal. Real conclusion: the toolchain works; whether LoRA earns its keep on this task is still unanswerable without a balanced hold-out.

Full SLICE_2C_REPORT.md in `packages/train/.spike-work/eval-4way-qwen3-8b-chat/` (gitignored).

## Adversarial review verdict (today's slice 2c + corpus changes)

Reviewers landed in the right repo for the first time (133bb12 verified). 8/9 personas reported, synthesizer summary at `.penumbra/reviews/2026-05-16T04-41-12.358Z/synthesis.md`.

**Headline**: "Reject as-is; fix correctness blockers first."

5 high-severity findings:
1. Metric contract bug in eval pipeline (positional schema) — architect (worth investigating eval-classifier.sh's class-metrics emission)
2. Label-invariant violations in synthetic rows — data_correctness (needs row-level inspection of 45 `syn-*` entries)
3. Evaluation invalid due to majority dominance — 4 personas (known; accepted trade-off but is the limit on Slice 2c)
4. Synthetic merged into canonical without partition flag — architect (addressed by `source` flag in 3dcadd4)
5. Deterministic mod-10 split risks family leakage — architect, data_correctness (synthetic IDs sort together → cluster in same bucket)

## Memories written today

- `project_thread_h_unknown_project_id_2026-05-16` — full Thread H root cause + fix narrative
- `reference_qwen3_jinja_tool_call_gold_standard` — Qwen3+jinja produces clean OpenAI tool_calls; gold standard for any tool-call corpus
- `project_eval_classifier_chat_format_bugs_2026-05-16` — the four bugs surfaced + fixed in eval-classifier.sh
- (also updated) `reference_adversarial_review_workflow_cwd` — now notes the 133bb12 fix

## Live state at session end

- penumbra daemon: pid 66224 (restarted today for 4e9ff2f route fix)
- penumbra worker: pid 59200
- mac-mini at 192.168.68.76: unreachable (carry-forward; off home LAN)
- llamactl HEAD: `3dcadd4`. Working tree clean except untracked `docs/notes/maestro-continuation-2026-05-16-*.md`.
- penumbra HEAD: `893621a` (a `task_draft_list_pending` cleanup landed after my fix; unrelated to today's work). `4e9ff2f` is in history.
- home-mgmt: **fully working end-to-end as of 13:30Z**. The 13:30 tick completed cleanly: dispatched codex-acp-deep diagnosis (handoff `ac6ad346`, status=completed), state_set persisted `last_intent_summary` + `working_memory.updated_at` for the first time since 2026-05-15. Required TWO fixes (chain_start unknown_project_id + proxy-wrapped MCP env injection) AND a daemon+worker double-bounce.
- Probe llama-server on :19099: killed.
- HF model caches under `packages/train/.spike-work/`:
  - `memory-efficacy-binary-qwen3-8b-instruct-chat/` (this morning's headline pilot)
  - `memory-efficacy-4way-qwen3-8b-chat/` (Slice 2c)
  - `eval-4way-qwen3-8b-chat/` (Slice 2c eval outputs + SLICE_2C_REPORT.md)

## Open threads (concrete first moves)

### Thread K — 4B grammar LoRA (next session priority)

Strategic frame from this session: the "model can't emit tool_calls" hypothesis is FALSE for Qwen3-8B + jinja. The real failures we've hit are at higher layers (schema validation, MCP connection drops, etc). But a small-model tool-call adapter is STILL valuable as defense-in-depth — when the GBNF parse fails silently (the May-15 `\d` issue), the model's habits become the only constraint.

**Corpus design**: replay 50-100 production-style prompts through Qwen3-8B+jinja, capture `response.choices[0].message.tool_calls` JSON. Save as JSONL gold-standard. Then train a 3B/4B base (Granite 4.1 3B if downloadable, Qwen3.5-4B otherwise) + LoRA with rank 16, 8-16 layers. Eval = parse-success rate via claude-agent-acp on held-out prompts.

**First move**: write a 50-line script `packages/train/corpora/tool-call-grammar/mine_qwen3.py` that takes a JSONL of `{system, user, tools}` seeds, POSTs to llama-server, captures response, emits `{messages, tool_calls}` rows. Build the seed set covering: chain_start, chain_start_simple, memory_search, memory_observe, ha:ha_pulse, ha:ha_get_state, ha:ha_call_service, long_lived_self_state_set, long_lived_self_state_get, task_create. ~5-10 prompt variations per tool.

### Thread L — Watch home-mgmt unblock

The first post-fix tick (chain `conv-5b69a16b`) was cancelled; next cron at 11:40Z. Do `mcp__penumbra__long_lived_get home-mgmt` after that fires:
- If `working_memory.updated_at` moves past `1778828307363`, the fix works end-to-end.
- If `last_intent_summary` mentions "dispatched diagnosis to codex-acp-deep via chain_start_simple handoff X", that's perfect.
- If new failures appear, check daemon log for the new "dropping and continuing" warning and any other unexpected MCP failure modes.

### Thread M — Slice 2c follow-ups from adversarial review

If returning to memory-efficacy work:
1. Audit 45 `syn-*` rows in gold-labels.json for the data_correctness "label invents absent memory behavior" findings (high-sev #2).
2. Investigate metric-emission contract bug architect flagged (high-sev #1) — exact line in eval-classifier.sh where positional class-metrics tuple gets parsed differently from how it was emitted.
3. To get a real adapter-vs-base measurement: generate another 30-50 synthetic minorities, stratify so test has ≥3 of each class, retrain, re-eval. The toolchain works; just need balanced data.

### Thread N — Open ops health items (low priority)

- 12 `gh-task-sync errored=12` lines in daemon log — some GH sync issue worth a quick look.
- `mcp_unavailable` for `task-refiner-primary`/`task-refiner-escalation` (federation-tools-listTools-failed). Probably benign daemon-startup transient.

## First moves for next session

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__long_lived_get home-mgmt` → check `working_memory.updated_at` and `last_intent_summary`. Thread L verification.
4. Pick a thread with the user. Thread K is the highest-leverage. Thread L is reactive (10 sec). Thread M is back-to-memory-efficacy if interested.
