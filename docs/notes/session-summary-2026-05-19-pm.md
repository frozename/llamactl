# Session summary — 2026-05-19 pm

Project: `llamactl`. Session started: `2026-05-19T15:16:07.516Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).


- **Test-driven development workflow for engine registry** — When implementing the engine registry skeleton, follow a TDD cycle: write the targeted test first, ensure it fails (red), add minimal placeholder implementation, run the test to confirm it passes (green), then refactor as needed.


## Commits this session

```
d3c9426 feat(eval/matrix): dflash-aware matrix bench + 3-way Qwen3-8B comparison
0698256 fix(remote/server): optional-chain child.unref for spawn mocks
8d8fe42 chore(remote): TS cleanup + sidecar specHash for ModelHost reconcile
66ade02 fix(remote): D2 — child.unref + reconciler idempotency + correct dflash pair
088374c fix(cli): persist ModelHost manifest before dispatching modelHostStart
c03fee3 feat(mlx): dflash D2 live-smoke template + script
7b2ddbb test(remote/workload): read ModelHost phase from sidecar after M7
3b5e762 fix(remote/workload): decouple ModelHost desired vs observed state
051f42d chore(core): clear pre-existing TypeScript errors
b49b651 Revert "chore: clear pre-existing TypeScript errors across core, remote, cli"
610a91b chore: clear pre-existing TypeScript errors across core, remote, cli
9ee82a7 fix(remote/workload): reconcile completeness - restart on spec drift + stable disabled
432c363 fix(remote/workload): single-scan admission + drop reconciler double-read + truthful disable
71e7429 fix(remote): close ModelHost RCE/SSRF + invoke prepareLaunch + teardown on probe fail + sanitize child env
c875e1c fix(remote/workload): make ModelHost reconcile idempotent
1e5bb75 fix(remote/workload): real ModelHost admission + skip redundant status query
3012622 fix(remote): implement ModelHost dispatch handler (engine spawn + lifecycle)
a1a304a fix(engines): split dflash sidecar write into engine.prepareLaunch hook
9455f57 fix(cli): wire dispatcher client into ModelHost apply path
a31b948 fix(remote/workload): persist ModelHost status from reconciler outcome
274a895 fix(remote/workload): align ApplyManifestOutcome pid with nullable status
ec21188 fix(remote/workload): drop synthetic ModelHost pid + cleanup on timeout
e8391c0 fix(remote/workload): tighten ModelHost name validation + path containment
7268e12 feat(mlx): complete ModelHost control-plane smoke coverage
099ed64 feat(cli): make enable and disable kind-aware
9f3160a feat(engines/omlx): per-model dflash settings via sidecar model_settings.json
d646ad4 feat(cli): surface ModelHost in workload list and apply persistence
c234393 feat(remote/workload): reconcile ModelHost alongside ModelRun
8643737 feat(remote/router): add ModelHost lifecycle procedures
c679897 feat(remote/workload): split ModelHost apply into its own converger
39298a7 feat(remote/workload): add kind-aware workload listing
6d7df2f feat(remote/workload): add ModelHost shared-store helpers
```

## Dispatch events


- 2026-05-19T15:30:14.079Z `acp.session.start` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:14.738Z `acp.session.start` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:15.095Z `acp.session.start` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:15.583Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:15.584Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:15.584Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:15.767Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:15.996Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:16.210Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:16.307Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:16.307Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:16.417Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:16.522Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:16.686Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:16.738Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:16.795Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:16.835Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:16.850Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:16.945Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:16.954Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:17.088Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:17.139Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:17.155Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:17.298Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:17.347Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:17.501Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:17.558Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:17.775Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:18.016Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:18.251Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:18.278Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:18.278Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:18.487Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:18.702Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:18.913Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:19.134Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:19.340Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:19.848Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:19.848Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:20.070Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:21.310Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:21.310Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:21.511Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:21.733Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:21.941Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:22.156Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:22.363Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:22.573Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:22.784Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:22.992Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:23.201Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:23.412Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:23.622Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:23.861Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:35.267Z `acp.session.end` handoff `3ed3ca64-de02-4ce0-b160-4047bb2d9836`

- 2026-05-19T15:30:41.182Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:41.182Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:41.486Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:41.493Z `dispatch.end` handoff `3ed3ca64-de02-4ce0-b160-4047bb2d9836`

- 2026-05-19T15:30:42.032Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:42.045Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:42.064Z `agent.thought` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:42.182Z `acp.session.end` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:42.563Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:42.563Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:42.563Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:42.722Z `dispatch.end` handoff `e8127804-d418-4d4f-9aa3-ce60bbb7980c`

- 2026-05-19T15:30:42.778Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:42.998Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:44.442Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:44.442Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:44.688Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:44.894Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:44.953Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:44.953Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:45.137Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:45.173Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:45.400Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:30:45.560Z `agent.thought` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:30:45.719Z `acp.session.end` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:31:11.128Z `dispatch.end` handoff `d13d8c4b-6834-4d3e-a232-08bd9efc85b1`

- 2026-05-19T15:31:12.509Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:31:12.509Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:31:12.509Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:31:12.603Z `agent.thought` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:31:12.947Z `acp.session.end` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:31:12.950Z `dispatch.end` handoff `6da33ff3-ab8d-46bf-807f-1d4ebe42fc26`

- 2026-05-19T15:34:42.033Z `claim` handoff `90df5e90-1efd-4459-8a7a-67f571d88ff5`

- 2026-05-19T15:34:42.034Z `dispatch.start` handoff `90df5e90-1efd-4459-8a7a-67f571d88ff5`

- 2026-05-19T15:34:42.069Z `acp.server.start` handoff `90df5e90-1efd-4459-8a7a-67f571d88ff5`

- 2026-05-19T15:34:42.172Z `acp.session.start` handoff `90df5e90-1efd-4459-8a7a-67f571d88ff5`

- 2026-05-19T15:34:59.916Z `agent.tool_call.failed` handoff `90df5e90-1efd-4459-8a7a-67f571d88ff5`


## Pending follow-ups



## Diff against main

```

```
