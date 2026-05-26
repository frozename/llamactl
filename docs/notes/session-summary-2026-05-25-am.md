# Session summary — 2026-05-25 am

Project: `llamactl`. Session started: `2026-05-25T02:18:35.432Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).



## Commits this session

```
5a28ca8 docs(notes): omlx v2.5 canary retest — all v2.5a fixes confirmed live; v2.5b blocked by oMLX prefix-cache config
2bfbeb0 fix(core/openaiProxy): v2.5c — strip user-supplied x_omlx_* at ingress + redact epoch in logs
786c86c docs(notes,specs): omlx v2 adversarial review synthesis + live canary findings
7e64fa3 fix(cli/supervisor,remote/store): apply useProxy override to ModelHost targets
5ab11c4 feat(core/openaiProxy): slot v2 phase 4b — structured log events for injection paths
9868a1b feat(core/openaiProxy,kvstore,cache-identity): inject x_omlx_request_handle + restore_epoch after slot restore (v2 phase 3)
8f6f585 feat(core/kvstore): UpstreamSlotClient.supportsRequestHandle — capability-aware v2 probe
500580f docs(notes): adversarial-plan synthesis on omlx v2 spec — 3-persona, no-Anthropic
dfffc0b docs(specs): oMLX slot API v2 spec — (model_id, request_handle) identity
c9477c7 feat(remote/modelhost-schema,core/openaiProxy): extend useProxy to ModelHost + admit ModelHost+omlx in KV gate (Slice X.3)
a5529dd fix(cli): resolve pre-existing TypeScript errors (allowExternalBind default + tRPC test seam)
```

## Dispatch events


- 2026-05-25T02:38:09.119Z `agent.tool_call.failed` handoff `2fbdb66a-329a-43dc-948b-3684f5c6ed7b`

- 2026-05-25T02:38:12.952Z `agent.tool_call.failed` handoff `2fbdb66a-329a-43dc-948b-3684f5c6ed7b`

- 2026-05-25T02:38:36.225Z `dream_p4_query_skipped` handoff `e30a0da4-1cbb-42bf-bbb1-ccd80a477d1e`

- 2026-05-25T02:38:36.225Z `dream_p4_query_skipped` handoff `e30a0da4-1cbb-42bf-bbb1-ccd80a477d1e`

- 2026-05-25T02:38:36.225Z `dream_p4_query_rewritten` handoff `e30a0da4-1cbb-42bf-bbb1-ccd80a477d1e`

- 2026-05-25T02:38:36.225Z `dream_p4_query_skipped` handoff `e30a0da4-1cbb-42bf-bbb1-ccd80a477d1e`

- 2026-05-25T02:39:36.224Z `dream_p4_query_skipped` handoff `0e036e7e-6ead-41d0-b837-1773e3aec8e5`

- 2026-05-25T02:39:36.224Z `dream_p4_query_skipped` handoff `0e036e7e-6ead-41d0-b837-1773e3aec8e5`

- 2026-05-25T02:39:36.224Z `dream_p4_query_rewritten` handoff `0e036e7e-6ead-41d0-b837-1773e3aec8e5`

- 2026-05-25T02:39:36.224Z `dream_p4_query_skipped` handoff `0e036e7e-6ead-41d0-b837-1773e3aec8e5`

- 2026-05-25T02:40:36.223Z `dream_p4_query_skipped` handoff `0b9736db-db25-4275-89db-101f40687ed1`

- 2026-05-25T02:40:36.223Z `dream_p4_query_skipped` handoff `0b9736db-db25-4275-89db-101f40687ed1`

- 2026-05-25T02:40:36.223Z `dream_p4_query_rewritten` handoff `0b9736db-db25-4275-89db-101f40687ed1`

- 2026-05-25T02:40:36.223Z `dream_p4_query_skipped` handoff `0b9736db-db25-4275-89db-101f40687ed1`

- 2026-05-25T02:41:20.011Z `agent.tool_call.failed` handoff `2fbdb66a-329a-43dc-948b-3684f5c6ed7b`

- 2026-05-25T02:41:23.565Z `agent.tool_call.failed` handoff `2fbdb66a-329a-43dc-948b-3684f5c6ed7b`

- 2026-05-25T02:41:39.519Z `dream_p4_query_skipped` handoff `06e01887-46bb-4dd2-a813-1da64ddb1ef1`

- 2026-05-25T02:41:39.519Z `dream_p4_query_skipped` handoff `06e01887-46bb-4dd2-a813-1da64ddb1ef1`

- 2026-05-25T02:41:39.519Z `dream_p4_query_rewritten` handoff `06e01887-46bb-4dd2-a813-1da64ddb1ef1`

- 2026-05-25T02:41:39.519Z `dream_p4_query_skipped` handoff `06e01887-46bb-4dd2-a813-1da64ddb1ef1`

- 2026-05-25T02:42:44.120Z `dream_p4_query_skipped` handoff `f6148f6c-41c2-4526-bc17-d3cef3f84a9a`

- 2026-05-25T02:42:44.120Z `dream_p4_query_skipped` handoff `f6148f6c-41c2-4526-bc17-d3cef3f84a9a`

- 2026-05-25T02:42:44.120Z `dream_p4_query_rewritten` handoff `f6148f6c-41c2-4526-bc17-d3cef3f84a9a`

- 2026-05-25T02:42:44.121Z `dream_p4_query_skipped` handoff `f6148f6c-41c2-4526-bc17-d3cef3f84a9a`

- 2026-05-25T02:44:10.380Z `dream_p4_query_skipped` handoff `3e2fd3b7-f1a3-47f7-bd97-eab632dbea25`

- 2026-05-25T02:44:10.380Z `dream_p4_query_skipped` handoff `3e2fd3b7-f1a3-47f7-bd97-eab632dbea25`

- 2026-05-25T02:44:10.380Z `dream_p4_query_rewritten` handoff `3e2fd3b7-f1a3-47f7-bd97-eab632dbea25`

- 2026-05-25T02:44:10.380Z `dream_p4_query_skipped` handoff `3e2fd3b7-f1a3-47f7-bd97-eab632dbea25`

- 2026-05-25T02:45:06.682Z `agent.tool_call.failed` handoff `2fbdb66a-329a-43dc-948b-3684f5c6ed7b`

- 2026-05-25T02:45:53.980Z `agent.tool_call.failed` handoff `2fbdb66a-329a-43dc-948b-3684f5c6ed7b`

- 2026-05-25T02:46:04.076Z `dream_p4_query_skipped` handoff `6e961d3c-97f4-4d67-930b-fa6a792e5f39`

- 2026-05-25T02:46:04.076Z `dream_p4_query_skipped` handoff `6e961d3c-97f4-4d67-930b-fa6a792e5f39`

- 2026-05-25T02:46:04.076Z `dream_p4_query_rewritten` handoff `6e961d3c-97f4-4d67-930b-fa6a792e5f39`

- 2026-05-25T02:46:04.076Z `dream_p4_query_skipped` handoff `6e961d3c-97f4-4d67-930b-fa6a792e5f39`

- 2026-05-25T02:46:28.569Z `acp.session.end` handoff `2fbdb66a-329a-43dc-948b-3684f5c6ed7b`

- 2026-05-25T02:46:33.264Z `dispatch.end` handoff `2fbdb66a-329a-43dc-948b-3684f5c6ed7b`

- 2026-05-25T02:47:05.339Z `dream_p4_query_skipped` handoff `fcbdfd5d-4763-4c81-95ee-bfb847b0996c`

- 2026-05-25T02:47:05.339Z `dream_p4_query_skipped` handoff `fcbdfd5d-4763-4c81-95ee-bfb847b0996c`

- 2026-05-25T02:47:05.339Z `dream_p4_query_rewritten` handoff `fcbdfd5d-4763-4c81-95ee-bfb847b0996c`

- 2026-05-25T02:47:05.339Z `dream_p4_query_skipped` handoff `fcbdfd5d-4763-4c81-95ee-bfb847b0996c`

- 2026-05-25T02:48:05.147Z `dream_p4_query_skipped` handoff `ccd8b52b-78f9-4104-848b-ec786f15ba61`

- 2026-05-25T02:48:05.147Z `dream_p4_query_skipped` handoff `ccd8b52b-78f9-4104-848b-ec786f15ba61`

- 2026-05-25T02:48:05.147Z `dream_p4_query_rewritten` handoff `ccd8b52b-78f9-4104-848b-ec786f15ba61`

- 2026-05-25T02:48:05.147Z `dream_p4_query_skipped` handoff `ccd8b52b-78f9-4104-848b-ec786f15ba61`

- 2026-05-25T02:49:05.161Z `dream_p4_query_skipped` handoff `69753e6f-f960-4d10-bb13-3aee89c32372`

- 2026-05-25T02:49:05.161Z `dream_p4_query_skipped` handoff `69753e6f-f960-4d10-bb13-3aee89c32372`

- 2026-05-25T02:49:05.161Z `dream_p4_query_rewritten` handoff `69753e6f-f960-4d10-bb13-3aee89c32372`

- 2026-05-25T02:49:05.161Z `dream_p4_query_skipped` handoff `69753e6f-f960-4d10-bb13-3aee89c32372`

- 2026-05-25T02:50:05.152Z `dream_p4_query_skipped` handoff `c7782258-f27d-4d5c-9ea2-348c1c077ad1`

- 2026-05-25T02:50:05.152Z `dream_p4_query_skipped` handoff `c7782258-f27d-4d5c-9ea2-348c1c077ad1`

- 2026-05-25T02:50:05.152Z `dream_p4_query_rewritten` handoff `c7782258-f27d-4d5c-9ea2-348c1c077ad1`

- 2026-05-25T02:50:05.153Z `dream_p4_query_skipped` handoff `c7782258-f27d-4d5c-9ea2-348c1c077ad1`

- 2026-05-25T02:51:04.968Z `dream_p4_query_skipped` handoff `8900159c-a352-4b3d-871e-704221e93092`

- 2026-05-25T02:51:04.969Z `dream_p4_query_skipped` handoff `8900159c-a352-4b3d-871e-704221e93092`

- 2026-05-25T02:51:04.969Z `dream_p4_query_rewritten` handoff `8900159c-a352-4b3d-871e-704221e93092`

- 2026-05-25T02:51:04.969Z `dream_p4_query_skipped` handoff `8900159c-a352-4b3d-871e-704221e93092`

- 2026-05-25T02:52:04.976Z `dream_p4_query_skipped` handoff `a4f5179d-2c36-4025-8e91-76d5c50305dd`

- 2026-05-25T02:52:04.976Z `dream_p4_query_skipped` handoff `a4f5179d-2c36-4025-8e91-76d5c50305dd`

- 2026-05-25T02:52:04.976Z `dream_p4_query_rewritten` handoff `a4f5179d-2c36-4025-8e91-76d5c50305dd`

- 2026-05-25T02:52:04.976Z `dream_p4_query_skipped` handoff `a4f5179d-2c36-4025-8e91-76d5c50305dd`

- 2026-05-25T02:53:04.979Z `dream_p4_query_skipped` handoff `9fc2c297-b8c6-493a-b05a-9785c2d595fa`

- 2026-05-25T02:53:04.980Z `dream_p4_query_skipped` handoff `9fc2c297-b8c6-493a-b05a-9785c2d595fa`

- 2026-05-25T02:53:04.980Z `dream_p4_query_rewritten` handoff `9fc2c297-b8c6-493a-b05a-9785c2d595fa`

- 2026-05-25T02:53:04.980Z `dream_p4_query_skipped` handoff `9fc2c297-b8c6-493a-b05a-9785c2d595fa`

- 2026-05-25T02:54:05.419Z `dream_p4_query_skipped` handoff `35270952-10ae-4f76-9048-06f93bd4782e`

- 2026-05-25T02:54:05.419Z `dream_p4_query_skipped` handoff `35270952-10ae-4f76-9048-06f93bd4782e`

- 2026-05-25T02:54:05.419Z `dream_p4_query_rewritten` handoff `35270952-10ae-4f76-9048-06f93bd4782e`

- 2026-05-25T02:54:05.419Z `dream_p4_query_skipped` handoff `35270952-10ae-4f76-9048-06f93bd4782e`

- 2026-05-25T02:55:06.113Z `dream_p4_query_skipped` handoff `e33b3044-e2c3-4abf-975f-2beff0afff9f`

- 2026-05-25T02:55:06.113Z `dream_p4_query_skipped` handoff `e33b3044-e2c3-4abf-975f-2beff0afff9f`

- 2026-05-25T02:55:06.113Z `dream_p4_query_rewritten` handoff `e33b3044-e2c3-4abf-975f-2beff0afff9f`

- 2026-05-25T02:55:06.113Z `dream_p4_query_skipped` handoff `e33b3044-e2c3-4abf-975f-2beff0afff9f`

- 2026-05-25T02:55:34.776Z `reconciler.sweep.tick` handoff `reconciler.sweep`

- 2026-05-25T02:56:06.113Z `dream_p4_query_skipped` handoff `64011cfe-bf33-4e3d-ac4e-78a9d4efb338`

- 2026-05-25T02:56:06.113Z `dream_p4_query_skipped` handoff `64011cfe-bf33-4e3d-ac4e-78a9d4efb338`

- 2026-05-25T02:56:06.113Z `dream_p4_query_rewritten` handoff `64011cfe-bf33-4e3d-ac4e-78a9d4efb338`

- 2026-05-25T02:56:06.113Z `dream_p4_query_skipped` handoff `64011cfe-bf33-4e3d-ac4e-78a9d4efb338`

- 2026-05-25T02:57:09.712Z `dream_p4_query_skipped` handoff `d3379e14-3bcd-409f-b00f-1ad729aba983`

- 2026-05-25T02:57:09.713Z `dream_p4_query_skipped` handoff `d3379e14-3bcd-409f-b00f-1ad729aba983`

- 2026-05-25T02:57:09.713Z `dream_p4_query_rewritten` handoff `d3379e14-3bcd-409f-b00f-1ad729aba983`

- 2026-05-25T02:57:09.713Z `dream_p4_query_skipped` handoff `d3379e14-3bcd-409f-b00f-1ad729aba983`

- 2026-05-25T02:58:13.563Z `dream_p4_query_skipped` handoff `1921bbc7-0b1b-40db-bcbd-b08bf26e3ce6`

- 2026-05-25T02:58:13.564Z `dream_p4_query_skipped` handoff `1921bbc7-0b1b-40db-bcbd-b08bf26e3ce6`

- 2026-05-25T02:58:13.564Z `dream_p4_query_rewritten` handoff `1921bbc7-0b1b-40db-bcbd-b08bf26e3ce6`

- 2026-05-25T02:58:13.564Z `dream_p4_query_skipped` handoff `1921bbc7-0b1b-40db-bcbd-b08bf26e3ce6`

- 2026-05-25T02:59:09.725Z `dream_p4_query_skipped` handoff `d551c315-cb1c-4fd9-baca-0e6f929cff8a`

- 2026-05-25T02:59:09.725Z `dream_p4_query_skipped` handoff `d551c315-cb1c-4fd9-baca-0e6f929cff8a`

- 2026-05-25T02:59:09.726Z `dream_p4_query_rewritten` handoff `d551c315-cb1c-4fd9-baca-0e6f929cff8a`

- 2026-05-25T02:59:09.726Z `dream_p4_query_skipped` handoff `d551c315-cb1c-4fd9-baca-0e6f929cff8a`

- 2026-05-25T03:00:09.741Z `dream_p4_query_skipped` handoff `601d77d8-2c8c-485c-888a-9b3a8465e775`

- 2026-05-25T03:00:09.741Z `dream_p4_query_skipped` handoff `601d77d8-2c8c-485c-888a-9b3a8465e775`

- 2026-05-25T03:00:09.741Z `dream_p4_query_rewritten` handoff `601d77d8-2c8c-485c-888a-9b3a8465e775`

- 2026-05-25T03:00:09.741Z `dream_p4_query_skipped` handoff `601d77d8-2c8c-485c-888a-9b3a8465e775`

- 2026-05-25T03:01:11.841Z `dream_p4_query_skipped` handoff `10fb93b9-95fc-488c-819e-e31440765e34`

- 2026-05-25T03:01:11.841Z `dream_p4_query_skipped` handoff `10fb93b9-95fc-488c-819e-e31440765e34`

- 2026-05-25T03:01:11.841Z `dream_p4_query_rewritten` handoff `10fb93b9-95fc-488c-819e-e31440765e34`


## Pending follow-ups



## Diff against main

```

```
