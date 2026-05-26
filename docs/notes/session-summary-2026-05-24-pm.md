# Session summary — 2026-05-24 pm

Project: `llamactl`. Session started: `2026-05-24T13:24:47.755Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).


- **Brief: llamactl (9ca088fb)** — # Project Brief: llamactl

## Executive Summary
The `llamactl` project is currently focused on refining the engine registry implementation and correcting synthetic data handling within the corpus. Recent work has established a robust Test-D


## Commits this session

```
6ed0306 chore(workloads,launchd): granite-3b useProxy + supervisor full-name args
3530d39 feat(cli/supervisor): consume workload spec useProxy at startup, route via internal proxy (Slice X.2)
526af7f fix(remote,docs): --no-auth implies plain HTTP (no TLS) on localhost binds
7d7da1c feat(core,remote,launchd): useProxy workload spec field + internal-only proxy plist (Slice X)
6bff9db test(core/openaiProxy): update kvcache test mock for JSON-body filename + basename wire shape
928933a fix(core/openaiProxy): pass slot basename to llama-server, keep abs path in registry
56e5a9f fix(core/kvstore): widen sentFilename closure var to satisfy tsc narrowing
0299a82 fix(core/kvstore): send slot save/restore filename in JSON body, not URL param
fb3c177 feat(remote,cli): --no-auth flag for agent serve (localhost-bound only, opt-in)
f10b9b3 fix(eval): resolve 23 pre-existing TypeScript errors (narrowing + fetch mock drift)
22a5873 docs(specs): oMLX slot API audit + recommendation (Phase 10)
559dc34 feat(core): Anthropic exact tool-replay via KV trailer (Phase 9 — closes Qwen3 canonicalization gap)
e847e71 feat(eval/matrix): kv-warm-bench workload + harness (T7.1)
0c6db38 feat(core/openaiProxy): KV false-hit detection via first-token fingerprint (T6.2)
ba70a8a feat(core/openaiProxy): wire KV cache lookup + save + budget eviction (T6.1)
1b98cce feat(core/kvstore): slot allocator + race-transition states + orphan sweeper (T5.2)
e58164d feat(core/kvstore): SlotClient + workloadEpoch helpers (T5.1)
a002d15 feat(core/anthropic): translateOpenAIStreamToAnthropic SSE state machine + fuzz (T3.2 — Slice 1 complete)
1237777 feat(core/kvstore): secondary-guard lookup + ENOSPC handling (T4.3)
a68c142 feat(core/kvstore): evictionScore pure function port from DS4 (T4.2)
dafc83d feat(core/anthropic): translateOpenAIResponse + non-stream /v1/messages response translation (T3.1)
9fd641e feat(core/kvstore): SQLite registry + storage bootstrapping (T4.1)
47c9193 feat(core/anthropic): translateAnthropicRequest + /v1/messages translator wiring
f23f578 refactor(core): extract proxyOpenAI into staged pipeline + add 501 for /v1/messages
```

## Dispatch events


- 2026-05-24T13:31:00.670Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:00.897Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:01.092Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:01.793Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:01.892Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:01.971Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:10.527Z `agent.tool_call.failed` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:31:29.391Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:29.391Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:29.391Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:29.681Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:29.871Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:29.979Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:30.236Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:36.433Z `agent.tool_call.failed` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:31:55.271Z `agent.tool_call.failed` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:31:58.193Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:58.193Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:58.412Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:31:58.649Z `agent.thought` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:32:25.678Z `acp.session.end` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:32:25.683Z `dispatch.end` handoff `1dcae30b-413c-4a84-aac6-9e05e85c0bb0`

- 2026-05-24T13:32:32.060Z `agent.tool_call.failed` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:32:44.516Z `agent.tool_call.failed` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:33:08.351Z `agent.tool_call.failed` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:33:34.456Z `agent.tool_call.failed` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:33:39.976Z `acp.session.end` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:33:52.737Z `dispatch.end` handoff `d36de567-6672-43c7-baa4-82f4be24e606`

- 2026-05-24T13:40:20.830Z `claim` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:20.830Z `dispatch.start` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:21.650Z `acp.server.start` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:23.149Z `acp.session.start` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:24.279Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:24.283Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:24.438Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:24.651Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:24.854Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:25.068Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:25.312Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:25.518Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:25.781Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:25.991Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:26.254Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:26.461Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:26.649Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:26.888Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:27.105Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:27.310Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:27.521Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:27.733Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:28.185Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:28.189Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:29.652Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:29.859Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:30.071Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:30.279Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:30.484Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:30.687Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:30.895Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:31.301Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:31.350Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:33.304Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:33.304Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:33.304Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:33.523Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:33.759Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:33.944Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:34.153Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:34.364Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:34.576Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:34.786Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:34.996Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:35.206Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:35.417Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:35.627Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:35.866Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:36.076Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:36.284Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:36.498Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:36.705Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:36.915Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:37.127Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:37.337Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:41.336Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`

- 2026-05-24T13:40:41.336Z `agent.thought` handoff `467b1af9-2b07-4a6c-98b9-43415c705617`


## Pending follow-ups



## Diff against main

```

```
