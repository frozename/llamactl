# Judge seats: cloud-primary vs local-primary — evaluation (2026-09-06)

Scope: should penumbra's three judge seats — `gemma-e4b-judge-local` (:8091),
`granite41-3b-judge-local` (:8085), `qwen35-4b-judge-local` (:8092), 4 GiB
each on node `local` — move to a cloud provider, and in which direction
should fallback run? Read-only evaluation; nothing was changed live. A
parallel evaluation covers the `mac-mini` move; this report scores the cloud
option and says where it beats or loses to a local-node move.

## Verdict

**Stay local-primary. Do not relocate the quorum seats to cloud at all, and
do not pay for a cloud judge today.** The question's premise — three loaded
judge seats worth moving — is wrong on the evidence: only **one** of the
three ModelRuns carries live traffic. The other two exist solely as members
of a dreaming-judge quorum that has cast **zero votes since 2026-07-06**
because P1 claim-head livelock parks every candidate behind a `queued`
action (details in §3). Moving an idle quorum to cloud buys latency, egress,
and a silent-veto failure mode in exchange for nothing.

If the goal is strictly "free RAM on `local`": the cheapest correct move is
**not** cloud — it is stopping or re-homing the two quorum-only ModelRuns
(`gemma-e4b-judge-local`, `qwen35-4b-judge-local`, 8 GiB) once the P1
livelock is fixed or the quorum is deliberately reconstituted elsewhere. The
workhorse seat (`granite41-3b-judge-local`, ~500 transcript-extraction
calls/day) can gain a cloud **fallback** for free — the machinery already
exists — at roughly **$13–35/mo** on DeepSeek V4-Flash metered pricing if it
ever actually carried the full load.

**Single most influential fact:** `dream_actions` shows the last
`promote_t1` quorum vote ran in a dream cycle started 2026-07-06
21:28 UTC — two months of 45–68 dream cycles/day have produced zero judge
calls, while `t1_rollups.t2_promoted_at` is still being stamped on
~336–689 rollups/day by the separate t2-promotion worker on the granite seat
alone.

### Cost arithmetic (headline)

| Path                              | Calls/day | Tokens/call (in/out)       | Monthly tokens   | DeepSeek V4-Flash cost            |
| --------------------------------- | --------- | -------------------------- | ---------------- | --------------------------------- |
| t2-promotion (memory-refiner)     | ~500      | ~5–6k in / ≤0.5k out       | ~75M in / ~8M out | **~$13–19/mo** ($0.14/$0.28 base) |
|                                   |           |                            |                  | ~$20–30/mo at Aug-2026 off-peak/peak rates |
| dream.query_rewrite (rewriter)    | ~10–27    | small                      | <1M              | <$1/mo                            |
| dreaming-judge quorum (3 seats)   | **0**     | —                          | 0                | $0                                |
| memory.efficacy_judge             | 0 (since 2026-05-17) | —               | 0                | $0                                |

Per-call on V4-Flash: ~$0.0008–0.0014. On any **subscription** provider the
marginal dollar cost is $0 but the quota cost is real and currently
prohibitive (§4).

CONFIDENCE KEY: **[CONFIRMED]** = backed by command output or source:line
cited inline. **[INFERRED]** = reasoned estimate; the missing measurement is
named. Prices are public-page figures, not observed invoices.

---

## 1. Which cloud gateways are actually configured and reachable

llamactl registers 7 cloud gateways in `~/DevStorage/config` (kind
`gateway`/`cloud`): `embersynth-gw` (http://localhost:7777),
`anthropic-direct`, `gemini-direct`, `openai-direct`, `sirius-gw`
(http://localhost:3000), `nvidia-nim`, `groq`. Agent nodes `local`,
`mac-mini`; rag nodes `kb-chroma`, `kb-pg`.
**[CONFIRMED — `bun packages/cli/src/bin.ts node ls`, config file read
2026-09-06.]**

Unauthenticated reachability probes 2026-09-06 ~23:35 UTC (a 401 proves the
endpoint is up and TLS works; `FAIL 7` = connection refused):

| Endpoint                                            | Result                |
| --------------------------------------------------- | --------------------- |
| api.sakana.ai                                       | 401, 0.37s            |
| api.deepseek.com                                    | 401, 0.74s            |
| token-plan...aliyuncs.com (alibaba)                 | 401, 2.36s            |
| api.anthropic.com                                   | 401, 0.24s            |
| generativelanguage.googleapis.com `/v1beta/openai/models` | 404, 0.28s (path shape; host reachable) |
| api.openai.com                                      | 401, 0.42s            |
| integrate.api.nvidia.com                            | **200** — public model catalog, no auth needed to list |
| api.groq.com                                        | 401, 0.48s            |
| embersynth-gw :7777, sirius-gw :3000                | **connection refused — both down** |

**[CONFIRMED — curl probes.]** Keychain presence for `llamactl/<provider>`
could not be verified (sandboxed keychain; `find-generic-password` returns
item-not-found for every probed service/account pair — treat as unverified,
not absent). **[UNVERIFIED]**

But llamactl gateway registration is not what matters: penumbra judge calls
are plain `POST <baseUrl>/chat/completions` fetches from the daemon, so the
real candidate set is penumbra's `openai-compat-http` seats with remote
baseUrls. From `~/.config/penumbra/agents.yaml` those are exactly:

- **deepseek** (`api.deepseek.com`, `pricing_mode: api`, keychain
  `llamactl/deepseek`): `deepseek-v4-flash-http` (roles: reviewer),
  `deepseek-deepseek-v4-pro-http`, `deepseek-deepseek-v4-flash-vision-exp-http`.
  `deepseek-v4-flash-http` is **live and working**: 226
  `completed_with_output` agent_performance rows in the last 14 days, latest
  2026-09-06T12:06Z. **[CONFIRMED — DB query.]**
- **sakana** (`api.sakana.ai`, subscription): 4 http seats — all dead; the
  subscription expired 2026-08-24 and every call 429s (routing_bias row,
  operator-stated). **[CONFIRMED — routing_bias.]**
- **alibaba token-plan** (Singapore endpoint, subscription): 2 http seats —
  currently inside a 48h provider `exclude` for gateway-wide 429 exhaustion
  re-confirmed **today** 2026-09-06; the plan itself lapses 2026-09-26 with
  auto-renewal off (quotas.yaml comment). **[CONFIRMED — routing_bias +
  quotas.yaml.]**
- **anthropic / openai / google**: no `openai-compat-http` seats exist for
  these providers — only ACP/CLI harness seats (`anthropic-claude-cli`,
  `openai-codex-*-acp`, `agy-*`, `google-gemini-*-cli`), which **cannot**
  serve judge pools: `callJudge`/`invokeJudge` POST
  `/v1/chat/completions`; process-backed adapters get tier-2 candidate
  ordering and no usable `baseUrl`.
  **[CONFIRMED — `resolveRoleLlmCandidates`,
  `packages/core/src/services/llm-candidates.ts:105-140`;
  `dreaming-judge-pool.ts:88-96`; seat list scan.]**
- **nvidia-nim** (`integrate.api.nvidia.com`): catalog lists judge-plausible
  small models — `deepseek-ai/deepseek-v4-flash-0731`, `google/gemma-3-4b-it`,
  `ibm/granite-3.0-3b-a800m-instruct`, `meta/llama-guard-4-12b` among 81
  entries — on a free preview. Key ref `keychain:llamactl/nvidia` is in the
  llamactl config but usability is unverified (no penumbra seat points at
  it). **[CONFIRMED catalog; INFERRED usability — would need a smoke call.]**
- **groq**: reachable, key ref exists in llamactl config, no penumbra seat.
  **[INFERRED usable — needs key + seat.]**

Judge-suitable (small/fast/cheap/scoring-capable): realistically only
`deepseek-v4-flash` today — proven working seat, metered (no quota
contention), cheapest frontier-class API, and DeepSeek does automatic
prefix caching so the ~1.3k-token fixed judge preamble rides cache-hit
rates. NVIDIA NIM's free catalog is the zero-dollar option but unverified.

## 2. What the judges actually do

The three ModelRuns are not interchangeable "judges"; they map to distinct
penumbra roles:

| ModelRun (port)                     | Penumbra seat                | Roles held                                                                 | Real caller |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------- | ----------- |
| `gemma-e4b-judge-local` :8091       | `local-gemma-e4b-judge-http` | `dreaming-judge` only                                                      | dreaming P1 quorum |
| `qwen35-4b-judge-local` :8092       | `local-qwen35-4b-judge-http` | `dreaming-judge` only                                                      | dreaming P1 quorum |
| `granite41-3b-judge-local` :8085    | `local-granite-3b-q8-http`   | `memory-refiner`, `dreaming-judge`, `dreaming-rewriter`, `refiner`, `brief-synthesizer` | t2-promotion worker, dispatch.refiner, query rewriter, memory-efficacy, quorum |

(Seat→workload binding is by proxy `model` id; `granite-4.1-3b-GGUF/...`
resolves to the local :8085 ModelRun, not the mac-mini twin — the route map
sorts ModelRuns before ModelHosts and `granite41-3b-judge-local` before
`granite41-3b-judge-mac-mini` alphabetically.
**[CONFIRMED — `packages/core/src/openaiProxy.ts:135-148, 381-404`; both
workloads show Running in `get workloads`.]**)

The consumers:

1. **`dreaming-judge` quorum** — `createDreamingJudgePoolFromAgentchat`
   builds one entry per role holder; `judgeAll` calls **all** holders in
   parallel per candidate; `autoPromote = total ≥ 2 && yesCount ≥
   ceil(total·2/3)` — with 3 holders, quorum = 2 of 3.
   **[CONFIRMED — `dreaming-judge-pool.ts:143-160, 186-201`;
   `cycle.ts:610-634`.]** This is a **quorum of binary pass/fail votes**
   (`promote: true/false` + confidence + rationale, `temperature: 0`,
   `max_tokens: 256`, `response_format: json_object`), not a rubric scorer.
   A transport/HTTP failure is converted to `{promote:false, confidence:0,
   rationale:"judge_error"}` — i.e. **a dead judge casts a NO vote, it does
   not abstain**.
   **[CONFIRMED — `dreaming-judge-pool.ts:152-155`.]**
   Quality bar measured on the seats: gemma-e4b and qwen35-4b scored 4/4 on
   the production 4-case judge set; granite-3b scored 2/4 on the same set
   and once returned a wrong verdict on the real prompt shape (agents.yaml
   seat notes, 2026-08-18/19). **[CONFIRMED — agents.yaml descriptions.]**
   All three are quorum members — replacing one member changes 1 of 3
   votes; quorum math means two bad members permanently veto auto-promote.

2. **t2-promotion worker** (`memory-refiner` role) — cron tick every
   `max(t1RollupIntervalSec, 300)`s; for each eligible rollup it renders the
   session's `agent-prompt`/`agent-response` events, truncates to
   **20,000 chars** (first 8k + last 8k), and calls the chunked judge —
   but since the transcript is pre-truncated below the 80k-char chunk
   threshold, this is effectively **one ~5–6k-token call per rollup**
   extracting `{"memories":[...]}` JSON.
   **[CONFIRMED — `serve.ts:1314-1316`; `core/src/writers/t2.ts:378-395,
   498-501`; `workers/t2-promotion.ts:471-530`.]**
   Sole `memory-refiner` holder: `local-granite-3b-q8-http`.
   **[CONFIRMED — agents.yaml roles scan.]**

3. **dream.query_rewrite** (`dreaming-rewriter` role) — per-t2-memory
   recall-query generation; holders: granite seat + `macmini-granite-3b-proxy-http`
   (+ sakana seat, dead). ~10–27 verdicts/day in `dream_query_rewrites`.
   **[CONFIRMED — `deps.ts:54`, DB count.]**

4. **dispatch.refiner** (`refiner` role) — `chain_start_refined` prompt
   refinement via `createJudgeChat` with ordered fallback candidates +
   routing-bias excludes; records outcomes to `subsystem_health` as
   `dispatch.refiner`. **[CONFIRMED — `serve.ts:1201-1237`.]**
   `subsystem_health` contains only a `dream.query_rewrite` row, so this
   path has recorded no recent outcomes. **[CONFIRMED — table dump.]**

5. **memory-efficacy judge** (`memory-refiner` role) — NDCG eval jobs;
   8 jobs total ever, last 2026-05-17. Dormant.
   **[CONFIRMED — `memory_efficacy_jobs` table.]**

Correction to the dispatch premise: **judges do not run on every review.**
Review (`review_adversarial` personas, lane gates) is carried by entirely
different seats — the cloud ACP/HTTP fleet. The judge seats gate **memory
promotion and extraction**, on a background cadence.

## 3. Call volume and cost — measured

**Dreaming-judge quorum: 0 calls/day for two months.** Last `promote_t1`
action: dream cycle started 2026-07-06 21:28 UTC (7,253 actions lifetime:
May 5,485 → Jun 1,389 → Jul 379 → none since). Meanwhile `dream_cycles`
runs P0–P8 45–68×/day and there are ~8,516 unpromoted, unfiltered,
unclaimed rollups with ≥40-char bodies sitting eligible.

Mechanism (**[CONFIRMED — `cycle.ts:346, 612-632, 683-726`;
`core/src/db/schema.ts:1875-1907`]**): P1 claims the **10 oldest**
unclaimed rollups (`ORDER BY started_at ASC LIMIT p1BatchSize=10`), then
skips any with an existing `queued` promote_t1 action. The 10 oldest are
2026-04-30 rollups that all have `queued` rows parked from before
`promotion_filtered_at` existed — so they are claimed, skipped, released
(stale-claim release, 1h TTL / terminal cycle), and re-claimed next cycle.
Head-of-line livelock: the same 10 are claimed every cycle forever and no
new rollup is ever judged. All 10 currently-claimed rollups verified to
have `queued` actions. **[CONFIRMED — sqlite joins, `claimed_at` timestamp
fresh today.]**

**t2-promotion (the actual judge load):** `t2_promoted_at` stamped on
336–689 rollups/day over the last 7 days (486 on 09-06). Each promoted
rollup = one judge call unless the transcript is <200 chars or the shape is
a re-run of an identical transcript hash. So **~400–500 judge calls/day**,
each ~1.3k-token fixed prompt + ≤~4–5k tokens of truncated transcript, JSON
output typically a few hundred tokens (max_tokens budget 16384).
**[CONFIRMED volume; INFERRED token mix — `n_prompt_tokens` is not logged
per call. The 20k-char cap makes ~5–6k tokens/call a hard ceiling × ~1.3.]

**Cost if this load ran on DeepSeek V4-Flash** (published rates
$0.14/M input cache-miss, $0.0028 hit, $0.28/M output; an Aug-2026 source
reports peak/off-peak $0.44/$0.22 in and $1.32/$0.66 out —
**[CONFIRMED public pricing; which schedule applies to this account is
INFERRED]**):

- ~500 calls/day × ~5k in / ~0.4k out ≈ 2.5M in + 0.2M out/day
  → ~75M in + ~6M out/month
  → **~$12.7/mo** at $0.14/$0.28; **~$21–38/mo** at off-peak/peak mix.
- Prefix-cache hits on the 1.3k fixed preamble cut input further
  (~50× cheaper on hits) — real cost likely at the low end.
- The dreaming quorum at zero volume costs $0 anywhere; even if P1 were
  unblocked at ~500 candidates/day × 3 voters × ~700-token calls it adds
  only ~$5–10/mo on Flash.

For comparison, local cost is RAM not money: 12 GiB reservation (3×4 GiB)
on a node at budget 36/36 GiB (**[CONFIRMED — `describe node local`]**).
The seats' own power is negligible.

**If instead the load rode a subscription provider:** dollar cost ≈ $0 but
it consumes the same quota pool as the executor fleet — see §4. On alibaba's
10,000-credit/7-day plan, ~2.5M judge tokens/day is a material share of a
pool already hitting gateway-wide 429s.

## 4. Quota contention — the decisive constraint

Live `routing_bias` rows (read 2026-09-06) — **[CONFIRMED]**:

- `provider:openai → exclude` — subscription at **primary 100% / secondary
  100%** (reset 2026-09-07/08); two dispatches died on arrival tonight.
- `provider:sakana → exclude` — subscription **expired**; all sakana seats
  429.
- `provider:alibaba → exclude` — gateway-wide 429 exhaustion re-confirmed
  today; 48h fence.
- `provider:anthropic → exclude` — reserved for maestro (operator's own
  session budget).
- `provider:google → divert 0.5` — agy on a lighter sub of unknown cap.
- `provider:devin → boost` — Pro account, free models only,
  `max_in_flight: 6`; no usage reader wired.
- `provider:opencode-go → boost` — a fleet workhorse, seven_day ~1.4%.

So of the subscription providers: openai, anthropic, google, sakana are
fenced or reserved outright, and alibaba is *currently* fenced for exactly
the failure cloud judging would amplify. Judge calls on a subscription
provider consume the **same** quota pool the executor fleet needs — on
alibaba, ~2.5M tokens/day of judge traffic against a 10k-credit/7-day plan
that is already 429ing would starve executors measurably.
**[CONFIRMED that the pools are shared per provider — `checkPressureCap`
and provider-scope biases; the exact credit burn per token is INFERRED —
no usage synth is wired for alibaba, quotas.yaml says the caps are inert.]**

The only channels where judge traffic does **not** steal executor quota:
metered `deepseek` (pays dollars, not quota) and `nvidia-nim` free preview
(unverified key). This is the entire reason cloud fallback is even
discussable.

## 5. Data egress

- **dreaming-judge** sends `first_prompt_excerpt` + memory body — small,
  ~200–2k chars of session content per vote. **[CONFIRMED —
  `buildDreamingPromptBlock`, `dreaming-judge-pool.ts:36-50`; avg excerpt
  238 chars measured.]**
- **t2-promotion** sends up to ~16k chars of rendered session transcript —
  **user prompts and assistant responses verbatim**, i.e. code, reasoning,
  and tool output. **[CONFIRMED — `t2.ts:378-395`.]**

What already leaves the machine today: deepseek (the default `reviewer`
seat, 226 completed dispatches/14d — review diffs), opencode-go personas
(diffs — including the operator-consented muse-spark train-on-prompts
seat), previously sakana. **[CONFIRMED — agent_performance, routing.yaml
persona notes.]** So *diff* egress to deepseek already exists. **New
exposure**: full session transcripts are broader than diffs — they include
everything the operator said plus assistant chain-of-thought and tool
output, going to a third party (DeepSeek, or Alibaba's Singapore gateway).
Whether that crosses a line is an operator decision; technically it is a
strictly larger surface than today's diff-only egress. Anthropic's
maestro-reserved content would flow to a non-anthropic provider —
**[INFERRED sensitivity: transcripts may contain content currently confined
to anthropic-scope sessions.]**

## 6. Latency

Measured 2026-09-06: a real judge-shaped call to the local granite seat via
the proxy (`POST 127.0.0.1:7944/v1/chat/completions`, 62-token prompt,
`max_tokens 256`, temp 0) completed in **1.01s** wall clock.
**[CONFIRMED — curl timing.]**

Cloud RTT floor (TLS + 401 round trip): deepseek 0.74s, alibaba 2.36s,
sakana 0.37s, openai 0.42s, groq 0.48s, anthropic 0.24s, nvidia 0.56s.
A ~5k-token judge call would add inference time — deepseek-flash review
dispatches average ~19.9s but those are ~10k-token agentic turns;
**[INFERRED] a 5k-in/0.4k-out judge call on flash is plausibly 3–10s.**

**It does not matter.** Every judge consumer is a background batch path:
the dreaming cycle runs ~30–45min cadence, the t2 worker ticks every ≥5min,
query-rewrites are cache fills. Judges do **not** gate interactive reviews
(§2). Even 30s/call would be invisible. Latency is neutral between local
and cloud here. **[CONFIRMED cadence from `serve.ts:1314-1316` and cycle
intervals; INFERRED per-call cloud time.]**

## 7. Fallback mechanics and direction

**What exists today** — all **[CONFIRMED]**:

- `createJudgeChat` + `attemptCandidatesInOrder`
  (`llm-candidates.ts:228-258`): ordered candidates per role, tried in
  sequence within a single call — real per-call failover. Applies active
  `routing_bias` excludes (provider/agent scope, expiry-checked,
  `llm-candidates.ts:166-178`), a provider allowlist, and drops
  unauthenticated external HTTP candidates (`llm-candidates.ts:351-361`).
  Used by `dispatch.refiner` (`serve.ts:1224-1237`) and
  `memory.efficacy_judge` (`serve.ts:1696-1728`). Candidate order: local
  HTTP first, then subscription HTTP, then process adapters
  (`llm-candidates.ts:336-345`).
- t2 judge pool (`t2-judge-pool.ts:259-295`): round-robin over
  `memory-refiner` holders; a judge with ≥2 consecutive failures is marked
  `unhealthy` and skipped **for the rest of that tick**; `resetTickHealth`
  clears it next tick. Multi-holder = automatic fallback; today there is
  exactly one holder.
- `local_seat_health_gate` (`routing.yaml` on; `serve.ts:2413-2425`) —
  probes local seats and excludes down ones **from role-routed dispatch
  only** (`routes/role-routing.ts:232`); it does not reach any judge pool.
- `routing_bias` / `subscription.pressure` machinery is the fencing layer
  already proven on fleet routing.

**The gap:** the dreaming-judge quorum pool has **no failover semantics at
all** — `judgeAll` calls every holder every vote and converts failure into
`promote:false / judge_error`. A cloud seat that 429s (exactly what fenced
providers do today) silently vetoes. Two such seats → `yesCount` can never
reach `ceil(total·2/3)` → auto-promotion silently freezes into `queued`
forever. **[CONFIRMED — `dreaming-judge-pool.ts:143-160`;
`cycle.ts:634`.]** This is the concrete failure mode the dispatch asked to
name: *a fallback that silently returns a lower-quality verdict* — here,
worse, a cloud member that *fails* returns a default-deny verdict.

**Direction — argue for local-primary.** The quorum is the only path where
a cloud failure turns into a false verdict; on the others, failover exists
and failure is loud (tick circuit-breaker, recorded outcomes). Local
failure modes are co-extensive with the daemon's (if the box is down the
pipeline is down anyway), while cloud failure is *selective* — the daemon
stays healthy and the judge just votes NO. Selective silent degradation is
strictly worse than total outage for a quorum member. For the non-quorum
roles (`memory-refiner`, `refiner`), local-primary + cloud-fallback costs
nothing to wire: add a deepseek HTTP seat to the role and the existing
ordered-candidate machinery makes it a fallback automatically.

To make **cloud-primary with local fallback** safe on the quorum path would
require changing `judgeAll`'s error semantics to *abstain* on transport
errors (small diff — ~20–40 lines + a test — but it changes quorum math:
abstentions reduce `total`, so a 3-holder pool with 2 abstaining cloud
seats leaves 1 voter < `autoPromoteMinJudges=2` → promotes park `queued`,
which is the same silent stall). So even after the code change,
cloud-primary on the quorum remains fragile unless the health signal is
also wired into candidate selection. **[INFERRED size; CONFIRMED the math.]**

## 8. Recommendation

**Local-primary; do not move the quorum seats to cloud; optionally add a
cloud fallback seat for the workhorse role.** Ranked:

1. **(a) Stop or re-home the two quorum-only ModelRuns** rather than
   relocating them to cloud. They serve a quorum that has not convened in
   two months (P1 claim livelock, §3). If the quorum is worth keeping, fix
   the livelock first and re-constitute ≥2 distinct-lineage holders —
   `role-floors.ts` requires ≥2 `dreaming-judge` holders on ≥2
   (aa_creator, aa_slug) lineages
   **[CONFIRMED — `role-floors.ts:9-55`]** — on mac-mini (which already
   runs `granite41-3b-judge-mac-mini` + a `granite-mini-3b` ModelHost,
   **[CONFIRMED — `get workloads`, fleet snapshot 2026-09-06]**) or one
   local + one cloud. This frees 8 GiB on `local` with zero cloud
   dependency, zero egress, zero quota burn.
2. **(b) Keep `granite41-3b-judge-local` local-primary** — it carries the
   only real load (~500 t2 extractions/day). If a fallback is wanted, add
   `deepseek-v4-flash-http` to the `memory-refiner` (and optionally
   `refiner`) role — zero code, the ordered-candidate + per-tick-unhealthy
   machinery makes it an automatic fallback, metered so no executor quota
   is touched. Worst-case cost if local died for a month: ~$13–35.
3. **(c) Cloud-primary is rejected** on every axis that matters here: it
   spends money or scarce quota on a workload that is mostly idle; it sends
   full session transcripts to a third party for no operational gain
   (latency is irrelevant on batch paths); and on the quorum path it
   converts provider failures into silent NO votes.
4. **(d) vs the mac-mini option** (parallel eval): cloud beats mac-mini
   only if mac-mini is truly 16 GB — the fleet snapshot shows ~0.1–0.2 GB
   free with ~6 GB active already, so saturating a 12 GiB budget with
   judges leaves no headroom. **[CONFIRMED memory pressure;
   INFERRED 16 GB profile.]** If mac-mini can host the seats, it beats
   cloud on egress (none), quota (none), and failure-domain (LAN, same
   operator) — prefer it over cloud for any seat that must keep running.

Concrete migration steps if the operator proceeds with (a)+(b):

1. Fix or work around the P1 livelock (e.g. bulk-resolve the 7,125 parked
   `queued` promote_t1 actions, or make the claim skip past rollups with
   queued actions instead of chewing them) — otherwise the quorum question
   is moot. **[INFERRED fix shape; CONFIRMED the bug.]**
2. Set the two quorum ModelRuns `enabled: false` (or move their workloads
   to `mac-mini` if the parallel eval finds headroom).
3. In penumbra `agents.yaml`, keep `dreaming-judge` role count ≥2 across
   ≥2 lineages (e.g. granite local + one other local/mac-mini seat), or
   accept pool=null → single-stub-vote → promotes park `queued`.
4. (Optional) grant `memory-refiner` to `deepseek-v4-flash-http` as
   fallback; verify `PENUMBRA_JUDGE_ROLE` unset so the role path stays
   authoritative; confirm the deepseek key works (it is already proven by
   today's reviewer dispatches).
5. Daemon reload (`daemon_reload_config` / kickstart) — no restart of
   workloads needed for role changes.

**Reversal conditions** — cloud-primary becomes defensible only if all of
these are true: (i) the P1 livelock is fixed and the quorum actually runs
at volume; (ii) `judgeAll` gains transport-error abstain + health-gated
candidate selection so a fenced provider cannot silently veto; (iii) the
operator accepts transcript-level egress to the chosen provider; (iv) the
provider is metered (deepseek) or demonstrably uncontended — not any of
the currently-fenced subscriptions. If mac-mini turns out to be ≥32 GB,
mac-mini beats cloud on every axis regardless.

## Appendix — evidence index

- Node budget: `DEV_STORAGE=~/DevStorage bun packages/cli/src/bin.ts
  describe node local` → `Budget: 36.0 / 36.0 GiB`; workloads list.
- Workloads: `get workloads` → judges Running; `granite41-3b-judge-mac-mini`
  Running; `omlx-qwen38-27b` 24 GiB Running.
- Quorum volume: `SELECT max(c.started_at) FROM dream_actions a JOIN
  dream_cycles c … action_type='promote_t1'` → 2026-07-06 21:28:12;
  status counts `auto_applied 128 / queued 7125`; claimed-rollups join →
  all 10 claimed have `has-queued`; 8,516 eligible rollups unclaimed.
- t2 volume: `SELECT substr(t2_promoted_at,1,10), count(*) FROM
  t1_rollups WHERE t2_promoted_at > now-7d GROUP BY 1` → 336–689/day.
- Query rewrites: `dream_query_rewrites` → 5–27 rows/day.
- memory-efficacy: `memory_efficacy_jobs` → 8 rows, last 2026-05-17.
- Seat outcomes: `agent_performance` → `deepseek-v4-flash-http` 226
  `completed_with_output`/14d, latest today.
- Biases: `SELECT * FROM routing_bias WHERE expires_at > now`.
- Latency: `time curl … :7944/v1/chat/completions` → 1.01s; endpoint
  probes above.
- Sources: `packages/daemon/src/dreaming/dreaming-judge-pool.ts`,
  `cycle.ts`, `workers/t2-judge-pool.ts`, `workers/t2-promotion.ts`,
  `core/src/writers/t2.ts`, `core/src/services/llm-candidates.ts`,
  `core/src/services/judge-chat.ts`, `packages/config/src/generator/
  role-floors.ts`, `daemon/src/serve.ts` (penumbra repo);
  `packages/core/src/openaiProxy.ts` (llamactl).
