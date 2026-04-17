# On-disk TSV schemas

All llamactl state that outlives a single command lives in tab-separated files under `$LOCAL_AI_RUNTIME_DIR` (default: `$DEV_STORAGE/ai-models/local-ai`). This document is the authoritative wire format. The `@llamactl/core` zod schemas (`packages/core/src/schemas.ts`) and the legacy shell library both read and write the same rows; if you change the shape, both sides need to agree.

Conventions common to every file:

- Tab (`\t`) separator. No header row. No trailing newline is required but one is tolerated.
- Empty files are valid and mean "no records".
- `updated_at` is always a freeform timestamp string. Historically written as `date +%Y-%m-%dT%H:%M:%S%z` (e.g. `2026-04-17T10:07:02-0300`). Consumers should accept anything parseable by `Date` or keep it as a string for display.
- No quoting rules. Fields must not contain tabs or newlines. Values that could contain either (labels with spaces are fine) should stay tab-free.

## `curated-models.tsv`

Per-user catalog extensions appended by `llama-curated-add` and `llama-candidate-test`. The built-in curated catalog (hard-coded inside the shell library) is a superset of this file that reuses the same column shape.

| col | field  | type   | notes |
| --- | ------ | ------ | ----- |
| 1   | id     | string | kebab-case unique id, e.g. `qwen3.5-0.8b-gguf-q4` |
| 2   | label  | string | human-readable label, may contain spaces |
| 3   | family | string | model family, e.g. `qwen35`, `gemma4`, `deepseek`, `custom` |
| 4   | class  | enum   | `multimodal` \| `reasoning` \| `general` \| `custom` |
| 5   | scope  | string | `best` / `vision` / `balanced` / `fast` / `quality` / `compact` / `candidate` / freeform |
| 6   | rel    | string | relative GGUF path under `$LLAMA_CPP_MODELS`, e.g. `Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf` |
| 7   | repo   | string | Hugging Face repo id, e.g. `unsloth/Qwen3.5-4B-GGUF` |

Example row:
```
qwen3.5-4b-gguf-q4\tQwen3.5-4B-UD-Q4_K_XL\tqwen35\tmultimodal\tcandidate\tQwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf\tunsloth/Qwen3.5-4B-GGUF
```

## `preset-overrides.tsv`

Runtime promotions written by `llama-curated-promote`. Each row overrides what a given `(profile, preset)` resolves to, shadowing the built-in mapping.

| col | field   | type | notes |
| --- | ------- | ---- | ----- |
| 1   | profile | enum | `mac-mini-16g` \| `balanced` \| `macbook-pro-48g` |
| 2   | preset  | enum | `best` \| `vision` \| `balanced` \| `fast` |
| 3   | rel     | string | relative GGUF path under `$LLAMA_CPP_MODELS` |

At most one row per `(profile, preset)`. Writers replace the matching row; there is no row-level history.

## `bench-profiles.tsv`

Current best tuned launch profile per `(machine, rel, mode, ctx, build)`. Written by `llama-bench-preset`; read by `llama-start` when `LLAMA_CPP_USE_TUNED_ARGS=true`.

| col | field       | type   | notes |
| --- | ----------- | ------ | ----- |
| 1   | machine     | string | normalised machine profile, e.g. `macbook-pro-48g` |
| 2   | rel         | string | model rel path |
| 3   | mode        | enum   | `text` \| `vision` (vision is a label on text-throughput records for vision-capable models) |
| 4   | ctx         | string | context size used during tuning, e.g. `32768` |
| 5   | build       | string | abbreviated llama.cpp build id, e.g. `82764d8f4` |
| 6   | profile     | string | tuned profile name: `default` / `throughput` / `conservative` |
| 7   | gen_ts      | number | generation throughput in tokens/sec |
| 8   | prompt_ts   | number | prompt eval throughput in tokens/sec |
| 9   | updated_at  | string | timestamp |

### Legacy format

Rows written before the context-aware split carry only five fields: `rel, profile, gen_ts, prompt_ts, updated_at`. Consumers detect these by `NF == 5` and treat them as implicit `mode=legacy ctx=legacy build=legacy machine=legacy` for display only.

## `bench-history.tsv`

Append-only log of every bench run. Same columns as `bench-profiles.tsv` with an extra `launch_args` trailing column and `updated_at` leading instead of trailing (matches how `date` emits first in the shell code).

| col | field       | type   | notes |
| --- | ----------- | ------ | ----- |
| 1   | updated_at  | string | timestamp |
| 2   | machine     | string | |
| 3   | rel         | string | |
| 4   | mode        | enum   | `text` \| `vision` |
| 5   | ctx         | string | |
| 6   | build       | string | |
| 7   | profile     | string | |
| 8   | gen_ts      | number | |
| 9   | prompt_ts   | number | |
| 10  | launch_args | string | exact flags tried, e.g. `-fa on -b 2048 -ub 512` |

No compaction is performed automatically. Users that care about file size are expected to rotate or truncate manually.

## `bench-vision.tsv`

Real vision-path benchmarks produced by `llama-bench-vision`, which drives `llama-mtmd-cli` with a reference image (`LOCAL_AI_BENCH_IMAGE`, or a bundled 1x1 PNG). One row per `(machine, rel, ctx, build)`; writers replace the matching row on update.

| col | field            | type   | notes |
| --- | ---------------- | ------ | ----- |
| 1   | machine          | string | |
| 2   | rel              | string | |
| 3   | ctx              | string | |
| 4   | build            | string | |
| 5   | load_ms          | number | cold model + mmproj load time, milliseconds |
| 6   | image_encode_ms  | number | image slice encoding time, milliseconds |
| 7   | prompt_tps       | number | post-image prompt eval throughput, tokens/sec |
| 8   | gen_tps          | number | post-image generation throughput, tokens/sec |
| 9   | updated_at       | string | |

Unlike `bench-profiles.tsv`, this file has a single schema — there is no legacy variant because the format was introduced with the vision-bench feature.

## Evolution rules

1. New columns append at the right. Writers emit them; readers tolerate extras beyond the last known column for forward compatibility.
2. Removing a column is a breaking change and requires a version bump in this document and in the zod schema.
3. Enum values are closed sets. Adding a new value requires updating the zod schema and every consumer that switches on it.
4. When a writer replaces a matching row, it preserves column order and does not reorder remaining rows.
