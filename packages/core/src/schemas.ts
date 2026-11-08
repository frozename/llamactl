import { z } from "zod";

import { MACHINE_PROFILES } from "./types.js";

/**
 * On-disk wire formats for the TSV state files that the shell library
 * and the upcoming TS library both read and write. Each row is parsed
 * from a tab-separated line; the order of fields in `tsvFields` is the
 * authoritative column order.
 *
 * All rows carry a freeform `updated_at` string (ISO8601 or a
 * `%Y-%m-%dT%H:%M:%S%z` offset), kept as a plain string so older rows
 * written by zsh's `date` output continue to load.
 */

// ---- curated-models.tsv -------------------------------------------------
/**
 * Optional candidate metadata carried as compact JSON in column 9
 * (`meta`). Every key is absent by default, so builtin and legacy rows
 * keep the eight-column wire shape unchanged.
 */
export const CatalogAvailability = z.discriminatedUnion("declared", [
  z.object({ declared: z.literal("available"), reason: z.string().min(1).optional() }),
  z.object({
    declared: z.literal("unavailable"),
    reason: z.string().min(1),
  }),
]);

export const QUALIFICATION_STAGES = [
  "experimental",
  "candidate",
  "validated",
  "production",
  "degraded",
] as const;

export const CatalogQualification = z.object({
  stage: z.enum(QUALIFICATION_STAGES),
  since: z.string().min(1).optional(),
  evidenceRef: z.string().min(1).optional(),
});

export const CatalogRuntime = z.object({
  engines: z.array(z.string().min(1)).min(1),
  minBuild: z.string().min(1).optional(),
  toolCallFormat: z.string().min(1).optional(),
  reasoningFormat: z.string().min(1).optional(),
  chatTemplate: z.string().min(1).optional(),
});

export const CatalogParams = z.object({
  totalB: z.number().positive().optional(),
  activeB: z.number().positive().optional(),
  experts: z.number().int().positive().optional(),
});

export const CatalogMemory = z.object({
  residentGiB: z.number().nonnegative().optional(),
  diskBackedGiB: z.number().nonnegative().optional(),
  kvGiBPer32k: z.number().nonnegative().optional(),
});

export const CuratedMeta = z.object({
  availability: CatalogAvailability.optional(),
  qualification: CatalogQualification.optional(),
  runtime: CatalogRuntime.optional(),
  contextMax: z.number().int().positive().optional(),
  params: CatalogParams.optional(),
  memory: CatalogMemory.optional(),
  residencyGroup: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
});

export const CuratedModel = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    family: z.string().min(1),
    class: z.enum(["multimodal", "reasoning", "general", "custom"]),
    scope: z.string().min(1),
    rel: z.string().min(1),
    repo: z.string().min(1),
    format: z.enum(["gguf", "mlx"]).optional().default("gguf"),
  })
  .extend(CuratedMeta.shape);
export type CuratedModel = z.infer<typeof CuratedModel>;

export const curatedTsvFields = [
  "id",
  "label",
  "family",
  "class",
  "scope",
  "rel",
  "repo",
  "format",
] as const;

/**
 * Column 9 is optional compact JSON holding only the set keys; the
 * canonical top-level and nested key order is the zod schema order.
 */
export const curatedMetaColumn = "meta" as const;

/** Canonical top-level key order inside the `meta` JSON column. */
export const curatedMetaFields = [
  "availability",
  "qualification",
  "runtime",
  "contextMax",
  "params",
  "memory",
  "residencyGroup",
  "license",
] as const;

// ---- preset-overrides.tsv ----------------------------------------------
/**
 * Rows produced by `llama-curated-promote` / the TS equivalent. Writers
 * emit four fields; readers tolerate the three-field form that existed
 * briefly before `updated_at` was added.
 */
export const PresetOverride = z.object({
  profile: z.enum(MACHINE_PROFILES),
  preset: z.enum(["best", "vision", "balanced", "fast"]),
  rel: z.string().min(1),
  updated_at: z.string().optional().default(""),
});
export type PresetOverride = z.infer<typeof PresetOverride>;

export const presetOverrideFields = ["profile", "preset", "rel", "updated_at"] as const;

// ---- bench-profiles.tsv ------------------------------------------------
/**
 * One row per (machine, rel, mode, ctx, build) — the best tuned launch
 * profile for that combination. Legacy rows written before the split
 * have only five fields (rel, profile, gen_ts, prompt_ts, updated_at);
 * they are parsed via `BenchProfileLegacy`.
 */
/**
 * Numeric bench fields are kept as strings on the wire so the exact
 * textual representation written by the zsh `printf "%f"` calls (which
 * can include trailing zeros like `729.821530`) survives round-tripping.
 * Consumers that need arithmetic can `Number()` on demand.
 */
export const BenchProfile = z.object({
  machine: z.string().min(1),
  rel: z.string().min(1),
  mode: z.enum(["text", "vision"]),
  ctx: z.string().min(1),
  build: z.string().min(1),
  profile: z.string().min(1),
  gen_ts: z.string(),
  prompt_ts: z.string(),
  updated_at: z.string().min(1),
});
export type BenchProfile = z.infer<typeof BenchProfile>;

export const benchProfileFields = [
  "machine",
  "rel",
  "mode",
  "ctx",
  "build",
  "profile",
  "gen_ts",
  "prompt_ts",
  "updated_at",
] as const;

export const BenchProfileLegacy = z.object({
  rel: z.string().min(1),
  profile: z.string().min(1),
  gen_ts: z.string(),
  prompt_ts: z.string(),
  updated_at: z.string().min(1),
});
export type BenchProfileLegacy = z.infer<typeof BenchProfileLegacy>;

// ---- bench-history.tsv -------------------------------------------------
/**
 * Append-only log of every bench run. Columns mirror `BenchProfile`
 * plus the specific launch args that were tried for that run.
 */
export const BenchHistoryEntry = z.object({
  updated_at: z.string().min(1),
  machine: z.string().min(1),
  rel: z.string().min(1),
  mode: z.enum(["text", "vision"]),
  ctx: z.string().min(1),
  build: z.string().min(1),
  profile: z.string().min(1),
  gen_ts: z.string(),
  prompt_ts: z.string(),
  launch_args: z.string(),
});
export type BenchHistoryEntry = z.infer<typeof BenchHistoryEntry>;

export const benchHistoryFields = [
  "updated_at",
  "machine",
  "rel",
  "mode",
  "ctx",
  "build",
  "profile",
  "gen_ts",
  "prompt_ts",
  "launch_args",
] as const;

// ---- bench-vision.tsv --------------------------------------------------
/**
 * Real vision-path benchmarks driven by llama-mtmd-cli. Separate file
 * so the text bench schema doesn't need to grow an `image_encode_ms`
 * column for every record and so missing vision records are an explicit
 * absence rather than null columns in the primary bench file.
 */
export const BenchVision = z.object({
  machine: z.string().min(1),
  rel: z.string().min(1),
  ctx: z.string().min(1),
  build: z.string().min(1),
  load_ms: z.string(),
  image_encode_ms: z.string(),
  prompt_tps: z.string(),
  gen_tps: z.string(),
  updated_at: z.string().min(1),
});
export type BenchVision = z.infer<typeof BenchVision>;

export const benchVisionFields = [
  "machine",
  "rel",
  "ctx",
  "build",
  "load_ms",
  "image_encode_ms",
  "prompt_tps",
  "gen_tps",
  "updated_at",
] as const;

// ---- Hugging Face API responses ----------------------------------------
/**
 * Subset of the `GET /api/models/<repo>` response we actually consume.
 * The real payload has many more fields; we mark unknown ones loose
 * so caching preserves the full document byte-for-byte even if zod rejects
 * a future field rename on the fields we do care about.
 */
export const HFModelSibling = z
  .object({
    rfilename: z.string(),
    size: z.number().optional(),
    lfs: z.object({ size: z.number().optional() }).loose().optional(),
  })
  .loose();
export type HFModelSibling = z.infer<typeof HFModelSibling>;

export const HFModelInfo = z
  .object({
    id: z.string(),
    downloads: z.number().optional(),
    likes: z.number().optional(),
    lastModified: z.string().optional(),
    pipeline_tag: z.string().nullable().optional(),
    pipelineTag: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    siblings: z.array(HFModelSibling).optional(),
  })
  .loose();
export type HFModelInfo = z.infer<typeof HFModelInfo>;

export const HFTreeEntry = z
  .object({
    path: z.string(),
    type: z.enum(["file", "directory"]).optional(),
    size: z.number().optional(),
    lfs: z.object({ size: z.number().optional() }).loose().optional(),
  })
  .loose();
export type HFTreeEntry = z.infer<typeof HFTreeEntry>;

export const HFTree = z.array(HFTreeEntry);
export type HFTree = z.infer<typeof HFTree>;

export const HFDiscoveryFeed = z.array(HFModelInfo);
export type HFDiscoveryFeed = z.infer<typeof HFDiscoveryFeed>;

// ---- generic TSV helpers -----------------------------------------------

/** Split a TSV row into columns without mangling empty trailing fields. */
export function splitTsvRow(line: string): string[] {
  return line.split("\t");
}

/** Join a record in canonical column order into a TSV row. */
export function formatTsvRow<T extends Record<string, unknown>>(
  fields: readonly (keyof T & string)[],
  record: T,
): string {
  return fields.map((f) => String(record[f] ?? "")).join("\t");
}
