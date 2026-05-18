# M-track corpus bootstrap problem — 2026-05-16

## TL;DR

The M-track classifier's production verification is blocked not by a code bug
but by an empty data well. Penumbra has fully scaffolded the memory-verification
audit trail (table, writer, MCP tool, daemon route) — and zero rows have ever
been written, because no production workflow naturally calls `memory_verify`.
The path forward is to auto-fire verification at lane-close so the corpus
populates passively. Spec landed at
`penumbra/docs/specs/2026-05-16-memory-verify-auto-fire.md`.

## What the discovery pass found

Trying to validate the few-shot prompt's `+20.6 pp macro-F1` lift on production
data required either (a) labeled minority-class findings to compare against
model predictions, or (b) a labeling source we could reuse. The discovery pass
through penumbra's data layer turned up:

| Source | State | Why empty |
|---|---|---|
| `t2_memory_verification_events` | **0 rows** | Writer at `core/src/writers/t2.ts:21` is wired, route at `daemon/src/routes/memory.ts:79` is wired, MCP tool is registered — but the human path is the only producer, and humans don't naturally invoke it in normal workflows |
| `t2_memories.obs_type` | NULL for all 237 rows | Schema field exists; no writer populates it. Same shape of "scaffolded but unused" |
| `t2_memories.body` text matches on `recall_miss`/`memory_ignored`/`missed_registration` | 0/0/0 hits | The 4-class vocabulary lives in the classifier prompt, not in user-written content |
| Title prefix labels (`Trap:`, `Pitfall:`, etc.) | 6 of 237 | Small implicit-label population from operator naming convention; not 4-class-aligned |
| `dispatch_events` with memory-recall traces | Populated | Real signal exists, just unjoined |
| `lane_ledger` verdicts | Populated | Real outcome signal exists, just unjoined |

The pattern is consistent: **all the infrastructure required for a labeled
corpus is built and wired except for the moment-of-truth producer**. Whichever
angle of telemetry you pick — verification events, obs_type, body tags — the
gap is the same: nothing in the operator's natural workflow triggers a label.

## Why this is structural, not accidental

`memory_verify` is a separate mental step from "use a memory in a dispatch."
Operators dispatch, the dispatch ingests recalled memories, the dispatch
succeeds or fails — and then the operator moves on. Asking the operator to
*also* go open an MCP tool and tag each memory with its verdict is friction
they will not absorb voluntarily, no matter how well-designed the MCP shape is.

The fix is not better UX on the manual path. The fix is to make verification
happen by side-effect of operations the operator is already doing.

## The recommended fix

When a lane closes (i.e. when a dispatch reaches a terminal state via
`dispatch_land`, `lane_close`, or the orphan-lanes sweeper), iterate over
every memory that was injected into the dispatch's prompt and write a
verification event per memory with:

- `verifier_actor = 'auto-lane-close'`
- `claimed_by = <lane primary actor>` (e.g. `codex-acp-fast`)
- `reason = 'lane closed accepted: <verdict>'` or `'lane closed rejected: <verdict>'`
- `session_id = <handoff_id>`

This produces ~N labeled rows per closed lane, where N is the number of
memories recalled into that dispatch's prompt. In active operation that's
dozens of rows per day, accumulating without operator effort.

The spec at `penumbra/docs/specs/2026-05-16-memory-verify-auto-fire.md`
sketches the implementation: ~one new function call inside the lane-close
handler, ~one idempotency check, ~one log line for observability. Risk is
low because the writer is already battle-tested via existing unit tests; we
are just calling it from a new site.

## Why `recall_miss` needs a separate spec

The auto-verify path naturally labels `memory_ignored`-shaped events
(memory was injected, dispatch failed → likely ignored) and the negative class
(memory was injected, dispatch succeeded). It does NOT label `recall_miss`
because that requires the inverse join: t2 state at the time of dispatch ×
similarity threshold for "this memory would have been relevant" × evidence
the recall didn't surface it.

That's a real signal but it's a different extractor. Deferred as a follow-on
work item explicitly called out in the spec's "Follow-on" section.

## What the next M-track session can do

In rough priority order:

1. **Land the auto-verify wiring** per the spec. Once flowing, give it 5-7
   days of operation to accumulate ~100+ labeled events.
2. **Build the `memory_efficacy_corpus_build` consumer** for verification
   events. Joins to `dispatch_events` for the original finding text.
3. **Re-eval the few-shot prompt** on the new corpus. Compare macro-F1
   against the offline n=60 baseline. If lift transfers, the M-track
   decision contract's validation slice part C is verified in production.
   If not, the contract triggers retire criteria.
4. **Open the `recall_miss` extractor spec** as a separate effort.

## Caveats worth knowing

- **Label noise from auto-derivation.** `reason = 'lane closed accepted'` is
  not the same level of confidence as a human operator saying "this memory
  was useful." The corpus this builds is closer to weak supervision than
  gold-labeled. For classifier eval that's fine; for classifier training
  it might need a higher bar.
- **Survivorship bias.** Lanes that orphan / never close don't contribute
  labels. The orphan-lanes sweeper handles these eventually, but they may
  cluster around exactly the failure modes most worth capturing.
- **Project-scope correctness.** Lanes in different projects will write
  verification events scoped to their own memory pool. The corpus build
  needs to respect project_id when materializing training/eval splits, or
  cross-project signal can leak.

## Session-end snapshot

- Local state: `qwen3-8b-local` workload running at `:8085`,
  `PENUMBRA_JUDGE_BASE_URL=http://127.0.0.1:8085` and
  `PENUMBRA_REVIEWS_DIR=/Volumes/WorkSSD/repos/personal/penumbra/.penumbra/reviews`
  set via `launchctl setenv`. Daemon healthy. 802 classification rows in
  `memory_efficacy_cache`.
- Symlink at `~/.penumbra/reviews` is removed (env var supersedes).
- Open follow-up: persist the two env vars in the daemon plist for
  reboot durability. Deferred as a separate operator decision.

## Related

- `penumbra/docs/specs/2026-05-16-memory-verify-auto-fire.md` — the spec
- `llamactl/docs/notes/m-track-fewshot-production-verify-2026-05-16.md` — the
  validation diagnosis that surfaced this gap
- `llamactl/docs/specs/m-track-decision-contract-2026-05-16.md` — the
  decision contract this would unblock
- Memory: `project_m_track_production_corpus_shape_2026-05-16`
