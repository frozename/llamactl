# Follow-up: `packages/eval` pre-existing tsc errors

Date: 2026-05-24
Discovered during: Phase 7 T7.1 (`kv-warm-bench`) acceptance gate
Severity: Tech debt (pre-existing — not introduced by recent work)
Estimated effort: ~30 min mechanical fixes

## Background

T7.1 added `packages/eval/src/matrix/workloads/kv-warm-bench.ts` + tests. The new files compile clean and tests pass. The full `bun run --cwd packages/eval tsc --noEmit` check surfaced 23 pre-existing errors in unrelated files — these have been latent in the repo and are not caused by T7.1.

T7.1 was landed with `packages/core` tsc clean + new tests passing. The eval tsc errors are tracked here as a separate cleanup.

## Errors (23 total)

### Source files (5)
- `src/matrix/report.ts:80:31` — `Type 'string | undefined' is not assignable to type 'string'`
- `src/matrix/workloads/common.ts:48:12` — same
- `src/matrix/workloads/task-refiner-rubric.ts:51:27, 52:30, 55:19` — same (3 occurrences)
- `src/matrix/workloads/task-refiner-rubric.ts:81:3` — `ModelSpec.extra_args: readonly []` not assignable to mutable `string[]`

### Test files (18) — all the same two shapes
- 13× `Property 'preconnect' is missing in type '... => Promise<...>' but required in type 'typeof fetch'` — Bun's `fetch` global gained a `preconnect` method; test mocks haven't been updated to satisfy the new type
- 1× `Cannot find name 'RequestInfo'` (`test/matrix-lifecycle.test.ts:143`)
- 4× `'cell' is possibly 'undefined'` in `test/matrix.test.ts` — narrowing missing on array index access
- 3× `metrics/prediction does not exist on Promise<...>` in `test/matrix-tool-call-grammar.test.ts:43,47` and `test/matrix.test.ts:171` — missing `await` somewhere or `Promise<T> | T` union not narrowed

## Suggested fix approach

1. **Source files** — add `?? ''` or `?? throw new Error(...)` defaults on the 6 string-narrowing sites; change `extra_args` typing in `ModelSpec` to `readonly string[]` OR cast at the call site (prefer the type change).
2. **Test files** — define a single helper `mockFetch(impl): typeof fetch` that wraps an `as unknown as typeof fetch` cast and apply across all 18 test sites. Or: relax the existing mock to satisfy the new shape (`{...impl, preconnect: () => Promise.resolve()}`). Add the missing `await`s in the 3 `Promise<{metrics, ...}>` sites.

## Dispatch suggestion

`codex-acp-fast` should handle this in one shot — it's mechanical narrowing + helper-extraction work. Single task, ~30 min.

```
TASK: Fix 23 pre-existing TypeScript errors in packages/eval (see docs/notes/fix-eval-tsc-2026-05-24.md).
ACCEPTANCE: bun run --cwd packages/eval tsc --noEmit && bun test packages/eval/
```

## Why this wasn't caught earlier

The `bun run typecheck` script for `packages/eval` likely doesn't run tsc (see `project_typecheck_script_broken` memory entry — packages/app has the same issue). Worth verifying packages/eval's `typecheck` script is wired to actually invoke tsc.
