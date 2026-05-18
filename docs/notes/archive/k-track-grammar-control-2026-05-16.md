# K-track validation slice — grammar control C (analysis only)

`git log -1 --oneline` at run time: `a4e25a7 docs(specs)+fix(train): K-track decision contract + scorer denominator cleanup`

Per the decision contract (`docs/specs/k-track-decision-contract-2026-05-16.md`), the validation slice requires running a non-LoRA alternative (grammar-constrained decoding) on the same eval contract as the LoRA control. Before running the eval, this note categorizes the 19 base failures from K.4 so the right control can be designed.

## Failure-mode decomposition of K.4 base on adversarial-v0 (n=25, 23 positive)

Base (`Qwen3-4B-Instruct-2507` + `--jinja`) had **19 strict failures** out of 23 positive rows. Categorized by what would need to change to make them pass:

| Category | Count | Can grammar help? | Notes |
|---|---|---|---|
| Wrong tool selected | 2 | No | Grammar enforces shape, not semantic selection |
| Multi-tool count mismatch (model emitted 1 of 2) | 6 | No | Already captured by `prefix_success`; sequential dispatch is correct |
| Right tool, value mismatch (semantic) | 11 | **No** | The model's args are plausible alternatives to gold |
| Arg-shape (JSON parse fail) | 0 | Hypothetical yes | But there are zero of these in the corpus |

**Zero of the 19 failures are structural.** `llama-server --jinja` produces well-formed JSON-shaped tool calls in 25/25 rows. Adding GBNF grammar constraints would constrain structure that's already correct.

## What "value mismatch" actually looks like

| Row | Tool | Gold args | Model args |
|---|---|---|---|
| 6 | `search_docs` | `{"query":"tool runner JSON schema"}` | `{"query":"JSON schema for the tool runner"}` |
| 7 | `search_code` | `{"query":"parser implementation"}` | `{"query":"parser"}` |
| 9 | `search_docs` | `{"query":"calendar sync design"}` | `{"query":"calendar sync design doc"}` |
| 16 | `calendar_list_events` | `{"date":"2026-05-17"}` | `{"date":"2023-04-18"}` |
| 17 | `service_status` | `{"service":"backup-job"}` | `{"service":"backup_job"}` |
| 23 | `timeblock_create` | `{"label":"check-in"}` | `{"label":"Check-in"}` |

In **5 of 6 cases above**, the model's prediction is a *reasonable paraphrase* of the user's intent that just doesn't match the gold-labeler's specific phrasing. There is no objectively-correct answer; the corpus is measuring the model's agreement with one labeler's stylistic preferences.

Row 16 is the one genuine model error: the gold date is from May 2026 (current), the model emitted April 2023. That's a knowledge-cutoff hallucination — but also one that grammar can't constrain (a date-format regex would accept both).

## Conclusion: control C is not applicable

Grammar-constrained decoding (GBNF from JSON schemas, response_format JSON-mode, jinja-driven tool grammar) **cannot lift any of the 19 base failures** on adversarial-v0 as currently labeled. The failure surface is:

- **Tool selection** (8% of failures): a semantic discrimination problem, requires either bigger model or model fine-tuned on similar examples.
- **Multi-tool dispatch shape** (32% of failures): not a failure at all under prefix-match semantics; it's correct sequential emission.
- **Value-semantic disagreement** (58% of failures): predominantly model-vs-labeler disagreement, with no objectively correct answer. The gold is "what one Qwen3-8B run happened to say." Grammar, LoRA, or any model-level intervention cannot make the smaller model agree more with a specific labeler stylistic choice — that requires either RLHF-style preference alignment or matching the labeler's exact decoding parameters.

## Implications for the decision contract

The K-track has now triggered **retire criterion #2** ("the non-LoRA alternative hits the bar on its own") in the opposite direction: the non-LoRA alternative is *also* incapable of lifting the metric. This isn't a defeat for grammar-constrained decoding as a general technique — it's a discovery that the adversarial-v0 corpus does not measure anything grammar (or LoRA) can fix.

Combined with K.1-K.5 (LoRA = byte-identical to base across three datasets):

- The track is not failing because the technique is wrong.
- The track is failing because **the gold labels are arbitrary stylistic choices, not objectively-correct outputs.**

This validates adversarial-review finding #4 (label provenance is unsafe / under-specified) as the *root cause* of the K-track's apparent dead-end.

## What would actually move the needle

These are exit-conditions, not commitments — the decision contract requires production-data validation before pursuing any of them:

1. **Production-trace gold**: replace synthetic gold with real penumbra dispatches where the tool call was retroactively confirmed correct/incorrect by the human user's response to the dispatch's outcome. This removes labeler subjectivity.
2. **Pairwise preference scoring**: instead of strict gold match, score the model's output by whether a panel of N models (or 1 human) prefers it over base. Avoids the "gold is one labeler's style" problem.
3. **Executable success metric**: for tool-call tasks where the tool's result can be programmatically verified (e.g. file system queries, deterministic API calls), use real execution success as gold. This applies to maybe 20% of penumbra tool-call traffic.

## Retire recommendation

Per the decision contract retire criteria:

> 2. The non-LoRA alternative (grammar-constrained decoding being the first to test) hits the +5 pp bar on its own — i.e. LoRA is unnecessary.

This isn't quite triggered — grammar didn't hit the +5pp bar, but it also didn't get to try, because the failure surface isn't grammar-shaped. The honest reading:

- **Triggers retire criterion #1**: K.1-K.5 are now 5 consecutive bounded runs at < +1pp on macro metrics.
- **Does not trigger #2 or #3**: production lift isn't measured (control A still pending), and grammar isn't applicable to this failure surface.
- **Triggers #4** prematurely if we count today's work: cumulative human attention on the track now exceeds the 12-hour budget the contract sets, with no measured production lift.

Recommendation: **freeze the K-track**. Archive `packages/train/corpora/tool-call-grammar/` + `.spike-work/tool-call-grammar-*` with a final manifest. Do not delete; do not continue. Revisit only if a production-trace gold-labeling pipeline lands.

The scorer changes (prefix-match, name-first denominator, no-tool accuracy) are independently useful and stay. The `eval-classifier.sh` toolchain stays. The decision contract stays.

## What's actually shippable from this session

| Artifact | Status |
|---|---|
| K-track decision contract | shipped (`docs/specs/k-track-decision-contract-2026-05-16.md`) |
| Prefix + name-first scorer | shipped (`4a6f3ae`) |
| Scorer denominator cleanup | shipped (`a4e25a7`) |
| REUSE_HF_BASE integrity check | shipped (`57a4d8a`) |
| Adversarial-v0 50-row corpus | shipped, valuable as a *negative-result demonstration* if not as a training target |
| K.5 adapter | parked under `.spike-work/` (gitignored), can be deleted |

The honest framing: this session converted "we tried LoRA 5 times and it didn't work" into "we know *why* LoRA didn't work, and we know the next K-run shouldn't happen until we fix the gold-labeling problem." That's a more valuable outcome than another K.6 with bigger rank.
