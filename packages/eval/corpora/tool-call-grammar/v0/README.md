# tool-call-grammar / v0 (matrix eval)

`test.jsonl` (n=50) is the matrix-eval evaluation set for the
`tool-call-grammar` workload. Scoring shape: `{messages, tools, tool_choice}`
with gold pulled from `messages[-1].tool_calls` (or no-tool-call assistant
content). The set-equality metric is `(name, sorted arg_keys)` per call —
see `packages/eval/src/matrix/workloads/tool-call-grammar.ts`.

## Provenance

Composed verbatim from the K-track `uncommon-v0` audit-trail corpus:

- `packages/train/corpora/tool-call-grammar/uncommon-v0/splits/test.jsonl` (n=8)
- `packages/train/corpora/tool-call-grammar/uncommon-v0/splits/valid.jsonl` (n=4)
- `packages/train/corpora/tool-call-grammar/uncommon-v0/splits/train.jsonl` (n=38)

The first 8 rows match the prior matrix `test.jsonl` byte-for-byte, so any
prior matrix cell scored against the original n=8 corpus can be recovered by
filtering this run's per-row results to the first 8.

The K-track `uncommon-v0` corpus is frozen as audit trail (see
`packages/train/corpora/tool-call-grammar/FROZEN.md`). This eval-side copy
is a stable read-only fixture and does not re-enter the K-track. Adding rows
here is a matrix-eval decision, not a K-track decision.

## Composition

- 5 no-tool-call (assistant answers directly)
- 34 single-call
- 11 multi-call (mostly 2-call sequences)

## Tier splits (committed as siblings of `test.jsonl`)

- `tier-nocall.jsonl` (n=5) — assistant answers directly, no tool_call.
- `tier-single.jsonl` (n=34) — exactly one gold tool_call.
- `tier-multi.jsonl` (n=11) — 2+ gold tool_calls in a single assistant
  turn. **Known broken for `tool_choice: auto` evaluation** — see
  `packages/eval/results/2026-05-18-tool-call-gold-tier-diag.md`. All
  four production candidates scored 0/11 because the natural-and-correct
  multi-step behavior is to emit calls one-at-a-time across turns, not
  in a single turn. Needs either multi-turn rollout or prefix-match
  gold semantics before this tier is usable.

Rebuild via
`jq -c 'select((.messages[-1].tool_calls // []) | length == K)' test.jsonl > tier-...jsonl`.

## Bench continuity

Last recorded score against the n=8 ancestor (2026-05-18):

- gemma4-26b-a4b-mtp = 5/8 = 0.625

To recover that cell from a v0 (n=50) run, filter per-row scores to the
first 8 rows and recompute mean exact-match.
