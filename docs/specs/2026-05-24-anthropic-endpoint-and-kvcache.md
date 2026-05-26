# Spec: `/v1/messages` Anthropic endpoint + disk-backed KV cache for openaiProxy

Date: 2026-05-24
Author: maestro session
Status: Draft for adversarial-plan fan-out

## Context

`packages/core/src/openaiProxy.ts` is the OpenAI-compatible gateway in front
of llama-server (`ModelRun`) and oMLX (`ModelHost`) workloads. It already
routes `/v1/*` requests by `model` from JSON body across a workload-runtime
mtime-keyed route map, strips `authorization` upstream, and re-streams the
response body as a fresh `ReadableStream`. The remote agent server
(`packages/remote/src/router.ts`) calls `proxyOpenAI` for local agent paths,
and the RAG chat endpoint uses it as the LLM transport.

Two extensions are wanted:

1. **Anthropic-compatible `/v1/messages` endpoint** — so local clients like
   Claude Code / opencode-anthropic can hit local llamactl-routed workloads
   directly, without an SDK shim.
2. **Disk-backed KV cache catalog** — so cold-prefill cost (already proven
   painful at 8k-32k contexts on M4 Pro) is paid once per byte-prefix, not
   once per request, and survives workload restarts.

Both layers slot into the existing `proxyOpenAI` function. They are
independent but compose: Anthropic exact-`tool_use` replay benefits from the
KV trailer-hook surface.

The design draws shape from `antirez/ds4` (`ds4_kvstore.{c,h}`):
byte-prefix-hash key, eviction score with hit half-life, ext-flag trailer
hooks, quant-mismatch guard, continued-store cadence, chat-anchor boundary
alignment. DS4 owns both metadata AND blobs because it IS the engine; we own
only the metadata + slot orchestration — llama-server's
`--slot-save-path` + `POST /slots/{id}?action=save|restore` owns the blob.

User-confirmed choices going into this fan-out:
- Both slices land in parallel (subagent fan-out on disjoint files)
- Registry storage: SQLite (consistent with fleet/lane/audit DBs)
- Anthropic endpoint streams SSE from day 1 (Claude Code is streaming-only
  in practice)

Anthropic API quota is constrained this session; the resulting plan should
prefer non-Anthropic agents for execution dispatches where the workload
allows it (codex/copilot/gemini/local Gemma-26B-A4B at :8181).

---

## Slice 1 — `/v1/messages` Anthropic endpoint

### Surface
New branch in `proxyOpenAI` when `url.pathname === '/v1/messages'`.
Translator owns request body rewrite, response body rewrite, and SSE event
stream rewrite. Forwarding (route map lookup, fetch, header strip,
ReadableStream re-wrap) reuses the existing OpenAI path.

### Translation matrix (request)

| Anthropic shape | OpenAI shape | Notes |
|---|---|---|
| `system` (string or `content[]`) | `messages[0]{role:"system"}` | block array → join text blocks |
| `messages[].content` string | `messages[].content` string | identity |
| `messages[].content[]{type:"text"}` | string | join |
| `messages[].content[]{type:"image",source}` | `messages[].content[]{type:"image_url"}` | base64 → data URL |
| `messages[].content[]{type:"tool_use",id,name,input}` | `assistant.tool_calls[]{id,function:{name,arguments}}` | `input` object → `arguments` JSON string |
| `messages[].content[]{type:"tool_result",tool_use_id,content}` | `messages[]{role:"tool",tool_call_id,content}` | one Anthropic user msg with N tool_results → N OpenAI tool msgs |
| `tools[]{name,description,input_schema}` | `tools[]{type:"function",function:{name,description,parameters}}` | wrap |
| `tool_choice` (`auto`/`any`/`tool`/`none`) | `tool_choice` (`auto`/`required`/`{type:"function",function:{name}}`/`none`) | enum map |
| `stop_sequences[]` | `stop[]` | identity |
| `max_tokens` | `max_tokens` | identity |

Reverse for response. Stop reason map:
- OpenAI `stop` → Anthropic `end_turn`
- OpenAI `length` → Anthropic `max_tokens`
- OpenAI `tool_calls` → Anthropic `tool_use`
- OpenAI `stop_sequence` → Anthropic `stop_sequence`

### SSE translation (state machine)

OpenAI streams `data: {choices:[{delta:{content?,tool_calls?[]}}]}` ending
with `data: [DONE]`. Anthropic streams a structured lifecycle:

- `message_start` (with empty `content`, partial `usage`)
- For each content block: `content_block_start` → N×`content_block_delta`
  (`text_delta` or `input_json_delta` for tool_use) → `content_block_stop`
- `message_delta` (final `stop_reason`, `stop_sequence`, `usage.output_tokens`)
- `message_stop`
- `ping` every ~15 s while streaming

The translator is a small state machine: track currently-open content-block
index, demote incoming text delta into `text_delta`, demote `tool_calls[]`
deltas into `input_json_delta` keyed by `tool_calls[].index`, emit
`content_block_start`/`stop` at block transitions, attach final usage to
`message_delta`.

### Out of scope (v1)
- `thinking` / `reasoning` blocks
- Prompt-caching `cache_control` markers (KV slice handles the underlying
  cache; v1 ignores the marker, doesn't error)
- Beta headers / `anthropic-version` enforcement (accept any version, return
  our shape)
- Multi-modal output (text only)

### File layout
```
packages/core/src/anthropic/
  translateRequest.ts      # AnthropicMessagesRequest → OpenAIChatRequest
  translateResponse.ts     # OpenAIChatResponse → AnthropicMessagesResponse
  translateStream.ts       # SSE Readable → Readable transform
  types.ts                 # Anthropic wire types (handwritten subset)
  index.ts
```

Wire into `proxyOpenAI` as one extra branch — translator owns body rewrite +
response wrap, then re-enters the existing fetch path.

### Tests (TDD shape)
- Fixture-based request/response pairs (12 golden cases recorded once)
- SSE replay test: feed a recorded llama-server SSE stream through
  `translateStream`, assert event order matches an Anthropic fixture
- Tool-call round-trip: request with tools → mock upstream emits OpenAI
  tool_calls → assert Anthropic `tool_use` block + `stop_reason: "tool_use"`
- E2E: spin a workload, point `@anthropic-ai/sdk` at the proxy, run 3 turns
  including a tool call

### Open questions
- Model name routing: require exact workload-model match (`qwen3-8b`) or
  add an optional alias map (`claude-sonnet-4-5` → local default)? Draft
  position: exact-match only; we don't pretend to be Claude.
- Should the translator also surface a `/v1/messages/count_tokens` shim?
  (Claude Code calls it.) Probably yes; cheap; just forward to upstream's
  `tokenize` endpoint and translate the count.

---

## Slice 2 — Disk-backed KV cache

### Architectural revelation
The proxy does **not** own the KV blobs. llama-server does, via
`--slot-save-path` + `POST /slots/{id}?action=save|restore`. oMLX may need
its own slot endpoint (followup phase; may require engine-side work in
`packages/remote/src/server/modelhost.ts`).

The proxy owns:
- The **metadata catalog** (which prompt prefixes have been checkpointed,
  for which workload, at what quant, with what hits/recency)
- The **policy** (when to write, when to evict, when to refuse a hit)
- The **slot orchestration** (call upstream's save/restore at the right
  moments)
- The **byte-prefix hash key** that is stable across workload restarts and
  client renaming
- The **ext-flag trailer surface** (Anthropic exact-`tool_use` replay map,
  session title, thinking/responses-visible blobs)

The DS4 design ports cleanly because metadata + policy is most of the value
even when we don't own the bytes.

### File layout
```
packages/core/src/kvstore/
  registry.ts              # Entry shape, byte-prefix SHA, lookup
  evictionScore.ts         # Port of ds4_kvstore_entry_eviction_score
  storage.ts               # SQLite-backed catalog + slot-file dir
  upstreamSlots.ts         # llama-server slot save/restore client
  trailer.ts               # Tool-replay map, ext-flag bits, JSON sidecar
  policy.ts                # Continued-store cadence, anchor alignment, quant guard
  index.ts
```

### Registry entry shape (lifted from `ds4_kvstore_entry`)
```ts
type KvEntry = {
  sha: string;              // SHA-1 of rendered byte prefix
  workload: string;
  upstreamSlotFile: string; // absolute path passed to llama-server slot/save
  quantBits: number;        // reject-different-quant guard
  tokens: number;
  ctxSize: number;
  hits: number;
  createdAt: number;        // unix ms
  lastUsed: number;
  payloadBytes: number;
  textBytes: number;
  extFlags: number;         // TOOL_MAP|SESSION_TITLE|RESPONSES_VISIBLE|THINKING_VISIBLE
  reason: 'cold'|'continued'|'evict'|'shutdown'|'agent_session';
};
```

### Lookup flow on incoming request
1. Render full prompt to bytes (already happens in the Anthropic translator
   or the existing OpenAI path)
2. Walk known boundary positions (chat-anchor token IDs for the workload's
   tokenizer); compute byte-prefix SHAs at each
3. Longest matching SHA in registry matching `workload + quantBits + ctxSize`
   → hit
4. On hit: `POST /slots/{id}?action=restore&filepath=<entry.upstreamSlotFile>`,
   then forward only the suffix tokens; bump `hits` + `lastUsed`
5. On miss: forward whole prompt; after response, per cadence policy, save
   slot + register

### Eviction
Port DS4's `entry_eviction_score(entry, live_tokens, protected_sha, now)`:
- Decay `hits` by a 6 h half-life
- Penalize entries whose prefix overlaps the live request (in use)
- Hard-protect entries with `sha === protected_sha`
- Drop lowest score until under per-workload byte budget

### Continued-store cadence
Configurable `continued_interval_tokens`; only write at chat-anchor
boundaries; suppressible API for "mid tool-call burst, hold off, resume
when stable."

### Quant guard
First-class. Entry carries `quantBits`. Reload workload → bump a
`workload_epoch`, soft-reject entries with stale epoch. Mismatched quant
treated as a hard miss.

### Trailer / ext-flag surface
JSON sidecar next to each slot file:
- `tool_map`: `{tool_id → exact bytes upstream emitted}` for exact-replay
  on the next turn (closes the Qwen3-tool_call canonicalization gap)
- `session_title`: derived from first user message
- `thinking_visible`, `responses_visible`: opaque blobs for the Anthropic /
  Responses endpoints

### Phasing
- **B1**: Registry + SQLite storage + eviction score + tests (pure unit, no
  upstream)
- **B2**: llama-server slot save/restore client + smoke test against the
  atomic-fork binary
- **B3**: Wire into `proxyOpenAI` JSON path (route → lookup → restore →
  forward → maybe save)
- **B4**: Continued-store cadence + chat-anchor alignment (needs per-workload
  tokenizer access — extend `/v1/models` or read workload yaml)
- **B5**: Bench: cold prefill vs warm restore on 8k/16k/32k prompts on M4
  Pro Gemma-4 26B-A4B, log wall savings
- **B6**: oMLX slot API audit + Phase D decision
- **B7**: Anthropic exact tool-replay (couples Slice 1 + Slice 2 via
  `tool_map` trailer)

### Open questions
- Slot persistence scope: workload-local
  (`<workloadRuntimeDir>/kvcache/`) — cleans with workload, no
  cross-workload sharing — vs node-global (`~/.llamactl/kvcache/`) —
  cross-workload, harder to GC. Draft position: workload-local; different
  workloads have different quants/tokenizers, sharing is meaningless.
- llama-server `--slot-save-path` — is this enabled by default on our
  atomic-fork builds, or does the workload yaml need to add it as
  `extraArgs`? Need to verify and document.
- Per-workload byte budget — config knob in workload yaml, or a single
  node-level default with per-workload override? Draft: node default +
  per-workload override.
- Tokenizer access for chat-anchor positions — does each workload expose a
  `/tokenize` endpoint we can trust, or do we need to vendor tokenizer.json
  per workload? llama-server does have `/tokenize`. oMLX may not.

---

## Risk register (seed for the personas)

- llama-server's slot save/restore is per-`slot_id`, but our server runs
  with `--parallel 1` mostly; need to confirm slot=0 is the path we always
  hit and that concurrent requests don't trample each other's slot
- SQLite write contention if many small entries land at once — need WAL
  mode and batched commits
- Byte-prefix SHA at the wrong granularity (mid-token byte position) will
  match cosmetically but not semantically; must align to tokenizer
  boundaries before hashing
- Anthropic SSE order is strict — clients will close the stream on
  malformed event sequence; the state machine must never emit a
  `content_block_delta` outside an open block
- Mid-stream upstream failure (llama-server crash mid-generation) needs to
  emit a clean Anthropic `message_stop` with `stop_reason: "error"` (note:
  not a real Anthropic stop reason — confirm fallback)
- KV cache hit on a prompt whose suffix turns out to drift from the
  checkpointed prefix at the token level (e.g., normalization difference)
  invalidates everything from the first divergent token — need a defensive
  re-prefill path

## Success metrics
- Slice 1: `@anthropic-ai/sdk` against the proxy completes a 3-turn
  tool-using session against a local llama-server workload, matching the
  same conversation against `https://api.anthropic.com` for response shape
  parity (modulo model differences)
- Slice 2: cold→warm prefill wall time on 16k prompt against Gemma-4
  26B-A4B on M4 Pro drops by ≥50%, measured by `ds4-bench`-equivalent
  per-frontier methodology added to `packages/eval/matrix`

## Non-goals
- Cross-node KV sharing
- KV blob compression beyond what llama-server already does
- Migrating off llama-server's slot API (we're a thin orchestrator on it)
- Supporting Anthropic's `prompt_caching_beta` exact behavior (we'll
  accept the markers but route them to our own KV path)
