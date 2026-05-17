# Fleet eval scoping — what each non-memory-efficacy workload needs

**Date:** 2026-05-16 night
**Predecessor:** [`attention-thesis-cross-family-eval-2026-05-16-night.md`](./attention-thesis-cross-family-eval-2026-05-16-night.md) — the framework. Memory-efficacy got 8B → 3B with +3 pp F1.

## Workload inventory

Live LLM-driven decisions in the daemon + agent fleet, ordered by call volume:

| Workload | Current model | Task class | Why it matters |
|---|---|---|---|
| memory-efficacy classifier | **granite41-3b-Q8** (swapped today, was Qwen3-8B Q4) | classification | done |
| home-mgmt long-lived (HA pulse classify path) | Qwen3-8B mac-mini `:8090` `-np 2` | retrieval-and-assembly classification + structured state-set + occasional chain_start | every 10 min; highest sustained volume |
| home-mgmt long-lived (HA actions / tool-call path) | same | tool-call / function-call | K-track territory (frozen); model agnostic per memory `project_gemma_acp_tool_call_incompat_2026-05-15` |
| task-refiner long-lived | role-resolved via agentchat.yaml | generation (prose rewrite of draft tasks/escalations) | known prefill regression history (`project_home_mgmt_prefill_shrink_2026-05-15`) |
| dispatch-refine (penumbra serve.ts:367) | `resolveJudgeConfig` → now Granite-3B Q8 on `:8085` | generation (refine an incoming chain_start prompt) | runs on every dispatch |
| t2-promotion judge pool | `granite-mini-8b` + `local-granite-8b` — **100% unhealthy** since 2026-05-06 (13,355 errors in daemon log) | classification + brief rationale | judges whether a t2 rollup promotes; currently no rollups promote |
| memory recall scoring (recall-injection re-rank) | unknown — need to inspect | re-rank (rank N t2 candidates against an incoming dispatch) | runs on every dispatch start |

## The corpus problem

**Memory-efficacy worked because we had labels.** The 470-row gold corpus
came from `codex-acp-spark` generating synthetic findings, not from
production traffic. The `dispatch_events` + `long_lived_ticks` tables on
disk do not persist message-level model output — successful ticks have
NULL `intent_summary` and NULL `working_memory_diff_json`. The DB has
metadata (handoff, outcome, cost) but not the LLM input/output.

That means **none of these workloads can be evaluated today** without
either:

**Path A — Instrument now, eval in a week.** Pattern: the `memory_verify`
auto-fire spec we landed at `penumbra@eca9e319`. Write a new
`tick_event_writer` (or extend the existing one) so each successful
home-mgmt tick captures `(pulse_payload, intent_summary, working_memory_diff,
chain_start_request_or_null)`. Wait ~7 days. ~1000 ticks accumulate.
Mine. Then eval.

**Path B — Synthesize now, eval today.** Pattern: the memory-efficacy
gold corpus path. Take the agent's `standing_brief` + a few hand-curated
example pulses, prompt a strong model (Qwen3-8B + jinja, or Gemini Pro)
to generate (input, gold_output) pairs at scale. Faster but labeler-biased
per [[project-memory-efficacy-corpus-llm-labeled]].

**Path C — Both.** Synthesize a v0 corpus, instrument concurrently, replace
v0 with production data once it's ample.

Recommendation: **Path C for home-mgmt (highest volume), Path B for the
rest** until production verifies the synthesized labels reflect real
behavior.

## Per-workload eval shape

### home-mgmt classify path (HA pulse → anomaly / escalation decision)

**Task framing:** Given a `ha:ha_pulse` response (snapshot_id, totals,
anomalies.unavailable, anomalies.notifications) + the current
`working_memory.open_threads`, classify the right tick action:
- `short_circuit_no_change` — snapshot matches last_pulse_id + no anomalies
- `note_to_thread` — anomaly seen but already-tracked or below threshold
- `escalate_for_diagnosis` — chain_start to codex-acp-deep with plan
- `act_with_approval` — queue an HA service call (rare; pending approval)

**Corpus shape:** input is the pulse payload + working_memory. Output is
the action class. 4-way. n=100+ targeted via synthesis or 1 week of
instrumented production.

**Harness:** `eval-base-only.sh` works as-is once the test.jsonl is
chat-formatted with the few-shot exemplars in the user turn.

**Anchor model:** Qwen3-8B mac-mini :8090.

**Candidates to test:** Granite-4.1-3b Q8 (proved itself today), Gemma 4
E4B UD-Q4_K_XL, Granite-4.1-8b Q4.

### home-mgmt HA actions (tool-call path)

**Frozen per K-track.** Re-entry conditions in
[[project-k-track-frozen-2026-05-16]]. Don't run a corpus-build here yet;
the binding constraint is at the adapter layer
(`reference_claude_agent_acp_tool_call_wire_shape`), not the model.

### task-refiner long-lived

**Generation task.** Eval requires a judge model scoring rubric: did the
refined task preserve the user's intent, sharpen the contract, and remove
noise without dropping requirements?

**Corpus shape:** pairs of (draft_task, refined_task_gold) where the gold
is human-written or strong-model-generated. n=30-50.

**Harness:** new — `eval-generation-rubric.sh`. Takes (input, gold,
candidate_output), feeds all three to a strong judge model (Qwen3-8B
+ jinja initially; later Gemini Pro for stronger ground truth), scores
on intent_preservation + contract_clarity + noise_removal each 0-3.

**Anchor model:** whatever the task-refiner role currently resolves to.
Identify via agentchat.yaml resolution.

### dispatch-refine

**Same shape as task-refiner.** Same harness. Different corpus (raw
chain_start prompts vs draft tasks).

### t2-promotion judge pool

**Ops issue first.** The agents `granite-mini-8b` (mac-mini :7843) and
`local-granite-8b` (:8080) appear unreachable in the daemon log (13,355
"all judges unhealthy" errors going back to 2026-05-06). Diagnose
whether the endpoints are wrong, the agents disabled, or the rollup
input pipeline is empty before doing any model-quality work.

After revival: classification task (promote / not), similar shape to
memory-efficacy. Same eval harness applies.

### memory recall scoring (re-rank)

**Re-rank shape.** Given query + N candidate t2 memories, output a
ranking. Eval: NDCG@K or MRR against gold labeled by a human or strong
model. Higher-volume than memory-efficacy.

**Inspect first:** find where the re-rank call happens in
`packages/core/src/services/` or `packages/daemon/src/` and whether it
uses the same `resolveJudgeConfig` path or its own configuration.

## Order of operations (recommended)

1. **t2-promotion ops triage** — fix the 100% unhealthy judge pool. Not
   a model question. ~30 min.
2. **memory recall scoring inspection** — find the call site, confirm
   whether it's LLM-driven or pure-embeddings. ~15 min.
3. **home-mgmt instrumentation** — land the tick-event writer spec.
   Pattern matches `memory_verify` auto-fire. ~1 hour to spec, ~2 hours
   to implement. Then wait.
4. **Concurrent: home-mgmt synthetic corpus + initial sweep** — codex-acp-spark
   pattern produces a v0 corpus from the standing_brief. Run
   eval-base-only.sh against Qwen3-8B (anchor) + Granite-3B-Q8 + Gemma 4
   E4B. ~3 hours.
5. **task-refiner / dispatch-refine generation harness** — bigger
   build. ~4-6 hours including corpus synthesis. Hold until home-mgmt
   results in.

## Why this is more than a session's work

Memory-efficacy succeeded because the corpus already existed and the
harness was a small extension. The remaining workloads each need either
new instrumentation or corpus synthesis before any model swap can be
evaluated. This is a multi-session project framed as fleet eval-infra,
not a per-model swap exercise.

The reusable artifact from today is `packages/train/scripts/eval-base-only.sh`
+ the procedure (anchor → small-model sweep → quant sweep). Extend it
per workload.
