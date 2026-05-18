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

## Bench continuity

Last recorded score against the n=8 ancestor (2026-05-18):

- gemma4-26b-a4b-mtp = 5/8 = 0.625

To recover that cell from a v0 (n=50) run, filter per-row scores to the
first 8 rows and recompute mean exact-match.
