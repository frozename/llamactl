# llamactl tests

Three tiers, intended to run fastest-to-slowest:

```
bun run test          # full suite (core + cli + shell smoke)
bun run test:core     # core unit + integration only      (~50ms)
bun run test:cli      # cli e2e (spawns bin.ts per test)  (~600ms)
bun run test:shell    # shell smoke against real state
```

## Tier 1 — core (`packages/core/test/`)

Pure-TypeScript tests using [`bun:test`](https://bun.com/docs/cli/test). Two flavours:

- **Unit tests** (`profile`, `quant`, `ctx`, `discovery`, `hf`) — no I/O. Pure functions against inputs.
- **Integration tests** (`catalog`, `bench`, `env`, `presets`, `fsAtomic`, `catalogWriter`, `uninstall`) — read + write TSV files and model dirs. Each test creates a temp `$DEV_STORAGE` via `helpers.makeTempRuntime()` and cleans up in `afterEach`. Zero bleed into the developer's real state.

Fixtures live under `test/fixtures/`:

| file | shape |
| --- | --- |
| `curated-custom.tsv` | sample `LOCAL_AI_CUSTOM_CATALOG_FILE` with comments + blanks |
| `bench-profiles.tsv` | mix of current (9-col) + legacy (5-col) rows |
| `bench-history.tsv` | mix of current (10-col) + legacy (6-col) rows |
| `bench-vision.tsv` | one vision record |
| `preset-overrides.tsv` | two promotion rows |

## Tier 2 — CLI (`packages/cli/test/`)

Spawns `bun src/bin.ts <args>` via `child_process.spawnSync` against a hermetic temp runtime (`helpers.makeTempRuntime`). Asserts on exit code, stdout, and stderr. Keeps `LOCAL_AI_RECOMMENDATIONS_SOURCE=off` so no test hits the network.

Covers:

- `env --eval` / `--json`
- `catalog list` (scopes + `--json`), `catalog status`, `catalog add`, `catalog promote`, `catalog promotions`
- `bench show`, `bench history`, `bench compare` (with seeded TSV state)
- `uninstall` (candidate / non-candidate / `--force` / invalid args)

## Tier 3 — shell smoke (`test/shell-smoke.zsh`)

Exercises the zsh shims (`llama-*` and `llamactl <cmd>`) against the user's real `$DEV_STORAGE`. Sources llamactl's own `shell/env.zsh` + `shell/llamactl.zsh` so it can run standalone in CI.

Performs a full write round-trip (`catalog add` → `catalog promote` → `uninstall --force`) using a PID-suffixed fake rel so nothing long-lived is left on disk, and verifies the missing-bun shim fallback by stripping `bun` from `$PATH` in a subshell.

## Running a single test file

```zsh
cd packages/core && bun test test/catalog.test.ts
cd packages/cli  && bun test test/uninstall.test.ts
```

Bun's test runner supports `--watch` and `-t '<name pattern>'` for focused iteration.
