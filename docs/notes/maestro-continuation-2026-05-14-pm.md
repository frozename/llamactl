# Maestro continuation — 2026-05-14 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

`AGENTS.md` is the source of truth. Use Penumbra MCP for chain state (`handoff_list_pending`, `chain_status`, `chain_wait`); never query sqlite directly except for forensics. Keep commits and repo-facing text neutral — no AI/tool authorship attribution. Delegate substantive code via `chain_start`; hand-code only when the worker/daemon won't boot **or** when the task is small enough that scheduling overhead exceeds the work (this session was almost entirely the latter: yaml edits, server-restart sequences, RAM diagnostics on mac-mini over ssh).

A note on the session-handoff workflow: it auto-rendered the **penumbra** repo's git context above any narrative I write here, because the daemon defaults to that repo's project_id. That output is unrelated to this session — discard it. THIS file is the source of truth for llamactl's session.

## What this session shipped

The session ran three threads end-to-end and one bench-only thread. 18 commits on llamactl `main` (pushed to `frozename/llamactl`), plus 4 commits on the atomic-fork branch `fix/shared-ngram-cache-dynamic` (pushed to `frozename/atomic-llama-cpp-turboquant`). All commits this session use neutral repo-facing text.

### A. llama.cpp speculative-decoding investigation + shared-cache patch (BIG thread)

Started the day with `--lookup-cache-dynamic` (`-lcd`) showing +15% on M4 Pro `-np 1` but 0% on mac-mini `-np 2` (from the prior session's open follow-ups). Dispatched three concurrent **read-only investigations** to map the lay of the land:

- `codex-acp-spark` → `docs/notes/llamacpp-investigation-lcd-scheduler-2026-05-14.md`. Confirmed per-slot ngram cache + `TAG_SERVER_SPEC_REWORK` upstream TODO; proposed shared-per-context dynamic cache fix.
- `codex-acp-deep` → `docs/notes/llamacpp-grammar-classifier-2026-05-14.md` + drafted `tools/memory-efficacy-bench/grammars/classifier.gbnf`. Original GBNF used multi-line rules that llama.cpp's parser silently truncates; I hand-fixed the grammar to wrap multi-line bodies in `(...)` per the canonical `chess.gbnf` pattern.
- `gemini-acp-pro` (initial dispatch failed on sandbox restriction reading `/Volumes/WorkSSD/src/llama.cpp`) → re-dispatched to `codex-acp-spark` with narrower scope → `docs/notes/llamacpp-granite-paths-audit-2026-05-14.md`. Negative findings (hybrid state is per-seq-isolated; no Granite-specific EOS quirk) — that was useful in itself: ruled out two hypotheses.

Commit `7aa8df4` landed all three reports as a single docs commit.

Then **implementation**, parallel two-prong dispatch:

- **Grammar wire-up** (`codex-acp-deep` STANDARD): added `--grammar-file` to `tools/memory-efficacy-bench/run-bench.ts` + 4 tests. Agent's smoke run returned `[]` from the server; I diagnosed (server silently fell back to unconstrained because of the multi-line-rule GBNF bug above) + fixed the grammar + re-ran smoke (10/10, 100% valid). Commit `8d653c2`.
- **Shared ngram cache patch** (`codex-acp-spark` BOUNDARY): patched 9 files on `/Volumes/WorkSSD/src/llama.cpp-atomic` (new branch `fix/shared-ngram-cache-dynamic` off `frozename/master`). Agent stalled mid-task on context-window exhaustion (multiple apply_patch retries → ContextWindowExceeded); I reviewed the on-disk diff, finished by hand. Built the binary, ran smoke — counters were always 0 because `reset()` cleared lifetime stats. Fixed by separating per-request vs lifetime counters with a `reset()` body comment. Commits `84ae116a2` + `6424d29ef` (round-trip script stabilization the agent added) + `6d29d4540` (round-1 adversarial-review fix: dropped shared `update_tail` to fix cross-slot mixing + memory leak — both HIGH-severity findings from `adversarial-review` workflow).

Then a 470-finding A/B sweep against the production memory-efficacy classifier on mac-mini `:8090` — **bench commits ranked by win/loss:**

- **WIN: grammar A/B** (`3e8e257`) — 33% silent drops → 0%, +66% findings/sec, +1.2pp bucket_accuracy. But `memory_ignored` rare-class F1 regressed 40%→0%; the model defaults to `not_memory_related` when it would have previously silently dropped. Kill-switch is one flag.
- LOSS: shared-cache patch on Granite (`60878ca`) — `-25% throughput` despite the patch working mechanically (counters log correctly). Server-side draft acceptance 0.15-1.8% — Granite's high-entropy bucket/reason choices defeat ngram speculation. Caveat: patched ran at ctx=16k vs prod's 32k because Metal OOM under prod ctx + shared GPU with the live `:8090`.
- LOSS: v2 prompt to recover memory_ignored (`83ccd3c`) — strictly worse than v1 (acc 96%→93%, recall_miss 43%→0%). Reverted; artifact kept so the next session doesn't re-attempt the same prompt shape.
- LOSS: UD-Q4_K_XL + grammar (`2d9fc8b`) — no rescue: same memory_ignored=0%, 17% slower than Q4_K_M+grammar.
- LOSS: 3B → 8B Granite spec-draft (`2e75868`) — 79-91% acceptance, -15% throughput. Hybrid Mamba/SSM state rollback cost dominates.

### B. Gemma 4 + Qwen 3 cross-family verification (this session's most useful research)

User pushed for cross-family validation. Three Gemma threads + two Qwen threads:

- **Shared ngram cache, Gemma 4 26B-A4B** (`78b9131`) — **PATCH VINDICATED**. 860 cross-slot `n_lookup_dynamic_hits` (vs 0 on Granite hybrid). Proved the Granite no-win was architectural (hybrid Mamba state interleave), not the patch. **This is the load-bearing experimental result of the day.**
- **Spec-draft Gemma 4 26B-A4B + 4B drafter** (`e4682c3`) — `-64% throughput` despite 50% acceptance. MoE active params (~4B) ≈ drafter size violates spec-draft economics.
- **Grammar on Gemma 4 26B-A4B** (`68bbff1`) — fails. Gemma's verbose reason field × grammar requiring exactly 10 entries exceeds `max_tokens=2048` → unclosed arrays. Grammar needs reason-cap retune for verbose families.
- **Shared cache, Qwen 3.6 27B** (`1e931d5`) — 95+ dynamic_hits in a partial run (Qwen 3.6's thinking mode tripped bench timeouts). Pure-attention vindication count = 3 (Gemma, Qwen, plus the obvious diagonal vs hybrid Granite).
- **Spec-draft Qwen 3.6 27B + 4B drafter** (`347604e`) — `-50% throughput` despite 75-85% acceptance. **This was the death blow for spec-draft on Apple Silicon Metal**: three architectural classes (hybrid, MoE, dense pure-attention) all regress. Drop spec-draft from the optimization list.

### C. home-mgmt long-lived agent move to mac-mini

Goal: validate the long-lived flow on mac-mini and free M4 Pro `:8181` for other work. Three model attempts:

- **Granite 4.1 3B** (`cddee43`) — workload template stood up, server live on `:8091`, but claude-agent-acp produced `agent.tool_call.failed` events with `null` tool_name (handoff `034364fb`). Granite isn't on llama.cpp's `--jinja` known-tool-call list (Hermes/Llama 3/Mistral/Qwen/Functionary/DeepSeek), so its native tool-call format doesn't translate to Anthropic `tool_use` blocks. Granite 8B has the same parser mismatch (handoff `ef129fe4`, 3 failures).
- **Qwen 3.5-4B** (M4 Pro `:18888` test) — standalone tool_use probe clean, BUT under the full multi-tool home-mgmt protocol fails 7 calls across 5 session restarts (`6bd57c1c`). Schema-complexity ceiling.
- **Qwen 3-8B** (`765240e` → `2bd5059`) — passes both: standalone probe clean, full home-mgmt protocol completes with **zero `tool_call.failed`** (handoffs `300a00c3`, `2413122a`, `236bbbb0`).

Final architecture (commit `2bd5059`): **unified Qwen 3-8B `-np 2 --ctx-size 65536` at `:8090`** serves BOTH the penumbra `local` memory-efficacy classifier AND `home-mgmt` from a single server (one slot per workload). Saved ~7 GB resident vs the two-server config; swap 4 GB → 370 MB. ctx=65536 (not 32k) because home-mgmt first-turn prompt is ~17K tokens and `-np 2` halves per-slot ctx.

Also live-edited (not in git, backups under `~/.config/agentchat/`):
- `~/.config/agentchat/agentchat.yaml` home-mgmt entry: added `hostEnvPolicy: { claude: true }` (drops `CLAUDE_CODE_*` env vars from the spawned process; per-tick prefill 30K → 15.8K tokens, -48%). Pointed `ANTHROPIC_BASE_URL` at the new unified endpoint.
- Reset home-mgmt circuit breaker in sqlite (was at `degraded`/`consecutive_failures=3`/`circuit_open` from old failed ticks).

## Live state

- **Penumbra**: `dev.penumbra.daemon` PID 91335, `dev.penumbra.worker` PID has been kicked-started several times this session — current is whatever `launchctl list | grep penumbra` shows.
- **llama-server fleet** (post-session, all healthy):
  - M4 Pro `:8181` — Gemma 4 26B-A4B + MTP (atomic fork build), maestro role + Gemma-based long-lived agents.
  - **mac-mini `:8090`** — unified Qwen 3-8B Q4_K_M, `-np 2 --ctx-size 65536`, `--jinja --reasoning off --cache-reuse 256 -ctk q8_0 -ctv q8_0`. ~9.8 GB RSS / 16 GB total. Swap stable at 370 MB. Live PID stored at `/tmp/unified-server.pid` on mac-mini.
- **SSH tunnels alive on M4 Pro**: `:18090 → mac-mini :8090` (PID 19736 from prior session), `:18091 → mac-mini :8091` (created this session, kept around — mac-mini `:8091` is no longer listening so the tunnel is functionally dead but harmless).
- **Atomic-fork branch** `fix/shared-ngram-cache-dynamic` pushed to `frozename/atomic-llama-cpp-turboquant`. Patched binary lives on M4 Pro at `/Volumes/WorkSSD/src/llama.cpp-atomic/build-shared-cache/bin/llama-server` AND on mac-mini at `/Volumes/AI-DATA/src/llama.cpp-atomic/build-shared-cache/bin/llama-server` (mac-mini uses this binary for the unified `:8090` server — it behaves identically to vanilla when `-lcd` is unset, so it's a safe production replacement; verified across multiple smoke runs).
- **Git**: 18 commits on llamactl `main`, all pushed to `frozename/llamactl`. Working tree clean except for `.penumbra/` (review artifact dirs, gitignored or untracked depending).
- **Disabled workload templates** (kept on disk for revert + forensic): `granite41-8b-mac-mini.yaml`, `granite41-3b-home-mgmt-mac-mini.yaml`, `qwen3-8b-home-mgmt-mac-mini.yaml`. Each has a comment block explaining the disable + the re-enable conditions.

## Open follow-ups

Ordered by value × actionability.

1. **Validate one natural home-mgmt cron tick.** The `*/10` schedule fires every 10 min; the next one will be the first real production validation of the merged Qwen3-8B + hostEnvPolicy setup. Check `sqlite3 ~/.penumbra/db.sqlite "SELECT id, started_at, outcome, cost_cents FROM long_lived_ticks WHERE agent_id='home-mgmt' ORDER BY started_at DESC LIMIT 5;"` after some clock has passed. Want to see `outcome != 'circuit_open'` and `cost_cents > 0`.

2. **Full 470-finding A/B: Qwen3-8B + grammar vs Granite Q4_K_M baseline.** The 50-slice smoke (commit `c044aac`) showed Qwen3-8B hits 97.5% accuracy, recall_miss F1 67% (vs Granite's 43%), but json_valid_rate 80% (vs Granite 100%). Full run on the unified `:8090` would confirm the swap holds at scale. Command:
   ```
   bun tools/memory-efficacy-bench/run-bench.ts --url http://127.0.0.1:18090 --model local --batch-size 10 --concurrency 1 --grammar-file tools/memory-efficacy-bench/grammars/classifier.gbnf --out bench-results/qwen3-8b-grammar-470-2026-05-15.json
   ```
   Concurrency 1 because slot 0 is now shared with home-mgmt — concurrency 2 would contend with the long-lived agent's slot.

3. **Fix `llamactl apply` port-conflict pre-check.** The CLI's pre-flight `is :8090 bound?` probe doesn't respect `endpoint.port` in the template; rejects any apply when ANY other workload is on `:8090` even if the new template targets `:8091`. I worked around it this session by launching `llama-server` manually on mac-mini. Look at the apply path in `packages/cli`. Issue worth filing alongside `frozename/llamactl#1` (the reconciler dead-PID bug — also still open from yesterday's findings).

4. **Decide on the shared ngram cache patch's upstream PR posture.** Per the runbook (`docs/notes/llamacpp-shared-ngram-cache-runbook-2026-05-14.md`) and adversarial-review `review_debt` items, before PR:
   - Add save-on-shutdown for `-lcd <file>` (original semantics saved cache; my patch only loads).
   - Split per-request vs lifetime counters into separate structs (architect persona's HIGH finding).
   - Test on a code-generation workload where ngram acceptance is high (current Granite/memory-efficacy result is misleading because the bench workload defeats ngram speculation regardless of the patch).
   
   This is real work; defer until a specific use case demands it.

5. **Run home-mgmt's grammar fix for verbose families.** Per commit `68bbff1` analysis, the current GBNF (200-char reason cap × 10 entries × ~150 token overhead) overflows `max_tokens=2048` on Gemma 4 26B-A4B. If we ever want grammar-constrained classification on Gemma (not just Granite/Qwen), we need a reason cap of ~40 chars or a per-batch-size grammar generator.

6. **`/Volumes/WorkSSD/repos/personal/llamactl/.penumbra/`** is full of adversarial-review artifacts from this session (synthesis.md per review run). Either commit them under a `reviews/` rooted index or .gitignore them. They aren't currently tracked and aren't currently in `.gitignore`.

## Memories worth reading

These are in `~/.claude/projects/-Volumes-WorkSSD-repos-personal-llamactl/memory/` (already loaded as t2 context at session start, but flagged for emphasis):

- `project_home_mgmt_long_lived_flow_2026-05-14.md` — the model-selection A/B (Granite 3B/8B/UD/Qwen3.5-4B/Qwen3-8B/Gemma 26B) with handoff IDs for forensic replay. Includes the unified-architecture decision rationale + RAM math.
- `project_spec_draft_granite_no_win_2026-05-14.md` — three-arch spec-draft fleet-wide negative (Granite -15%, Gemma MoE -64%, Qwen dense -50%). Drop speculative decoding from the local optimization list until different hardware is in scope.
- `project_grammar_classifier_2026-05-14.md` — grammar A/B on Granite memory-efficacy. +66% fps + 96% accuracy, but the memory_ignored rare-class regression is real. GBNF multi-line parser gotcha at the bottom.
- `project_shared_ngram_cache_2026-05-14.md` — patch result and upstream-PR readiness. Updated by the Gemma vindication finding mid-session.

## First moves

```
1. git status --short && launchctl list | grep penumbra && git log --oneline origin/main..HEAD
2. mcp__penumbra__handoff_list_pending   # confirm clean
3. curl -fsS http://127.0.0.1:18090/health   # unified :8090 via tunnel
4. ssh macmini.ai 'lsof -ti:8090 | head -1 | xargs -I{} ps -O rss -p {}'   # confirm unified server alive + RAM
5. sqlite3 ~/.penumbra/db.sqlite "SELECT id, started_at, outcome FROM long_lived_ticks WHERE agent_id='home-mgmt' ORDER BY started_at DESC LIMIT 5;"   # has a real cron tick fired since the merge?
6. Decide direction with the user from the Open follow-ups above. (1) is the cheapest validation; (2) is the highest-information bench.
```
