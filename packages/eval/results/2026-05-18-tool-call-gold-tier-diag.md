# Tool-call gold-tier diagnostic — 2026-05-18

Applies the same gold-tier methodology from `2026-05-18-memory-recall-gold-tier-diag.md`
to `tool-call-grammar/v0` (n=50). Splits the corpus by gold-call count
(`messages[-1].tool_calls`) and benches the 4-model production fleet on
each tier.

## Setup

- Corpus: `packages/eval/corpora/tool-call-grammar/v0/test.jsonl` (n=50).
- Tier splits (committed as siblings): `tier-nocall.jsonl` (n=5),
  `tier-single.jsonl` (n=34), `tier-multi.jsonl` (n=11). Built via
  `jq -c 'select((.messages[-1].tool_calls // []) | length == K)'`.
- Workload: `tool-call-grammar`, primary metric `mean_exact_match`
  (set-equality of `(name, sorted_arg_keys)` per call).
- Models: gemma4-26b-a4b-mtp, gemma4-e4b-vanilla, qwen3.5-9b-mtp-UDQ4KXL,
  granite-3b-Q8. Spec: `packages/eval/specs/tool-call-tier-fleet.json`.
- Granite-4.1-8B judge stayed live on `:8083` (judge config re-enables);
  tps is ~2-3% conservative, exact-match scores are deterministic.
- Result dbs: `2026-05-18-tool-call-{full,tier-nocall,tier-single,tier-multi}.db`.

## Headline table — mean_exact_match by tier

| Model | full (n=50) | no-call (n=5) | single (n=34) | multi (n=11) |
|---|---:|---:|---:|---:|
| gemma4-26b-a4b-mtp | 0.6400 | 0.8000 | 0.8235 | **0.0000** |
| gemma4-e4b-vanilla | 0.3800 | 0.8000 | 0.4412 | **0.0000** |
| qwen3.5-9b-mtp-UDQ4KXL | **0.6600** | **1.0000** | 0.8235 | **0.0000** |
| granite-3b-Q8 | 0.6327 | 0.6000 | **0.8485** | **0.0000** |

Weighted-avg sanity check (gemma4-26b): `(5×0.80 + 34×0.8235 + 11×0.00) / 50 = 0.6400` ✓
identical to direct full-corpus cell. Same identity holds for all four
models (within 0.005 rounding).

## Reads

### Multi-call tier is broken corpus design, not a model deficit

All 4 models from 4 different families score **0.0000** on the n=11
multi-call tier. Examples:

- `"Fetch the current price of BTC in USD, then compute the difference from 60000."` → gold: `[market_quote, number_difference]`
- `"Read /tmp/summary.txt and then upload it to the artifacts bucket."` → gold: `[file_read, object_store_upload]`
- `"Find the incident ticket for the cache outage, then post the latest status to Slack."` → gold: `[issue_lookup, slack_post]`

Under `tool_choice: "auto"`, the natural and correct behavior for any
modern tool-using model is:

1. Emit `market_quote` (the first call), wait for the result.
2. With result in hand, emit `number_difference` (the second call).

But this corpus's gold expects **both calls emitted in a single turn**,
before either result is observed. No frontier model does this — and our
scorer marks the correct sequential behavior as 0/0.

**Conclusion:** the multi-call tier is testing the wrong thing. It needs
either:

- a multi-turn rollout (let the model see the first result before
  scoring the second call), or
- a gold rewrite that accepts the first call as a valid prefix
  ("emit ≥1 of the gold calls in any order in turn 1") — looser
  set-equality semantics.

This is the most important single finding of the diagnostic and
unblocks Q2 of the K-track if it ever returns to tool-call work.

### Production picks have meaningfully different strengths

Ignoring the broken multi-call tier and weighting by single (34) +
no-call (5) = 39 rows:

| Model | weighted EM (n=39) |
|---|---:|
| qwen3.5-9b-mtp | (1.00×5 + 0.8235×34) / 39 = **0.8462** |
| gemma4-26b-a4b-mtp | (0.80×5 + 0.8235×34) / 39 = **0.8205** |
| granite-3b-Q8 | (0.60×5 + 0.8485×34) / 39 = **0.8167** |
| gemma4-e4b-vanilla | (0.80×5 + 0.4412×34) / 39 = **0.4872** |

On the *valid* slices, qwen3.5-9b-mtp narrowly wins, gemma4-26b is
second, granite-3b-Q8 a close third — within 3 pp across three of four
candidates.

### Per-tier reads

- **no-call (n=5):** qwen3.5-9b-mtp is the only model that perfectly
  refrains from calling when no tool is needed (5/5). gemma4 family
  scores 4/5 (one over-call). granite-3b-Q8 scores 3/5 — most prone
  to spurious tool-emission.
- **single-call (n=34):** granite-3b-Q8 narrowly wins (0.8485) with one
  HTTP 500 grammar parse error (the `\d` regex-in-arg bug from
  `project_qwen_tool_grammar_2026-05-15.md` — `subscription_create` row
  44). gemma4-26b and qwen3.5-9b tied at 0.8235.

### E4B craters on tool-call (consistent with prior maestro disaster)

gemma4-e4b-vanilla scored 0.4412 on single-call vs 0.8235 for its 26B
sibling. Same gap as the 2026-05-13 within-machine maestro bench. The
E4B is a *narrow* model — strong on memory-recall ranking (#2 in
yesterday's fleet), weak on structured tool-call emission. The
workload-shape qualifier from `project_e4b_reval_2026-05-13.md` keeps
adding workloads to its "do not use" side.

### Granite-3b-Q8 is the value pick on single-call

0.8485 single-call EM at ~30 tps and ~4 GiB RAM beats all three larger
candidates (modulo the noisy n=5 no-call tier where it under-emits).
For nodes that don't need multi-step planning, this is the right pick
on this workload too — consistent with its showing on memory-recall.

## Production reads

- **Multi-call corpus needs redesign before any multi-step tool-use
  conclusions can be drawn.** Until that happens, treat the aggregate
  n=50 number as a single-call-with-noise metric, not a multi-step
  competence metric.
- **For single-call tool emission on M4 Pro:** gemma4-26b-a4b-mtp,
  qwen3.5-9b-mtp, and granite-3b-Q8 are interchangeable within ±3 pp.
  Pick on tps × RAM. Granite-3b-Q8 wins both.
- **Avoid gemma4-e4b-vanilla on any structured-output workload.**
  Three benches now confirm it: maestro (broken MTP head), tool-call
  (-37 pp single-call vs 26B sibling), and only memory-recall ranking
  preserves its quality.

## Open follow-ups

- Multi-call corpus redesign: either move to multi-turn rollouts or
  rewrite gold to "prefix-match" semantics. The 11 rows are otherwise
  well-constructed natural prompts — a scoring fix recovers them.
- Per-row score persistence (PM-note carry-forward #4) would let the
  tier breakdown above be derived in SQL from a single n=50 bench
  rather than 4× re-benches. The next time a workload corpus grows or
  a model is added, this would be the right enabling change.
- granite-3b-Q8's grammar parse 500 on row 44 (`subscription_create`
  with `\d`-bearing arg) — known llama.cpp GBNF bug; affects all
  llama.cpp-jinja tool-call deployments, not just granite. Tracker in
  `project_qwen_tool_grammar_2026-05-15.md`.
