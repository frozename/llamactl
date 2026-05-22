# Session summary — 2026-05-18 pm

Project: `llamactl`. Session started: `2026-05-18T20:33:59.074Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).



## Commits this session

```
f0b67b6 feat(eval/specs): mlx-pilot matrix bench spec — Qwen3-8B-MLX-4bit
c8ab9e7 feat(workloads): Sub A pilot ModelHost yaml — Qwen3-8B-MLX-4bit on :8094
03ce53a fix(eval): type engine boot env fallback
4386f22 fix(remote/router): unify workload manifest parsing
70b18d3 fix(core/engines): bracket IPv6 probe hosts
77020e7 fix(workload): harden modelhost apply path
5ae4834 feat(workload): dispatch modelhost manifests by kind
1aa8900 feat(eval/matrix): dispatch boot commands by engine
6794328 fix(workload): unify engine enum with registry — accept llamacpp + omlx
30035f4 fix(core/engines): adversarial-review hardening — teardown, probe, SSRF, path-traversal, timeout, errors
d7edc3a fix(core/pull): normalize format classification
01e866b feat(core/engines): add oMLX adapter
234fdee feat(core/pull): MLX-format repo detection
42f1b99 feat(workload): ModelHost zod schema
761f822 feat(core/engines): llamacpp adapter (validate/boot/probe/teardown)
a2a947e fix(core/catalog): adversarial-review hardening — format inference + parser + TSV escaping
5fbeca5 fix(tools): adversarial-review hardening — pin SHA, validate SHA, smoke fail-fast
d707085 docs(AGENTS): MLX engine selection preferences (Sub A)
988157e feat(core/catalog): add format=gguf|mlx column
edce0e6 feat(tools): smoke-modelhost-omlx.sh — Sub A end-to-end smoke
fcb9d4f feat(tools): oMLX from-source bootstrap script + lockfile
232d591 feat(core/engines): EngineAdapter strategy registry skeleton
```

## Dispatch events


- 2026-05-18T20:47:13.248Z `agent.tool_call.failed` handoff `155604f0-162a-48c6-8478-daf75d98225d`

- 2026-05-18T20:47:25.990Z `acp.session.end` handoff `155604f0-162a-48c6-8478-daf75d98225d`

- 2026-05-18T20:47:26.028Z `dispatch.end` handoff `155604f0-162a-48c6-8478-daf75d98225d`

- 2026-05-18T20:49:54.020Z `claim` handoff `6358be8e-c687-48af-8e6d-1d319b724d3c`

- 2026-05-18T20:49:54.021Z `dispatch.start` handoff `6358be8e-c687-48af-8e6d-1d319b724d3c`

- 2026-05-18T20:49:54.062Z `acp.server.start` handoff `6358be8e-c687-48af-8e6d-1d319b724d3c`

- 2026-05-18T20:49:54.164Z `acp.session.start` handoff `6358be8e-c687-48af-8e6d-1d319b724d3c`

- 2026-05-18T20:49:58.377Z `claim` handoff `1a9e804f-901f-4a10-bf79-8360bdafdb7a`

- 2026-05-18T20:49:58.378Z `dispatch.start` handoff `1a9e804f-901f-4a10-bf79-8360bdafdb7a`

- 2026-05-18T20:49:58.413Z `acp.server.start` handoff `1a9e804f-901f-4a10-bf79-8360bdafdb7a`

- 2026-05-18T20:49:58.508Z `acp.session.start` handoff `1a9e804f-901f-4a10-bf79-8360bdafdb7a`

- 2026-05-18T20:50:00.010Z `claim` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:00.011Z `dispatch.start` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:00.014Z `acp.server.start` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:05.698Z `acp.session.start` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:06.971Z `agent.tool_call.failed` handoff `6358be8e-c687-48af-8e6d-1d319b724d3c`

- 2026-05-18T20:50:08.869Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:08.869Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:09.072Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:09.293Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:09.500Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:09.709Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:09.921Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:10.164Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:10.368Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:10.580Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:10.791Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:11.013Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:23.200Z `acp.session.end` handoff `6358be8e-c687-48af-8e6d-1d319b724d3c`

- 2026-05-18T20:50:25.082Z `dispatch.end` handoff `6358be8e-c687-48af-8e6d-1d319b724d3c`

- 2026-05-18T20:50:25.334Z `claim` handoff `52c2be82-7f25-4c2d-a7f6-ba0de917cd25`

- 2026-05-18T20:50:25.334Z `dispatch.start` handoff `52c2be82-7f25-4c2d-a7f6-ba0de917cd25`

- 2026-05-18T20:50:26.321Z `acp.server.start` handoff `52c2be82-7f25-4c2d-a7f6-ba0de917cd25`

- 2026-05-18T20:50:26.428Z `acp.session.start` handoff `52c2be82-7f25-4c2d-a7f6-ba0de917cd25`

- 2026-05-18T20:50:27.227Z `agent.tool_call.failed` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:28.717Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:28.717Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:28.718Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:28.879Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:29.096Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:29.305Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:29.512Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:29.720Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:29.933Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:30.149Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:30.355Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:32.245Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:32.245Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:32.245Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:32.474Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:32.687Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:32.898Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:33.107Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:33.314Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:33.525Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:33.737Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:33.945Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:34.157Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:34.366Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:34.576Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:34.812Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:40.958Z `acp.session.end` handoff `1a9e804f-901f-4a10-bf79-8360bdafdb7a`

- 2026-05-18T20:50:53.292Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:53.298Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:53.539Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:53.685Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:53.948Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:54.110Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:54.323Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:54.559Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:54.668Z `dispatch.end` handoff `1a9e804f-901f-4a10-bf79-8360bdafdb7a`

- 2026-05-18T20:50:54.839Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:54.924Z `claim` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:50:54.924Z `dispatch.start` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:50:54.997Z `acp.server.start` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:50:55.033Z `agent.thought` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:55.188Z `claim` handoff `bd50756f-491c-4573-a09a-f3122b9c49e8`

- 2026-05-18T20:50:55.188Z `dispatch.start` handoff `bd50756f-491c-4573-a09a-f3122b9c49e8`

- 2026-05-18T20:50:55.227Z `acp.server.start` handoff `bd50756f-491c-4573-a09a-f3122b9c49e8`

- 2026-05-18T20:50:55.317Z `acp.session.start` handoff `bd50756f-491c-4573-a09a-f3122b9c49e8`

- 2026-05-18T20:50:55.455Z `acp.session.end` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:55.472Z `dispatch.end` handoff `9a5ad4bf-b090-4de8-8202-a673563b765e`

- 2026-05-18T20:50:57.123Z `acp.session.start` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:50:59.225Z `agent.thought` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:50:59.234Z `agent.thought` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:50:59.559Z `agent.thought` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:51:03.451Z `agent.tool_call.failed` handoff `bd50756f-491c-4573-a09a-f3122b9c49e8`

- 2026-05-18T20:51:12.861Z `agent.tool_call.failed` handoff `52c2be82-7f25-4c2d-a7f6-ba0de917cd25`

- 2026-05-18T20:51:26.321Z `acp.session.end` handoff `bd50756f-491c-4573-a09a-f3122b9c49e8`

- 2026-05-18T20:51:26.344Z `dispatch.end` handoff `bd50756f-491c-4573-a09a-f3122b9c49e8`

- 2026-05-18T20:51:27.839Z `agent.thought` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:51:27.839Z `agent.thought` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:51:28.203Z `agent.thought` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`

- 2026-05-18T20:51:28.406Z `agent.thought` handoff `21e4a922-79ba-4296-b1a0-0a25adaf4499`


## Pending follow-ups



## Diff against main

```

```
