# Maestro continuation prompt — 2026-05-17 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories


- `t2:d0150802-72ec-497e-a98a-3bae79a0a040` — Architectural Decision: Thread `branch_base` Through Narrowest Path

- `t2:af3adbd5-befc-485d-aa6d-738295850a6b` — User Preference: Focus on Smallest Failing Tests First (TDD Approach)

- `t2:6cb9bd73-1d13-4676-a67f-9ed231d4eb68` — Long-Lived Domain Fact: Worktree Manager Supports `baseRef`

- `t2:cf9101f6-dcf9-4c9a-829d-a1ba9a2dbfc3` — Trap: Initial Worktree Test Idea Inadequate

- `t2:9086cc0a-a279-48b9-bae5-5ceac263466e` — Trap: Schema Layer vs. Actual Table Mismatch

- `t2:67d7899a-f88c-40c2-8bb5-f183d4a17e3a` — User Preference: Stage Only Intended Source and Test Edits

- `t2:a63852e5-1ff3-4a72-9c8d-d6e040acc3d9` — Project Rule: Handoff Writer and Schema Must Persist `branch_base`

- `t2:166d6ea2-1cab-40c9-98c2-6b1df41dacc8` — Typecheck guard for tasks indexing

- `t2:c9a4b7de-c5ed-479d-9e3a-566fb3e8b718` — Focused test suite for parser and sweeper edge cases

- `t2:8323dd8a-3e25-43dc-8134-3d2a6dcf1d50` — Repository-wide typecheck noise exclusion

- `t2:ad32fc1f-b7e7-409f-ac91-403bb4ff4c27` — Inline per-task prose into plan-runtime leaf prompts

- `t2:b9b1798e-00b5-45a6-81ca-6276feabff7e` — Regression Test Suite for Search Queries


### Commits since midnight

```
d551473 docs(notes): attention-thesis eval — add Gemma 4 E2B datapoint
9c8328f feat(train)+docs(notes): cross-family eval of few-shot lift on memory-efficacy
10a8d76 feat(remote): interpolate ${env:VAR} in workload manifests
6bd9d80 docs(notes): maestro-continuation 2026-05-16 pm-3 — sirius decouple, validation arc, corpus bootstrap
f969838 docs(notes): M-track corpus bootstrap — auto-fire memory_verify path
397fc7e docs(notes): M-track few-shot production verification — corpus shape blocks the lift measurement
695e786 templates(workloads): qwen3-8b-local — dedicated memory-efficacy judge on :8085
75f6c35 docs(notes): maestro-continuation 2026-05-16 pm-2 — full session narrative + handoff
a2072e0 docs(notes): K-track strategy brief used as input to adversarial-review #2
40b90cb ship: few-shot prompt lifts memory-efficacy macro-F1 by +20.6 pp
7e771ff docs(specs)+(notes): M-track decision contract + failure decomposition — do NOT freeze
3634a20 freeze(k-track): rename adversarial-v0 → uncommon-v0 + FROZEN marker
d6cc528 docs(notes): K-track validation slice — grammar control C is N/A
a4e25a7 docs(specs)+fix(train): K-track decision contract + scorer denominator cleanup
c68c209 docs(notes)+corpus(tool-call): K.5 — adapter trained on adversarial-v0 is byte-identical to base on held-out test
57a4d8a fix(train): verify cached HF base identity before REUSE_HF_BASE skips fetch
4a6f3ae feat(train): prefix-match + name-first scorer for eval-tool-calls
43b7e94 corpus(tool-call): adversarial-v0 batch 2 — 25 more rows (50 total)
0f3406e docs(notes): K.4 — Qwen3-4B adapter does not lift on adversarial-v0
e84bda3 docs(notes): memory-efficacy M.7+M.8 — retrained adapter is byte-identical
a906ff8 feat(train): REUSE_HF_BASE=1 to skip destructive HF refetch on retrain
ac81966 docs(notes): memory-efficacy M.6 — rebalancing does not move minority floor
61ca405 corpus(memory-efficacy): balanced 4-way sibling corpus (M.5) - 3x minority ratio
b0831f1 docs(notes): memory-efficacy M.4 — adapter does not lift over base on n=60
eb54588 docs(notes): memory-efficacy 4-way re-eval on expanded test set (M.4)
5d1bf03 fix(train): restore kill_port arg + wait_port_bindable in eval scripts
5cdfcec corpus(tool-call): adversarial-v0 seed (25 rows, 4 categories) for K.3
3b88bb2 fix(core): refuse non-loopback --host bind without explicit opt-in
6a23551 chore(train): syntax-check tier + drop dead package.json script
5186498 refactor(train): extract scripts/lib.sh + env-ref template binary path
cffe15f chore(train): drop dead/one-shot scripts + fail-loud on unknown classification
ed6c087 fix(train): strict tool-call scorer, stratified split, port-kill identity guard
4561b06 corpus(memory-efficacy): expand minority pool to ~35/class (+46 synthetic rows)
3e17135 fix(corpus): memory-efficacy mod-10 split by hash(findingId) — break synthetic family-leakage
48ceae1 docs(notes): syn-mi-* audit — 4 of N borderline rows flagged for relabel review
4206279 fix(train): eval-tool-calls.sh reads gold tool_calls from messages[-1]
e3ab1e0 feat(train): eval-tool-calls.sh — base-vs-adapter parse-success rate harness
578898d feat(train): tool-call grammar train/valid/test splits + prep.py
b64106d feat(train): tool-call grammar corpus v0 + eval-classifier per-class metric fix
3dcadd4 docs(corpus): refresh README counts, add source provenance to gold-labels
8a5d612 feat(train): 4-way eval framing + chat-format extraction + report bug fixes
5a712e9 feat(corpus): merge synthetic positives + stratified per-class mod-10 split
ab46af5 feat(corpus): synthetic minority-class findings for memory-efficacy stratification
9973241 fix(train): smoke chat-template thinking-off, kill_port grace, exp backoff on 503
6b8ff3a fix(train): preserve false memory_related predictions
091e16a feat(train): eval-classifier.sh — WRAP_CHAT_TEMPLATE knob for chat-format adapters
1f5b886 feat(train): chat-formatted memory-efficacy binary corpus (mlx-lm chat schema)
9acc524 chore(train): drop stale dispatch-routing probe marker
```

### Commit context (bodies)


**`d551473bdf7cdaf9a5f5130b391fac0fe40d5f5f`** — docs(notes): attention-thesis eval — add Gemma 4 E2B datapoint

Gemma 4 E2B-Q8_0 (~2B effective): macro-F1 0.8386 (-5.45 pp from Qwen3-8B).
Confirms the Gemma 3n E2B result (-4.62 pp) — the productionized Gemma 4
E2B is within noise of the 3n preview at the same size. Both decisively
beat Qwen3-1.7B (0.5830) at similar parameter counts; the family-quality
attention-floor finding holds across the Gemma 3n → 4 transition.



**`9c8328f1a69a9f895ea7c1b03a1d08edd9ccc844`** — feat(train)+docs(notes): cross-family eval of few-shot lift on memory-efficacy

Adds eval-base-only.sh — base-only sister of eval-classifier.sh that runs
one model against a chat-formatted test set and computes per-class
precision/recall/F1 + macro-F1.

9-model evaluation of the memory-efficacy 4-way few-shot prompt on the
existing n=60 test split. Anchored at Qwen3-8B-Q4_K_M (0.8931, matches
prior offline measurement byte-for-byte). Key findings:

- Gemma 4 E4B-it-UD-Q4_K_XL (~4B eff): 0.8931 — byte-identical to 8B
  anchor, same per-class breakdown.
- Granite-4.1-3B-Q4_K_M (3B): 0.8734 (-1.97 pp).
- Gemma 3n E2B-Q8_0 (~2B eff): 0.8469 (-4.62 pp) — beats Qwen3-1.7B at
  similar size by 26 pp.
- Qwen3-1.7B-Q8_0: 0.5830 (-31 pp); 0/4 on memory_ignored. Below floor.
- Phi-4-reasoning-plus: 0.4471 + 20 parse failures (reasoning trace blows
  token budget). Wrong tool class.

Attention-capacity floor is family-quality, not param-count.
Production candidate identified: Gemma 4 E4B as drop-in replacement for
the qwen3-8b-local judge at :8085. Pending replication on the auto-fire
memory-verification corpus once it accumulates ~100+ rows.



**`10a8d769573756608f39928c9657de35700bbffa`** — feat(remote): interpolate ${env:VAR} in workload manifests

Workload templates like qwen3-8b-mac-mini.yaml use `binary: ${env:LLAMA_SERVER_BIN}`
expecting env-ref substitution at apply time, but parseWorkload passed the YAML
text verbatim to the schema validator — the literal string ${env:LLAMA_SERVER_BIN}
ended up in spec.binary and the local control plane treated it as a path.

Add interpolateEnvRefs(raw, env) that replaces ${env:VAR} tokens (matching
[A-Z_][A-Z0-9_]*) with process.env values, throwing on any unset variable
so a missing binding surfaces at apply time rather than as a confusing
"binary not found" later.

Called once in parseWorkload before YAML parse; no schema changes.



**`6bd9d806fe823cd329fcde68abe2727d8ef9c9c0`** — docs(notes): maestro-continuation 2026-05-16 pm-3 — sirius decouple, validation arc, corpus bootstrap

8th continuation note for 2026-05-16. Picks up at 19:05 UTC after pm-2
ended (75f6c35) and covers the 3 llamactl + 5 penumbra commits this session
shipped, with full narrative of the structural-fix → validation-attempt →
why-we-can't-validate arc that landed on a corpus-bootstrap spec rather
than a finished verification.

Live state, open follow-ups, decisions-not-to-relitigate, and first moves
for the next session.



**`f969838fc32b6de0c3148534dbcfe96da8b8792c`** — docs(notes): M-track corpus bootstrap — auto-fire memory_verify path

Captures today's discovery that the M-track classifier's production
verification is blocked not by code but by an empty data well: penumbra's
memory-verification audit trail and obs_type column are fully scaffolded
yet hold zero labeled rows, because no production workflow naturally calls
memory_verify.

Diagnosis + recommended fix + caveats. Points at the penumbra-side spec
that proposes auto-firing verifyMemory at lane close so labels accumulate
passively. Identifies recall_miss detection as a separate follow-on signal
source requiring its own extractor.



**`397fc7e3ca20eed7ea5e14cb454c444af4e7d3a9`** — docs(notes): M-track few-shot production verification — corpus shape blocks the lift measurement

Captures the outcome of trying to verify the few-shot prompt's +20.6 pp
macro-F1 lift in production after the structural rebuild fixes landed.

Headline: the pipeline now works end-to-end (751/751 classified in 18 min
against local Qwen3-8B at :8085), but the production corpus is adversarial
code-review findings, not memory-failure findings. Hand-review of all 51
minority-class predictions found 0 true positives. The classifier is
keyword-matching `memory`/`recall`/`registry` terms onto the taxonomy
without the underlying scenarios being memory-efficacy failures.

Implication for the M-track decision contract: the offline +20.6 pp result
stands, but the production verification step is blocked on data shape.
Three remediation paths laid out (operational-review corpus, periodic
offline re-eval, or refusing minority predictions without dispatch context).



**`695e78663317bc90b64d26443fc51d1d13b77e62`** — templates(workloads): qwen3-8b-local — dedicated memory-efficacy judge on :8085

Stood up 2026-05-16 pm to validate the few-shot prompt landed at
penumbra@2a57160 against the same model the offline eval used.

Context: the mac-mini Qwen3-8B at :8090 is shared with home-mgmt (-np 2)
and timed out every classifier batch under concurrency=4 — 120/120 batch
failures in the rebuild run started at 21:20 UTC against penumbra's reviews
dir. A dedicated local server eliminates slot contention.

Verified: with this workload up at :8085 and `PENUMBRA_JUDGE_BASE_URL`
pointing at it, the same rebuild scanned and classified 751/751 findings
in 18 min (vs 51/751 against shared mac-mini). 0 batch failures from
the local Qwen3-8B run.

Port selection: :8085 — free vs the other running local workloads
(gemma4-26b-a4b-mtp-b-1024-local :8181, granite41-8b-long-lived-local :8083).

Wire-up note: this workload uses a hardcoded `binary:` path because
${env:LLAMA_SERVER_BIN} interpolation is not currently honored by the
control plane on `apply`. The mac-mini variant uses the interpolated form
because it goes through the remote node's resolution.



**`75f6c35c0a0f953d6282a2e2900b0e6ac9e8a73a`** — docs(notes): maestro-continuation 2026-05-16 pm-2 — full session narrative + handoff




**`a2072e044651625096b526d1be0b06639981c359`** — docs(notes): K-track strategy brief used as input to adversarial-review #2

The 17:42 adversarial-review (artifacts at .penumbra/reviews/2026-05-16T17-42-29.259Z/)
was driven by this brief. Referenced by docs/notes/k-track-grammar-control-2026-05-16.md
and the M-track decision contract; committing for audit trail.



**`40b90cbe4bf64b50852165c0b94746b1c7725445`** — ship: few-shot prompt lifts memory-efficacy macro-F1 by +20.6 pp

Per M-track decision contract validation slice part C. Three hand-picked
minority-class exemplars injected into the classifier user prompt lift
Qwen3-8B base from macro-F1 0.6868 (zero-shot, M.4) to 0.8931 (few-shot)
on the same n=60 test set. Per-class minority recall lifts:

  missed_registration  0.75 → 1.00 (+25 pp)
  recall_miss          0.50 → 0.75 (+25 pp)
  memory_ignored       0.25 → 0.75 (+50 pp)

Adapter remains byte-identical to base under few-shot as it was under
zero-shot — LoRA contributes nothing here. The "structural minority
floor" finding from M.6 is now reframed: the floor was a prompting
calibration issue, not a model-capability ceiling.

LoRA half of M-track is now retired by the contract's part-C rule.
Open ship item: wire the 3-exemplar prompt into penumbra's
memory_efficacy_* codepath (separate dispatch in penumbra repo).



**`7e771ffe15cc4528d09eae4081df4d4e91e1c3fb`** — docs(specs)+(notes): M-track decision contract + failure decomposition — do NOT freeze

Parallel to the K-track contract but with a different verdict. Decomposed
the 6 minority false-negatives on M.4 base: 6 of 6 are objectively-correct
labels the model failed on. Every misclassified prompt explicitly names
the memory mechanism ("recalled context", "memory event", "ranker drops
the only relevant memory") and the model still predicts not_memory_related.

This is a systematic prior-toward-majority bias, not labeler subjectivity.
K-track was frozen because the labels are arbitrary. M-track stays active
because the labels are objective and the failure is plausibly fixable
without retraining (few-shot prompting first, then two-stage, then larger
LoRA config).

Updates the validation slice priority: part C is now few-shot prompting,
not grammar-constrained decoding.



**`3634a20c06c475db75a077853235f4997f8d2d08`** — freeze(k-track): rename adversarial-v0 → uncommon-v0 + FROZEN marker

Renames the 50-row hand-crafted corpus per the adversarial-review
naming_clarity finding — base Qwen3 + --jinja hits 88-96% name-first
on these rows; the failures are stylistic disagreement with the gold
labeler, not adversarial in any meaningful sense.

Adds FROZEN.md at the tool-call-grammar/ root to formalize the
freeze decision and document the re-entry conditions. Historical
docs/notes still reference "adversarial-v0" as audit trail; do not
rewrite history.

Closes one open governance item from the decision contract.



**`d6cc5287560a51394f4c9022c98cb2da0b5f768e`** — docs(notes): K-track validation slice — grammar control C is N/A

Categorized 19 K.4 base failures: 0 structural, 2 tool selection,
6 multi-tool count, 11 right-tool-value-mismatch. The value-mismatch
cases are predominantly model-vs-labeler stylistic disagreements
(e.g. "parser implementation" vs "parser") with no objectively correct
answer.

Grammar-constrained decoding cannot help any of these — there are
no shape failures to constrain. Combined with K.1-K.5 LoRA byte-
identical results, recommendation per decision contract is to freeze
the K-track. Revisit only when a production-trace gold-labeling
pipeline lands.



**`a4e25a77746baced24bcb6618ffdb767fc281f4f`** — docs(specs)+fix(train): K-track decision contract + scorer denominator cleanup

Per the 2026-05-16 adversarial-review of the K-track strategy:

- docs/specs/k-track-decision-contract-2026-05-16.md: production metric
  + threshold + retire criteria. Required before any new K.N run.
- eval-tool-calls.sh: name-first denominator is now positive rows only
  (was total, which was undefined on no-tool-expected rows). Adds
  no-tool accuracy line. Drops dead args_ok field.

K.4 replay under new reporting:
  base    strict 6/25 | prefix 9/25 | name-first 21/23 (91.3% pos)
  adapter strict 6/25 | prefix 9/25 | name-first 22/23 (95.7% pos)



**`c68c209bcf1ab4c20731c8760fd0065ca81392c1`** — docs(notes)+corpus(tool-call): K.5 — adapter trained on adversarial-v0 is byte-identical to base on held-out test

Stratified 38/4/8 split of the 50-row adversarial-v0 corpus by category;
trained Qwen3-4B-Instruct-2507 LoRA on 38 rows (same hparams as K.1) and
evaluated on the held-out 8. strict 3/8, prefix 4/8, name-first 5/8 —
exactly matching base on every row. Third independent dataset where this
LoRA configuration shows zero lift; the K-track is exhausted at
rank=16/num_layers=16/iters=300.



**`57a4d8ac2f30e1b4135e8124932977856e9cd858`** — fix(train): verify cached HF base identity before REUSE_HF_BASE skips fetch

REUSE_HF_BASE=1 now requires:
- MODEL@revision pinned (no plain MODEL allowed)
- hf-base/config.json present
- hf-base/.cache/huggingface/download/config.json.metadata first line
  equals the requested revision

Any mismatch falls through to rm -rf + re-download. Closes the
high-severity adversarial-review finding that REUSE_HF_BASE could
silently train on a tampered or wrong-model cache.



**`4a6f3ae7b9546d3386876c0a9b6d072a2c374a7b`** — feat(train): prefix-match + name-first scorer for eval-tool-calls

Strict success unchanged (full match on count, names, and canonical
args). Adds:
- prefix_success: predicted is an ordered prefix of gold — accepts
  sequential tool emission (call → tool result → next call) as
  partial credit instead of full failure.
- name_first_match: first predicted tool name equals first gold name —
  separates "right tool wrong args" from "wrong tool entirely".

Re-runs of K.4 on adversarial-v0 (n=25, Qwen3-4B-Instruct-2507):
  strict 24% (was 24%) | prefix 36% | name-first 84-88%.



**`43b7e94ca761fffe788447375733efdcc3042c57`** — corpus(tool-call): adversarial-v0 batch 2 — 25 more rows (50 total)




**`0f3406e0a91f8a6cd9d2fa4e6c0725ea9f05bc39`** — docs(notes): K.4 — Qwen3-4B adapter does not lift on adversarial-v0

Parse success 24% for both base and adapter on the 25-row adversarial
seed set. Name-match rate is 88-96% — the model picks the right tool
nearly always. Most "failures" are (a) multi-tool rows where the scorer
expects parallel emission but Qwen3 emits sequentially, and (b)
schema-edge argument mismatches the K.1 adapter wasn't trained on.

Bundles a tool_choice default in eval-tool-calls.sh so corpora without
the field (like adversarial-v0) work without modification.



**`e84bda35843e84fd800c9ded07680ba2014e0a97`** — docs(notes): memory-efficacy M.7+M.8 — retrained adapter is byte-identical

Retrained Qwen3-8B 4-way LoRA on the expanded corpus (451 train vs
prior 416). Per-class F1 on both canonical n=60 and balanced n=24 is
byte-identical to the prior adapter. macro-F1 -0.0185 vs base on both
sets — same as M.4/M.6. At rank=16/num_layers=16/iters=300, the adapter
has converged to a fixed behavior unaffected by +35 minority rows.




### Diff against main

```

```

### Dispatch summaries this session


- `9eaea571-99af-4554-96fb-4f999a8cad8f` → **task-refiner-escalation** [ok, 21s] — failures: ["agent.tool_call.failed"]

- `89283dd5-3c57-4018-9395-c609d4a98962` → **oc-kimi-k2.6** [ok]

- `e8fbb4a4-beec-4abc-ae96-c48ef6c9547e` → **task-refiner-primary** [ok]

- `6df2d6b8-c727-4d63-96de-19219af23c7d` → **home-mgmt** [in_progress] — failures: ["agent.tool_call.failed"]

- `482dff2d-32db-41bc-9f3f-42855f7400f9` → **home-mgmt** [ok]

- `4cc85916-56d8-403c-acf1-ddac8408b9e8` → **task-refiner-primary** [ok, 97s] — failures: ["agent.tool_call.failed"]

- `30360cb2-5588-4a59-ae5a-87dc6eb9662c` → **home-mgmt** [in_progress]

- `7f22d563-15e1-49bc-b453-94d05033b61d` → **task-refiner-escalation** [ok, 20s] — failures: ["agent.tool_call.failed"]

- `501202f4-6d7a-420d-8124-26d711c350b4` → **task-refiner-primary** [in_progress]


### Pending handoffs



## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
