# uncommon-v0

Hand-crafted tool-call prompts where the failure surface is not common easy-path tool calls. Formerly named `adversarial-v0`; renamed 2026-05-16 per the K-track adversarial-review (`naming_clarity` persona): the rows are "uncommon," not "adversarial" — base Qwen3 + `--jinja` handles them with 88-96% name-first accuracy; the remaining failures are stylistic/semantic disagreements with the gold labeler, not model errors. See `docs/notes/k-track-grammar-control-2026-05-16.md` for the failure-mode decomposition that motivated the rename.

Distribution (50 rows total):

- 9 multi-tool — 2+ sequential calls
- 13 name-collision — 3+ near-name tools, most-specific should win
- 10 ambiguous-intent — tool vs chat reply boundary
- 18 schema-edge — datetime regex, enums, optionals, arrays, deeply-nested objects

Status: **FROZEN** as of 2026-05-16. See `../FROZEN.md`. Do not extend without first landing the production-trace gold-labeling pipeline named in the decision contract.

Files:

- `seed.jsonl` — first 25 rows (batch 1, dispatched via `chain_start`)
- `seed-batch2.jsonl` — next 25 rows (batch 2, dispatched separately)
- `splits/{train,valid,test}.jsonl` — stratified 38/4/8 split by SHA1(id), used for K.5 training
- This README

Row schema: `{id, category, messages, tools, notes}`. The assistant turn in `messages[-1]` carries the gold output (either `tool_calls` for positive rows or `content` for negative chat-reply rows).

Scorer: `packages/train/scripts/eval-tool-calls.sh` accepts prefix-match for sequential multi-tool emission. Name-first match is reported over positive rows only (no-tool-expected rows have undefined first-tool match).

Known caveats:

- Some rows use current-date examples; if extended, update timestamps.
- Several "value mismatch" failures in K.4 (e.g. `{"query":"parser implementation"}` vs `{"query":"parser"}`) are not model errors — they're disagreements with the gold labeler's stylistic choices.
- `assistant.tool_calls` blocks are target shapes for training/eval, not runtime transcripts.
