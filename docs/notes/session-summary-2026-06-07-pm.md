
# Session summary — 2026-06-07 pm

Project: `llamactl`. Session started: `2026-06-07T18:00:06.203Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).



- **MoQ role-fit 2026-06-07: maestro 4B=31/36; generative lfm2 0.983 wins (gemma LAST); skill-split retrieval≠generation** — Completing the MoQ "do-all" eval (M4 Pro, quiet GPU, mainline llama.cpp, granite judge :8083).

MAESTRO BENCH (tools/maestro-bench/bench-maestro.py, 36 tasks): **qwen35-4b-moq = 31/36 (86.1%) @ 44.7 tps** vs gemma-4-26B-A4B qat-mxfp4 incumb
  

- **MoQ vs Unsloth-Dynamic A/B (2026-06-07): at EQUAL BPW, UD beats MoQ ~5% on our eval — "+10%" claim NOT reproduced** — Matched-BPW A/B on Qwen3.5-9B (same base), M4 Pro quiet GPU, mainline llama.cpp: w-ahmad MoQ-5.3 (5.5GB) vs unsloth UD-Q4_K_XL (5.6GB) — ~equal size.

tool-call-grammar exact: MoQ-5.3 0.860 vs **UD 0.900** (UD +4.6%). memory-recall recall5:
  

## Commits this session

```

```

## Dispatch events



- 2026-06-07T21:44:34.520Z `acp.session.end` handoff `db4c7f70-4324-4065-b207-e1cac841bb5d`
  

- 2026-06-07T21:44:51.267Z `dispatch.end` handoff `db4c7f70-4324-4065-b207-e1cac841bb5d`
  

- 2026-06-07T21:45:21.113Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T22:15:46.199Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T22:34:47.223Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.223Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.223Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.223Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.223Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.223Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.223Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.223Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.230Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.230Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.230Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.230Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.230Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.230Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.231Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.231Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.237Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.237Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.237Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.237Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.237Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.237Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.237Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.237Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.244Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.244Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.244Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.244Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.244Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.244Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.244Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.244Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.251Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.251Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T22:34:47.251Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.251Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T22:34:47.251Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.251Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T22:34:47.251Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:34:47.251Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T22:41:45.916Z `claim` handoff `628cb12b-85ad-4e77-b371-0ea276070bfc`
  

- 2026-06-07T22:41:45.916Z `dispatch.start` handoff `628cb12b-85ad-4e77-b371-0ea276070bfc`
  

- 2026-06-07T22:41:46.533Z `claim` handoff `cc482a71-c4de-47da-a72f-d3508b3d5349`
  

- 2026-06-07T22:41:46.533Z `dispatch.start` handoff `cc482a71-c4de-47da-a72f-d3508b3d5349`
  

- 2026-06-07T22:41:46.805Z `acp.server.start` handoff `cc482a71-c4de-47da-a72f-d3508b3d5349`
  

- 2026-06-07T22:41:46.826Z `acp.session.start` handoff `628cb12b-85ad-4e77-b371-0ea276070bfc`
  

- 2026-06-07T22:41:47.425Z `acp.session.start` handoff `cc482a71-c4de-47da-a72f-d3508b3d5349`
  

- 2026-06-07T22:42:05.147Z `acp.session.end` handoff `628cb12b-85ad-4e77-b371-0ea276070bfc`
  

- 2026-06-07T22:42:08.052Z `acp.session.end` handoff `cc482a71-c4de-47da-a72f-d3508b3d5349`
  

- 2026-06-07T22:44:06.982Z `dispatch.end` handoff `cc482a71-c4de-47da-a72f-d3508b3d5349`
  

- 2026-06-07T22:44:06.982Z `dispatch.end` handoff `628cb12b-85ad-4e77-b371-0ea276070bfc`
  

- 2026-06-07T22:44:40.624Z `claim` handoff `740c281f-2841-4c52-b31f-26f1af381ef5`
  

- 2026-06-07T22:44:40.625Z `dispatch.start` handoff `740c281f-2841-4c52-b31f-26f1af381ef5`
  

- 2026-06-07T22:46:36.099Z `acp.server.start` handoff `740c281f-2841-4c52-b31f-26f1af381ef5`
  

- 2026-06-07T22:46:36.266Z `acp.session.start` handoff `740c281f-2841-4c52-b31f-26f1af381ef5`
  

- 2026-06-07T22:46:44.595Z `acp.session.end` handoff `740c281f-2841-4c52-b31f-26f1af381ef5`
  

- 2026-06-07T22:47:17.685Z `dispatch.end` handoff `740c281f-2841-4c52-b31f-26f1af381ef5`
  

- 2026-06-07T23:05:45.970Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T23:19:47.454Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.454Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.454Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.454Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.454Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.454Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.454Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.454Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.461Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.461Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.461Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.461Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.461Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.461Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.461Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.461Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.470Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.470Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.470Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.470Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.470Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.470Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.470Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.470Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.479Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.479Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.479Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.479Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.479Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.479Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.479Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.479Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.488Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.488Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-07T23:19:47.488Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.488Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-07T23:19:47.488Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.488Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-07T23:19:47.488Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:19:47.488Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-07T23:20:08.336Z `claim` handoff `e2c17b1a-0b7f-481c-8a11-cf6a8f87d2ad`
  

- 2026-06-07T23:20:08.336Z `dispatch.start` handoff `e2c17b1a-0b7f-481c-8a11-cf6a8f87d2ad`
  

- 2026-06-07T23:20:08.621Z `acp.session.reuse` handoff `e2c17b1a-0b7f-481c-8a11-cf6a8f87d2ad`
  

- 2026-06-07T23:20:09.427Z `acp.session.start` handoff `e2c17b1a-0b7f-481c-8a11-cf6a8f87d2ad`
  

- 2026-06-07T23:20:10.017Z `claim` handoff `fa9908a8-95dc-49f5-b06d-bdfb81535349`
  

- 2026-06-07T23:20:10.018Z `dispatch.start` handoff `fa9908a8-95dc-49f5-b06d-bdfb81535349`
  

- 2026-06-07T23:20:10.290Z `acp.server.start` handoff `fa9908a8-95dc-49f5-b06d-bdfb81535349`
  

- 2026-06-07T23:20:10.416Z `acp.session.start` handoff `fa9908a8-95dc-49f5-b06d-bdfb81535349`
  

- 2026-06-07T23:20:11.741Z `claim` handoff `d7f5aecf-08cb-4584-9be9-c2b86c49f09c`
  

- 2026-06-07T23:20:11.742Z `dispatch.start` handoff `d7f5aecf-08cb-4584-9be9-c2b86c49f09c`
  

- 2026-06-07T23:20:12.031Z `acp.server.start` handoff `d7f5aecf-08cb-4584-9be9-c2b86c49f09c`
  

- 2026-06-07T23:20:12.167Z `acp.session.start` handoff `d7f5aecf-08cb-4584-9be9-c2b86c49f09c`
  

- 2026-06-07T23:20:13.052Z `claim` handoff `8ec88192-2e09-4c7a-b8e8-ac38f4191fc5`
  

- 2026-06-07T23:20:13.052Z `dispatch.start` handoff `8ec88192-2e09-4c7a-b8e8-ac38f4191fc5`
  

- 2026-06-07T23:20:13.342Z `acp.server.start` handoff `8ec88192-2e09-4c7a-b8e8-ac38f4191fc5`
  

- 2026-06-07T23:20:13.498Z `acp.session.start` handoff `8ec88192-2e09-4c7a-b8e8-ac38f4191fc5`
  

- 2026-06-07T23:20:15.177Z `acp.session.end` handoff `fa9908a8-95dc-49f5-b06d-bdfb81535349`
  

- 2026-06-07T23:20:15.315Z `dispatch.end` handoff `fa9908a8-95dc-49f5-b06d-bdfb81535349`
  

- 2026-06-07T23:20:26.417Z `acp.session.end` handoff `e2c17b1a-0b7f-481c-8a11-cf6a8f87d2ad`
  

- 2026-06-07T23:20:30.610Z `acp.session.end` handoff `8ec88192-2e09-4c7a-b8e8-ac38f4191fc5`
  

- 2026-06-07T23:20:36.266Z `acp.session.end` handoff `d7f5aecf-08cb-4584-9be9-c2b86c49f09c`
  

- 2026-06-07T23:21:22.102Z `dispatch.end` handoff `e2c17b1a-0b7f-481c-8a11-cf6a8f87d2ad`
  

- 2026-06-07T23:21:22.103Z `dispatch.end` handoff `d7f5aecf-08cb-4584-9be9-c2b86c49f09c`
  

- 2026-06-07T23:21:22.103Z `dispatch.end` handoff `8ec88192-2e09-4c7a-b8e8-ac38f4191fc5`
  

## Pending follow-ups



## Diff against main

```

```
