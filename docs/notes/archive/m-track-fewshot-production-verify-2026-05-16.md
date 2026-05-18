# M-track few-shot — production verification, 2026-05-16

## TL;DR

The structural rebuild pipeline is fully restored end-to-end. The few-shot prompt
landed at `penumbra@2a57160` cannot be quantitatively verified on the current
production corpus because the corpus shape is wrong — it is adversarial code-review
findings, not memory-failure findings. Verification is deferred until either an
operational-review corpus exists or the offline eval is re-run as the labeled
M-track corpus grows.

## What was tried

1. **Restored the rebuild route**: `penumbra@aa863e6` decoupled the classifier
   from sirius naming and switched the daemon defaults to a local OpenAI-compatible
   judge endpoint. `penumbra@cdbe013` followed up with `resolveJudgeConfig()` +
   observability logs after adversarial review.
2. **Stood up a dedicated local Qwen3-8B judge** at `127.0.0.1:8085`
   (`templates/workloads/qwen3-8b-local.yaml` = llamactl@695e786) to match the
   eval-stack model. Shared mac-mini :8090 was the wrong choice (-np 2 with
   home-mgmt → 120/120 batch timeouts on the first rebuild attempt).
3. **Plumbed reviews dir via env**: penumbra@62c6e28 (landed earlier in the day)
   added `PENUMBRA_REVIEWS_DIR` precedence to `services.reviewsDir`. Set via
   `launchctl setenv PENUMBRA_REVIEWS_DIR /Volumes/WorkSSD/repos/personal/penumbra/.penumbra/reviews`.
4. **Triggered a full rebuild** against the project reviews dir
   (`/Volumes/WorkSSD/repos/personal/penumbra/.penumbra/reviews`, 81 review dirs,
   751 findings). Local Qwen3-8B classified 751/751 in 18 minutes, 0 batch failures.
5. **Hand-reviewed all 51 minority-class predictions** (41 missed_registration +
   6 memory_ignored + 4 recall_miss). Conclusion: **all 51 are false positives.**

## Production class distribution

| Class | Count | % |
|---|---|---|
| not_memory_related | 751 | 93.6% |
| missed_registration | 41 | 5.1% |
| memory_ignored | 6 | 0.7% |
| recall_miss | 4 | 0.5% |

Sample size: 802 total (751 from local Qwen3-8B run + 51 from earlier partial
mac-mini run, deduped by `finding_id`).

## Why the corpus is the wrong shape

The 4-class taxonomy from `memory-efficacy-classifier.ts:40-46` defines:

- **missed_registration**: a memory would have prevented this if written, but
  was never written.
- **recall_miss**: a relevant memory existed but was not recalled at dispatch.
- **memory_ignored**: a memory was recalled into the prompt but ignored by the
  implementer.
- **not_memory_related**: not about memory efficacy.

The production reviews dir at `<penumbra>/.penumbra/reviews/` is populated by
the `adversarial-review` workflow — 8 reviewer personas plus a synthesizer per
commit/diff. The findings these personas produce are about **code design**:

- API/contract drift, DRY violations, type-safety gaps
- Bugs in the recall *implementation* (data shape, provenance, scoping)
- Naming conflicts, hardcoded values, format choices
- Performance, security, maintainability concerns

None of these describe a runtime memory failure. The classifier — trying to be
useful — keyword-matches on `memory`, `recall`, `registry`, `registration` and
fits findings into the minority taxonomy. But the underlying scenarios are not
memory-efficacy failures.

Example FPs (from the 41 missed_registration):
- "Foreign-key cascade invariant likely not enforced at runtime" — DB schema
- "Route re-authenticates with PENUMBRA_TOKEN env" — auth design
- "Same-name MCP server reuse ignores spec drift" — MCP design
- "Hardcoded project_id: 'penumbra' in long-lived tick dispatch" — code config

Example FPs (from the 6 memory_ignored):
- "Auto-recall can run without project scoping" — recall MECHANISM bug, not a
  per-incident ignored memory
- "Workflow/domain layer now coupled to MCP wire naming" — pure architecture

## Edge cases that were close calls (defer to operator)

- **#4** "Hardcoded npm test commands conflict with detect project test stack
  guidance" — could be I if "detect project test stack" was an in-prompt memory
  at dispatch time. Without dispatch-context audit, called N.
- **#5 / #27** "format traps stored as memory-key guidance rather than canonical
  in-file rules" — meta-finding about *where* memory should live. Reasonable N
  (guidance-architecture critique, not a per-incident failure).
- **#15** "User-facing playbook recall keys changed without compatibility path"
  — could be M if the playbook recall mechanism IS memory recall. Called N
  because it's an API-breakage finding, not a recall-miss.

Even granting these as TPs, precision on minority predictions is < 6% (3/51 at
best). The original eval result of `+20.6pp macro-F1` is not refuted by this,
but it is not validated either — different distribution.

## What this implies for the M-track decision contract

The contract at `docs/specs/m-track-decision-contract-2026-05-16.md` validation
slice part C (few-shot prompting) was satisfied **on the offline eval**, but the
production verification step is now blocked on data shape:

1. The classifier IS deployed in production (penumbra runs it on every rebuild).
2. The rebuild route IS structurally functional after today's fixes.
3. The classification pipeline IS producing sane majority-class results.
4. The minority-class lift IS NOT measurable on adversarial-review findings.

To actually verify the lift, one of these has to happen:

- **(a)** A second corpus source: operational reviews of agent runs, post-incident
  reviews where memory recall genuinely failed. This is what the original eval
  used (gold-labeled by codex-acp-spark per `project_memory_efficacy_corpus_llm_labeled`).
- **(b)** Periodic re-run of the offline eval as the M-track corpus grows past
  n=60. Same shape, just more data.
- **(c)** Reframe what `.penumbra/reviews/` is *for*: today it stores adversarial
  code reviews; the memory-efficacy classifier was originally designed for a
  different review type. Either (c1) point the classifier at a different source,
  or (c2) accept that on this corpus, `not_memory_related` is the only honest
  class and ship a stricter prompt that refuses minority-class predictions
  without explicit dispatch context.

Option (c2) is interesting — if implemented, the 51 FPs would become 0 and the
classifier would communicate honest uncertainty. Worth a future M-track session.

## Live-state housekeeping (end of session)

- `launchctl setenv PENUMBRA_JUDGE_BASE_URL http://127.0.0.1:8085` — active.
  Daemon points at local Qwen3-8B.
- `launchctl setenv PENUMBRA_REVIEWS_DIR /Volumes/WorkSSD/repos/personal/penumbra/.penumbra/reviews`
  — active.
- Symlink at `~/.penumbra/reviews` is **removed** (env var supersedes it).
- `qwen3-8b-local` workload running (PID 83291 at session-end), restartPolicy: Always.
- `~/.penumbra/db.sqlite` has 802 classification rows in `memory_efficacy_cache`.

These env vars are `launchctl setenv` only — they will not survive a system
reboot. To make them durable, add them to the daemon plist's
`EnvironmentVariables` block at `~/Library/LaunchAgents/dev.penumbra.daemon.plist`.
Deferred as a separate operator decision.

## Related

- penumbra@aa863e6 — sirius decouple
- penumbra@cdbe013 — judge-chat surface tightening (adversarial follow-up)
- llamactl@695e786 — qwen3-8b-local workload
- llamactl@40b90cb — original few-shot prompt offline eval (+20.6 pp macro-F1)
- llamactl `docs/specs/m-track-decision-contract-2026-05-16.md`
- Memory: `project_memory_efficacy_sirius_decouple_2026-05-16`,
  `project_fewshot_beats_lora_2026-05-16`, `project_memory_efficacy_corpus_llm_labeled`
