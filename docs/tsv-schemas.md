# On-disk TSV schemas

All llamactl state that outlives a single command lives in tab-separated files under `$LOCAL_AI_RUNTIME_DIR` (default: `$DEV_STORAGE/ai-models/local-ai`). This document is the authoritative wire format. The `@llamactl/core` zod schemas (`packages/core/src/schemas.ts`) and the legacy shell library both read and write the same rows; if you change the shape, both sides need to agree.

Conventions common to every file:

- Tab (`\t`) separator. No header row. No trailing newline is required but one is tolerated.
- Empty files are valid and mean "no records".
- `updated_at` is always a freeform timestamp string. Historically written as `date +%Y-%m-%dT%H:%M:%S%z` (e.g. `2026-04-17T10:07:02-0300`). Consumers should accept anything parseable by `Date` or keep it as a string for display.
- No quoting rules. Fields must not contain tabs or newlines. Values that could contain either (labels with spaces are fine) should stay tab-free.

## `curated-models.tsv`

Per-user catalog extensions appended by `llama-curated-add` and `llama-candidate-test`. The built-in curated catalog (hard-coded inside the shell library) is a superset of this file that reuses the same column shape.

| col | field  | type   | notes                                                                                           |
| --- | ------ | ------ | ----------------------------------------------------------------------------------------------- |
| 1   | id     | string | kebab-case unique id, e.g. `qwen3.5-0.8b-gguf-q4`                                               |
| 2   | label  | string | human-readable label, may contain spaces                                                        |
| 3   | family | string | model family, e.g. `qwen35`, `gemma4`, `deepseek`, `custom`                                     |
| 4   | class  | enum   | `multimodal` \| `reasoning` \| `general` \| `custom`                                            |
| 5   | scope  | string | `best` / `vision` / `balanced` / `fast` / `quality` / `compact` / `candidate` / freeform        |
| 6   | rel    | string | relative GGUF path under `$LLAMA_CPP_MODELS`, e.g. `Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf` |
| 7   | repo   | string | Hugging Face repo id, e.g. `unsloth/Qwen3.5-4B-GGUF`                                            |
| 8   | format | enum   | `gguf` \| `mlx`; an empty or missing column means `gguf`                                        |
| 9   | meta   | object | optional compact JSON holding candidate metadata; emitted only when at least one key is set     |

Example row:

```
qwen3.5-4b-gguf-q4\tQwen3.5-4B-UD-Q4_K_XL\tqwen35\tmultimodal\tcandidate\tQwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf\tunsloth/Qwen3.5-4B-GGUF
```

### Column 9: `meta`

An optional compact JSON object carrying candidate metadata. It is emitted only when at least one key is set; rows without it are legacy rows and load unchanged. A non-empty column 9 must be a JSON object — legacy rows with other trailing text are now skipped, with a warning on stderr. Unknown keys are dropped on load.

Canonical order: top-level keys are emitted in the order listed below, and nested keys in schema order, so a hand-written row round-trips byte-for-byte after a parse/format cycle.

| key                         | type     | constraints                                                                              |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `availability.declared`     | enum     | `available` \| `unavailable`                                                             |
| `availability.reason`       | string   | optional when `available`; required when `unavailable`                                   |
| `qualification.stage`       | enum     | `experimental` \| `candidate` \| `validated` \| `production` \| `degraded`               |
| `qualification.since`       | string   | optional, non-empty                                                                      |
| `qualification.evidenceRef` | string   | optional, non-empty                                                                      |
| `runtime.engines`           | string[] | non-empty; each engine name non-empty                                                    |
| `runtime.minBuild`          | string   | optional, non-empty                                                                      |
| `runtime.toolCallFormat`    | string   | optional, non-empty                                                                      |
| `runtime.reasoningFormat`   | string   | optional, non-empty                                                                      |
| `runtime.chatTemplate`      | string   | optional, non-empty                                                                      |
| `contextMax`                | int      | positive                                                                                 |
| `params.totalB`             | number   | positive; optional — inner keys are optional so partial measurements can be recorded     |
| `params.activeB`            | number   | positive; optional                                                                       |
| `params.experts`            | int      | positive; optional                                                                       |
| `memory.residentGiB`        | number   | non-negative; optional — inner keys are optional so partial measurements can be recorded |
| `memory.diskBackedGiB`      | number   | non-negative; optional                                                                   |
| `memory.kvGiBPer32k`        | number   | non-negative; optional                                                                   |
| `residencyGroup`            | string   | non-empty                                                                                |
| `license`                   | string   | non-empty                                                                                |

Example 9-column row:

```
glm53-flash\tGLM-5.3 Flash\tglm\treasoning\tcandidate\tGLM-5.3-Flash-GGUF/glm-5.3-flash-Q4_K_M.gguf\tunsloth/GLM-5.3-Flash-GGUF\tgguf\t{"availability":{"declared":"unavailable","reason":"runtime-not-pinned"},"qualification":{"stage":"experimental","since":"2026-11-07","evidenceRef":"eval/glm53-flash-001"},"runtime":{"engines":["llamacpp","omlx"],"minBuild":"b6100"},"contextMax":131072,"params":{"totalB":106,"activeB":12,"experts":128},"memory":{"residentGiB":18.5},"residencyGroup":"big-moe","license":"mit"}
```

Shell note: the awk lookups in `shell/llamactl.zsh` at :264/:1080/:1292 select columns by number and ignore column 9. `_llama_curated_meta_for_rel` (:942) passes the whole row through, and the positional `read -r` consumers at :2041 and :2119 fold trailing columns into their last variable. That is an existing limitation, already caused by `format`.

## `preset-overrides.tsv`

Runtime promotions written by `llama-curated-promote`. Each row overrides what a given `(profile, preset)` resolves to, shadowing the built-in mapping.

| col | field   | type   | notes                                             |
| --- | ------- | ------ | ------------------------------------------------- |
| 1   | profile | enum   | `mac-mini-16g` \| `balanced` \| `macbook-pro-48g` |
| 2   | preset  | enum   | `best` \| `vision` \| `balanced` \| `fast`        |
| 3   | rel     | string | relative GGUF path under `$LLAMA_CPP_MODELS`      |

At most one row per `(profile, preset)`. Writers replace the matching row; there is no row-level history.

## `qualification-overrides.tsv`

Pin/freeze rows for the model-qualification lifecycle (`packages/core/src/qualification/overrides.ts`), keyed on `(rel, action)`. Resolved from `LOCAL_AI_QUALIFICATION_OVERRIDES_FILE`, otherwise `qualification-overrides.tsv` under `$LOCAL_AI_RUNTIME_DIR`. A `pin` row requires a non-empty `stage`; a `freeze` row must carry an empty `stage`. Writers replace the matching `(rel, action)` row; `#` comments and invalid rows do not survive a write; a delete removes the file when it empties. Library-only until #284: editing this file today changes no routing or lifecycle behaviour.

| col | field        | type   | notes                                             |
| --- | ------------ | ------ | ------------------------------------------------- |
| 1   | `rel`        | string | model rel path, tab/newline-free                  |
| 2   | `action`     | enum   | `pin` \| `freeze`                                 |
| 3   | `stage`      | enum   | qualification stage for `pin`; empty for `freeze` |
| 4   | `author`     | string | who set the override, tab/newline-free            |
| 5   | `reason`     | string | why, tab/newline-free                             |
| 6   | `updated_at` | string | optional; missing pads to empty                   |

## `bench-profiles.tsv`

Current best tuned launch profile per `(machine, rel, mode, ctx, build)`. Written by `llama-bench-preset`; read by `llama-start` when `LLAMA_CPP_USE_TUNED_ARGS=true`.

| col | field      | type   | notes                                                                                       |
| --- | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| 1   | machine    | string | normalised machine profile, e.g. `macbook-pro-48g`                                          |
| 2   | rel        | string | model rel path                                                                              |
| 3   | mode       | enum   | `text` \| `vision` (vision is a label on text-throughput records for vision-capable models) |
| 4   | ctx        | string | context size used during tuning, e.g. `32768`                                               |
| 5   | build      | string | abbreviated llama.cpp build id, e.g. `82764d8f4`                                            |
| 6   | profile    | string | tuned profile name: `default` / `throughput` / `conservative`                               |
| 7   | gen_ts     | number | generation throughput in tokens/sec                                                         |
| 8   | prompt_ts  | number | prompt eval throughput in tokens/sec                                                        |
| 9   | updated_at | string | timestamp                                                                                   |

### Legacy format

Rows written before the context-aware split carry only five fields: `rel, profile, gen_ts, prompt_ts, updated_at`. Consumers detect these by `NF == 5` and treat them as implicit `mode=legacy ctx=legacy build=legacy machine=legacy` for display only.

## `bench-history.tsv`

Append-only log of every bench run. Same columns as `bench-profiles.tsv` with an extra `launch_args` trailing column and `updated_at` leading instead of trailing (matches how `date` emits first in the shell code).

| col | field       | type   | notes                                            |
| --- | ----------- | ------ | ------------------------------------------------ |
| 1   | updated_at  | string | timestamp                                        |
| 2   | machine     | string |                                                  |
| 3   | rel         | string |                                                  |
| 4   | mode        | enum   | `text` \| `vision`                               |
| 5   | ctx         | string |                                                  |
| 6   | build       | string |                                                  |
| 7   | profile     | string |                                                  |
| 8   | gen_ts      | number |                                                  |
| 9   | prompt_ts   | number |                                                  |
| 10  | launch_args | string | exact flags tried, e.g. `-fa on -b 2048 -ub 512` |

No compaction is performed automatically. Users that care about file size are expected to rotate or truncate manually.

## `bench-vision.tsv`

Real vision-path benchmarks produced by `llama-bench-vision`, which drives `llama-mtmd-cli` with a reference image (`LOCAL_AI_BENCH_IMAGE`, or a bundled 1x1 PNG). One row per `(machine, rel, ctx, build)`; writers replace the matching row on update.

| col | field           | type   | notes                                         |
| --- | --------------- | ------ | --------------------------------------------- |
| 1   | machine         | string |                                               |
| 2   | rel             | string |                                               |
| 3   | ctx             | string |                                               |
| 4   | build           | string |                                               |
| 5   | load_ms         | number | cold model + mmproj load time, milliseconds   |
| 6   | image_encode_ms | number | image slice encoding time, milliseconds       |
| 7   | prompt_tps      | number | post-image prompt eval throughput, tokens/sec |
| 8   | gen_tps         | number | post-image generation throughput, tokens/sec  |
| 9   | updated_at      | string |                                               |

Unlike `bench-profiles.tsv`, this file has a single schema — there is no legacy variant because the format was introduced with the vision-bench feature.

## Evolution rules

1. New columns append at the right. Writers emit them; readers tolerate extras beyond the last known column for forward compatibility.
2. Removing a column is a breaking change and requires a version bump in this document and in the zod schema.
3. Enum values are closed sets. Adding a new value requires updating the zod schema and every consumer that switches on it.
4. When a writer replaces a matching row, it preserves column order and does not reorder remaining rows.
