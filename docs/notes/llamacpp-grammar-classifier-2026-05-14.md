# llama.cpp grammar plan for memory-efficacy classifier (2026-05-14)

## 1. TL;DR
- Yes, grammar-constrained sampling is the right fix for the "valid-but-short" silent-drop bug.
- In current bench data, the drop is mostly full-batch loss (no parseable JSON), plus at least one true silent short-array case (9/10 items with valid JSON).
- Enforcing exact array length (10) plus bucket enum should remove silent under-count outputs and force parse failures instead of quietly losing findings.
- Cost is low (small harness change + one grammar file); primary risk is accuracy regression from tighter decoding constraints.
- Recommend per-request `grammar` in `run-bench.ts` (not server-global `--grammar-file`) so this is scoped, reversible, and experiment-friendly.

## 2. Grammar design

### Verified current schema in source
From current code:
- `penumbra/packages/core/src/services/memory-efficacy-classifier.ts`
- `llamactl/tools/memory-efficacy-bench/run-bench.ts`

Current classifier shape is:
```json
[{ "findingId": "<string>", "classification": "<bucket>", "reason": "<string>" }]
```

This differs from the recalled `{ index, bucket, reason, evidence[] }` shape. For this pass, grammar is aligned to the live schema actually consumed by the classifier/harness.

### Draft GBNF
```gbnf
# Memory-efficacy classifier output grammar for llama.cpp
#
# This variant matches the CURRENT classifier prompt/schema used by:
#   - penumbra packages/core/src/services/memory-efficacy-classifier.ts
#   - llamactl tools/memory-efficacy-bench/run-bench.ts
#
# It enforces:
#   - valid JSON array
#   - exact object shape + key order
#   - bucket enum membership
#   - exactly 10 entries (production bench batch size)
#
# NOTE: if batch size changes, regenerate `root` cardinality.

root ::= ws "[" ws entry (ws "," ws entry){9} ws "]" ws

entry ::= "{" ws
  "\"findingId\"" ws ":" ws finding-id ws "," ws
  "\"classification\"" ws ":" ws bucket ws "," ws
  "\"reason\"" ws ":" ws reason
ws "}"

# Primary form is 32-hex findingId hashes; keep numeric fallback to match
# run-bench's positional fallback behavior for degraded outputs.
finding-id ::= "\"" (hex32 | index-id) "\"" ws
hex32 ::= [0-9a-f]{32}
index-id ::= [1-9] [0-9]{0,2}

bucket ::= (
  "\"memory_ignored\""
  | "\"recall_miss\""
  | "\"missed_registration\""
  | "\"not_memory_related\""
) ws

# Keep reason as a short JSON string. Prompt still instructs <= 80 chars;
# grammar allows extra headroom so valid generations are not over-constrained.
reason ::= "\"" reason-char{1,200} "\"" ws
reason-char ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt] | "u" [0-9a-fA-F]{4})

# Optional JSON whitespace
ws ::= | " " | "\n" [ \t]{0,20}
```

### What this can and cannot enforce
Can enforce:
- JSON validity.
- Allowed bucket set membership.
- Exact key set/order for each object.
- Exact array length of 10 entries.

Cannot enforce:
- That each `findingId` matches one of the specific 10 IDs sent in the prompt.
- Uniqueness across the 10 entries.
- Correct semantic mapping between finding text and chosen bucket.
- Index ordering constraints (since live schema is `findingId`, not `index`).

## 3. Wire-up plan (`run-bench.ts`)

### Recommendation
Use **per-request `grammar` field** on `/v1/chat/completions`.

Why this option:
- Keeps scope local to this classifier bench.
- No server restart/reconfigure needed.
- Easy kill-switch in harness flags.
- Avoids server-side JSON-schema conversion differences/quirks for first rollout.

### Request shape
Current request in `callChat()` should add:
```json
{
  "model": "...",
  "messages": [{ "role": "user", "content": "..." }],
  "temperature": 0,
  "max_tokens": 2048,
  "grammar": "<contents of tools/memory-efficacy-bench/grammars/classifier.gbnf>"
}
```

### Exact change outline
1. Add CLI flag `--grammar-file` (default empty).
2. If provided, `readFileSync(grammarFile, 'utf8')` once in `main()`.
3. Pass optional `grammar` into `callChat()` and include it in POST body.
4. Add summary metadata in output JSON (`grammar_file`, maybe short hash).

### Why not the other options first
- `--grammar-file` on server process: global and coarse; affects all requests hitting that server.
- `response_format: json_schema`: viable later, but first pass should avoid converter behavior ambiguity and keep full control of exact grammar text.

## 4. Verification plan

Do not run in this pass; run later with existing harness against mac-mini `:8090`.

### A/B runs
1. Baseline (current prod prompt, no grammar):
```bash
bun tools/memory-efficacy-bench/run-bench.ts \
  --url http://127.0.0.1:8090 \
  --model local \
  --batch-size 10 \
  --out ./bench-results/classifier-baseline-no-grammar.json
```

2. Grammar-on (same prompt/model, add grammar):
```bash
bun tools/memory-efficacy-bench/run-bench.ts \
  --url http://127.0.0.1:8090 \
  --model local \
  --batch-size 10 \
  --grammar-file ./tools/memory-efficacy-bench/grammars/classifier.gbnf \
  --out ./bench-results/classifier-grammar-on.json
```

### Success criteria
- Drop elimination target:
  - `findings_in_predictions == findings_attempted` (or very close if rare hard failures remain).
  - No batches with 1..9 parsed entries.
- Quality preservation target:
  - Overall `bucket_accuracy` non-inferior to baseline.
  - Per-bucket F1 (especially `recall_miss`) non-inferior within agreed tolerance.

## 5. Risks
- Grammar can reduce decoder flexibility and hurt classification quality even while fixing structure.
- Exact-10 grammar can turn some previously "short but valid" outputs into hard parse failures if `max_tokens` is too tight.
- Over-tight field constraints can reject otherwise good outputs (e.g., longer reasons).

Detection/guardrails:
- Compare per-bucket F1 and confusion matrix against baseline.
- Track batch-level parse-failure count and short-batch count separately.
- Keep a one-flag kill-switch (`--grammar-file` unset = immediate rollback).

## 6. Open questions for maestro
1. **Schema target decision:** stay on live `findingId/classification/reason`, or move to `index/bucket/reason/evidence[]` first and then grammar-lock that?
2. **Batch-size policy:** standardize on 10 everywhere, or keep penumbra classifier at 5 and use a generated exact-N grammar in bench/runtime?
3. **Constraint strategy:** hand-authored GBNF (this doc) vs `response_format/json_schema` with `minItems=maxItems` and enum constraints.
4. **Tolerance policy:** what non-inferiority thresholds are acceptable for overall accuracy and per-bucket F1 (especially `recall_miss`)?
5. **Reason-length policy:** keep grammar reason cap at 200 for robustness, or tighten closer to prompt cap (80) after first A/B readout?

## Notes from current bench artifacts
- `baseline-prod.json`: 470 attempted, 309 predicted (34.3% dropped), `bucket_accuracy` ~94.8%.
- `granite-8b-q4-m4pro-full.json`: 470 attempted, 319 predicted (32.1% dropped), `bucket_accuracy` ~94.98%.
- `granite-8b-q8-m4pro-full.json`: 470 attempted, 170 predicted (63.8% dropped), `bucket_accuracy` ~90.6%.
- There is at least one confirmed valid-but-short batch (9 entries) in current artifacts (batch 36 in baseline/q4 files), which is exactly the silent-drop class grammar should block.
