# Penumbra asks — for matrix-bench corpus quality & quantity

**Source:** llamactl matrix-eval, 2026-05-18 PM session.
**Context:** Today I shipped a tool-call-grammar corpus (n=50) and a
memory-recall mined half (n=55), both from penumbra audit-trail data.
The mining is workable, but several signals are either missing or only
implicit; closing those gaps would directly raise the trust we place in
bench numbers.

These are ranked by impact on bench accuracy, not by implementation
effort.

---

## 1. Populate `t2_memory_verification_events` (or land verify-auto-fire)

**Pain:** the table exists with the right schema (`verifier_actor`,
`claimed_by`, `reason`, `session_id`, `basis`, `basis_type`,
`basis_detail`, `authorized_by_handoff`) but has **0 rows** today.

That kills the cleanest gold-labeling recipe for memory-recall: "the
memory the agent verified in the same session is the right answer." We
ended up falling back to BM25 top-1 self-supervision, which is honest
weak gold but means a model that out-ranks BM25 is scored *down* even
when it's right.

**Ask:** finish the spec at
`penumbra/docs/specs/2026-05-16-memory-verify-auto-fire.md` so the
audit trail accumulates passively on lane-close. Even a sparse stream
(say 5% of dispatches) gives us real gold to anchor against.

**Bench lift if delivered:** the synth half stops being a bias study
of the LLM labeler and becomes a real human-(or-agent-)decision-derived
test set. Easily +0.05–0.10 in trustworthy NDCG@5 spread.

---

## 2. Couple `agent-tool-use` to its result and to the agent's next decision

**Pain:** `t0_events` has `agent-tool-use` rows with `tool` + `input`,
but:

- the **tool result** appears to live in a separate (later) row with no
  explicit foreign key — pairing is "same handoff, next event in time."
- the **agent's next message or tool call** (which would tell us what
  the agent did with the result) is also unlinked.

For memory-recall, this means I can see "agent ran `memory_search('foo
bar')`" but I can't programmatically infer "and then cited memory_id
abc-123 in the next assistant turn." That citation is the strongest
implicit gold signal we have short of explicit verification.

**Ask:** add a stable `tool_call_id` (or reuse `request_id`) on the
`agent-tool-use` event and on the matching result event, so a miner can
join `call → result → next-assistant-turn` in one query.

**Bench lift:** unlocks a stronger gold signal for memory-recall
(BM25-top-N intersected with "what the agent cited") without needing
verify-events to be populated.

---

## 3. Snapshot of `tools` schema + message context on each `agent-tool-use`

**Pain:** the tool-call-grammar matrix workload needs three things to
score a row: the user `messages` leading up to the call, the `tools`
array advertised at that moment, and the gold `tool_calls` array. Today
the `agent-tool-use` event has only `tool` + `input` — neither the
advertised tool schema nor the conversation context.

For now I built the corpus from K-track curated rows. That works but it
means the corpus tracks **what a human wrote in a fixture**, not what
real agents actually face.

**Ask:** on each `agent-tool-use` event payload, include (or reference
by id):

- `tools_advertised`: the full JSON-schema array offered to the model
  at this turn.
- `messages_context_hash`: a content-hash of the conversation prefix,
  with a separate `messages_snapshots` table or blob storage so a miner
  can fetch the actual prefix on demand.

This is the same shape OpenAI eval frameworks consume. Doing it via
content-hash avoids re-storing the prefix on every call.

**Bench lift:** the tool-call corpus stops being hand-fixtured and
becomes production-trace data — directly addresses re-entry criterion
#1 of the K-track FROZEN.md.

---

## 4. Expose `search()`'s query rewriter as a stable function

**Pain:** I went to use the FTS5 BM25 directly against `t2_fts` to
match what the agent saw at search time. The agent saw something
slightly different because `search()` (in
`penumbra/packages/core/src/readers/search.ts`) does query rewriting —
likely token normalization, OR-fan-out, possibly synonym expansion —
that I'd have to reverse-engineer.

I hit this concretely: `t2_fts` tokenizes `chain_start` into
`chain`+`start` (default unicode61), so the agent's exact query string
doesn't match the indexed content. I worked around it with manual
token extraction and OR-search, but my BM25 ranking is now meaningfully
different from `search()`'s.

**Ask:** either (a) export the rewriter as `rewriteQueryForFTS5(query)
→ string`, callable as a pure function, or (b) expose
`memory_search_explain(query) → {fts_query, candidates, scores}` over
MCP so miners can get the exact ranking the agent received.

**Bench lift:** removes a systematic source of corpus-vs-runtime
divergence in memory-recall scoring.

---

## 5. `memory_sample(stratify_by, limit, seed)` MCP endpoint

**Pain:** for the synthetic-half corpus build, I need ~50 t2 memory
bodies balanced across `obs_type` and `project_id`. `memory_search`
takes a query and returns hits; there's no "give me a stratified
random sample" surface.

I can do this via direct SQL today, but that's the kind of thing the
convention says to avoid ("never query the live sqlite DB directly
except for forensics").

**Ask:** add `memory_sample(stratify_by?, project_id?, obs_type?,
limit, seed)` returning `[{memory_id, title, body, obs_type,
project_id}, ...]`. Deterministic for a fixed seed.

**Bench lift:** unblocks the synth half of memory-recall in-session.
Also useful for any future corpus-building task that wants a fair
cross-section of t2.

---

## 6. Per-row "the agent had to retry" signal

**Pain:** today every mined memory_search query is treated as equally
worth scoring. But some of those queries are "the agent's first
attempt that didn't find what it needed and was re-issued with refined
terms a few seconds later." That's a hard query; the easy queries
landed on the first try.

**Ask:** when the same session emits two `memory_search` calls within
N seconds with substring-overlapping query strings, emit a synthetic
event marker (or annotate the second call's payload) with
`refinement_of: <first_call_id>`.

Even simpler: just timestamp + session_id + query are enough; a miner
can do the dedup downstream if the linkage is queryable.

**Bench lift:** lets the corpus stratify by difficulty. A model scoring
0.95 on "easy" but 0.40 on "had-to-retry" is much more informative than
the same model scoring 0.78 aggregate.

---

## 7. Freeze memory_id stability after a memory enters a corpus

**Pain:** today's mining captures `memory_id` + body text into our
corpus rows. If penumbra later compresses two memories into one,
deletes one, or rewrites a body, the corpus row goes stale silently —
my bench scores something that no longer exists.

**Ask:** add an immutable archival mode. Either (a) `memory_id` is
truly stable forever once issued (compression creates a new id and
leaves the old one as tombstone with `superseded_by`), or (b) a
`memory_freeze(memory_id, reason)` endpoint that marks rows
deletion-/edit-prohibited.

**Bench lift:** reproducibility. The same `mined.jsonl` from June will
score the same way in October.

---

## 8. Lightweight feedback channel for memory recalls

**Pain:** even without verify-auto-fire, any feedback signal would
help. Right now the agent calls `memory_search`, reads the results,
and writes its next message — but there's no recorded "useful: true /
false" or "I'm going to ignore this hit" anywhere.

**Ask:** add an optional `memory_recall_feedback(call_id, useful_ids:
string[], ignored_ids: string[])` MCP tool that agents can call
post-hoc (or that gets emitted from a wrapper around their next
turn). Adoption can be slow; the value compounds as data accumulates.

**Bench lift:** turns memory-recall from "BM25 says these are
relevant" into "agents say these were relevant" over time — the same
delta that makes recsys eval datasets useful instead of synthetic.

---

## 9. `memory_search_batch(queries: string[])`

**Pain:** mining at scale runs `memory_search` once per query. For 50
rows that's 50 sequential round trips through MCP; for 500 it gets
slow. Today's mining used direct sqlite to avoid this, which is fine
forensically but means the miner doesn't share `search()`'s rewriter
(see ask #4).

**Ask:** batched form, same return shape, executed server-side.

**Bench lift:** corpus-build speed; doesn't change accuracy but makes
larger corpora (n=300, n=1000) cheap to refresh.

---

## 10. Project-tag mined queries

**Pain:** the same query string ("how do we route chain_start") might
have very different gold in the llamactl project vs penumbra. Today's
`agent-tool-use` events carry `project_id` (verified — column exists
on `t0_events`) but our miners don't carry it forward into the corpus
row's `context`.

This is mostly a miner-side fix on our end — but it would be cleaner
if penumbra surfaced "what project was the agent scoped to when this
call ran" as a first-class field on the result of `memory_search`
itself, not just on the surrounding event.

**Ask:** include `agent_project_id` in `memory_search` result
metadata, so miners can stratify corpora by project without joining to
t0.

**Bench lift:** project-scoped sub-corpora become easy, which lets us
measure per-project model fitness instead of just aggregate.

---

## Closing note

Asks #1, #2, and #3 are the high-leverage ones — they each unlock a
qualitatively different gold signal. Asks #4–#10 are quality-of-life
that pay off in larger corpora and reproducibility.

I'm happy to spec or pilot any of these from the llamactl side if it
helps the penumbra team prioritize.
