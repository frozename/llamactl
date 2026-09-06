# Diagnosis: `cross-repo-smoke` is red

**Date:** 2026-09-06  
**Workflow:** [`.github/workflows/cross-repo-smoke.yml`](../../.github/workflows/cross-repo-smoke.yml)  
**Branch:** `main`

## Verdict

`cross-repo-smoke` has failed on every scheduled run since **run #99 on 2026-06-21**. The failure is not a cross-repo contract break; the LLAMACTL tier of `scripts/smoke-cross-repo.sh` is failing inside `llamactl`'s own `bun test` suite. The root cause is a mix of (a) an **environment/infra issue** in the cross-repo `bun install` layout that breaks tRPC client/server initialization, and (b) an unrelated **stale `strict-lint-rollout.test.ts` baseline**. Of the three mandated buckets, this is best classified as **(a) environmental/infra** — the failing tRPC errors do not reproduce in a normal single-repo local `bun test` run and only appear when the workflow installs all four repos side-by-side.

It is currently producing **negative value**: it has been red for 78 consecutive runs and is not catching the drift it was built for.

## 1. Failure history

- **First failing run:** [#99](https://github.com/frozename/llamactl/actions/runs/27903214266), head SHA `b6ab7d53`, triggered 2026-06-21 11:43 UTC.
- **Last successful run:** [#98](https://github.com/frozename/llamactl/actions/runs/27869457611), head SHA `fb0ad754`, triggered 2026-06-20 11:14 UTC.
- **Current streak:** 78 consecutive failures through run [#176](https://github.com/frozename/llamactl/actions/runs/34033511648) (head SHA `ad5b796a`, 2026-09-06).
- **Total runs on record:** 176.

## 2. Actual failing step and error

The only failing workflow step is **`Run cross-repo smoke`** (`scripts/smoke-cross-repo.sh`). The script exits with code 4 in the final LLAMACTL tier.

### CONFIRMED: errors from run #176 (ad5b796a)

The run page annotations show the same pattern as run #99:

```text
[ **error: expect(received).toBe(expected): ** llamactl/packages/cli/test/composite.test.ts#L130 ]
Expected: 0 Received: 1

[ **error: expect(received).toContain(expected): ** llamactl/packages/cli/test/controller-e2e.test.ts#L215 ]
Expected to contain: "ctl-test on gpu1: unchanged"
Received: "controller started pid=6339 ...
controller: source-staleness reload ARMED at ad5b796a...\n[2026-09-06T12:38:46.579Z] idle (no manifests in ...)\n"

[ **error: expect(received).toContain(expected): ** llamactl/packages/cli/test/controller-e2e.test.ts#L198 ]
Expected to contain: "\"state\": \"down\"" Received: ""

[ **TypeError: undefined is not an object (evaluating 'router._def._config'): **
llamactl/node_modules/.bun/@trpc+server@11.16.0+1fb4c65d43e298b9/node_modules/@trpc/server/dist/resolveResponse-C5I6V_wc.mjs#L1877 ]
at resolveResponse (.../resolveResponse-C5I6V_wc.mjs:1877:24)
at fetchRequestHandler (.../@trpc/server/dist/adapters/fetch/index.mjs:27:15)

[ **error: expect(received).toBe(expected): ** llamactl/packages/cli/test/workload-e2e.test.ts#L200 ]
Expected: 0 Received: 1

[ **error: migration worker 0 failed with 1:: ** llamactl/packages/core/test/kvstore.storage.test.ts#L615 ]

[ **error: expect(received).toBe(expected): ** llamactl/scripts/tooling/strict-lint-rollout.test.ts#L56 ]
Expected: "eslint ."
Received: "bun scripts/lint/no-cross-package-relative.ts && eslint . --max-warnings=0 && bun run typecheck:strict"
```

All errors are inside `llamactl`. The `NOVA`, `SIRIUS`, and `EMBERSYNTH` tiers must have completed, otherwise `smoke-cross-repo.sh` would have exited before reaching the LLAMACTL tier.

## 3. Root cause classification

**Classification: (a) environmental/infra.**

- The `strict-lint-rollout.test.ts` failure is a CONFIRMED local stale test (the test expects the old `"lint": "eslint ."` script). This is not cross-repo.
- The `composite.test.ts`, `controller-e2e.test.ts`, `workload-e2e.test.ts`, and `kvstore.storage.test.ts` failures are not present in a normal local single-repo `bun test` run, even though the same commit and `bun`/`@trpc/server` versions are used. The tRPC `router._def._config` error and the `client.compositeApply.mutate` error point to module initialization that only breaks under the cross-repo `bun install` layout (four sibling repos installed side-by-side with `file:` deps). That is an environment/dependency-resolution artifact of the CI workflow, not a code regression that reproduces on a developer machine.
- The cross-repo seam test (`packages/remote/test/cross-repo-seam.test.ts`) is not listed in the failure annotations, which would have been the expected signature of option (b), a genuine cross-repo contract break.

## 4. Commit correlation

- **CONFIRMED first failing SHA:** `b6ab7d53` (#110, 2026-06-21) — the first run that included this commit was #99.
- **Last green SHA:** `fb0ad754` (run #98, 2026-06-20).
- Between the two SHAs, several commits touched the same areas that now fail:
  - `5d2a8ce5` "adopt no-cross-package-relative lint" changed `package.json`'s `lint` script from `"eslint . --max-warnings=0"` to `"bun scripts/lint/no-cross-package-relative.ts && eslint . --max-warnings=0"`.
  - `1a8cbd09` later added `&& bun run typecheck:strict`.
  - `b6ab7d53` itself is a large mechanical codemod that updated `bun.lock` (185 lines), `package.json`, and `packages/cli/src/commands/composite.ts` / `controller.ts`. It also introduced the `typecheck:strict` script.
- **INFERRED:** the `strict-lint-rollout.test.ts` failure was introduced by the `lint` script change; the tRPC/e2e failures first appear at `b6ab7d53` and persist across all later SHAs, so they are either triggered by that commit's `bun.lock`/`package.json` changes or by the cross-repo install environment interacting with those changes. A clean bisect would be needed for a definitive code-level causation.

## 5. Does this share a cause with the `main check` redness?

**No.** The `main check` workflow has also been red on `main` since 2026-07-01 (per its run history and the provided context). `cross-repo-smoke` went red **ten days earlier** (2026-06-21). They may share a *symptom class* (fragile CLI e2e tests that spawn subprocesses and depend on timing/certs), but the onsets, SHAs, and error patterns are different. The `main check` context mentions two racy reconciler tests; `cross-repo-smoke` additionally shows tRPC `router._def._config` initialization errors and a stale lint baseline.

## 6. Fix or retire?

**Recommendation: fix, but only if the workflow is narrowed to its actual purpose.**

The workflow was built to catch cross-repo schema drift by running sibling test suites and the `packages/remote/test/cross-repo-seam.test.ts` seam. Today it is effectively a redundant, more brittle copy of `llamactl`'s own `bun test`, and it has been red for 78 straight runs. A permanently red signal trains people to ignore CI.

If kept, the minimum fixes are:

1. Update `scripts/tooling/strict-lint-rollout.test.ts` line 56 to match the current `lint` script (or remove that assertion from a workflow whose job is cross-repo smoke).
2. Investigate why `appRouter` / `client.compositeApply` are not resolved in the cross-repo install environment. This likely requires running the workflow in a debug branch and inspecting `node_modules` / `bun` module resolution.
3. Stabilize or quarantine the `controller-e2e` and `workload-e2e` subprocess tests that depend on agent start-up and cert generation.
4. Decide whether `llamactl bun test` belongs in this workflow at all, given `main check` already covers it.

If no one is committed to owning those fixes, **retire the workflow**. In its current state it is not catching the seam drift it was designed for and is adding noise to an already-red CI dashboard.

---

**Methodology note:** GitHub CLI (`gh`) was not authenticated in this environment, so the investigation used the public GitHub Actions API and public run-page annotations. Full workflow logs were unavailable because the logs API requires repository admin rights; the quoted errors come from the run-page `## Annotations` section, which is the same surface `gh run view --log-failed` would summarize.
