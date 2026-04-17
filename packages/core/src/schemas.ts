import { z } from 'zod';

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
export const CuratedModel = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  family: z.string().min(1),
  class: z.enum(['multimodal', 'reasoning', 'general', 'custom']),
  scope: z.string().min(1),
  rel: z.string().min(1),
  repo: z.string().min(1),
});
export type CuratedModel = z.infer<typeof CuratedModel>;

export const curatedTsvFields = [
  'id',
  'label',
  'family',
  'class',
  'scope',
  'rel',
  'repo',
] as const;

// ---- preset-overrides.tsv ----------------------------------------------
/**
 * Rows produced by `llama-curated-promote` / the TS equivalent. Writers
 * emit four fields; readers tolerate the three-field form that existed
 * briefly before `updated_at` was added.
 */
export const PresetOverride = z.object({
  profile: z.enum(['mac-mini-16g', 'balanced', 'macbook-pro-48g']),
  preset: z.enum(['best', 'vision', 'balanced', 'fast']),
  rel: z.string().min(1),
  updated_at: z.string().optional().default(''),
});
export type PresetOverride = z.infer<typeof PresetOverride>;

export const presetOverrideFields = ['profile', 'preset', 'rel', 'updated_at'] as const;

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
  mode: z.enum(['text', 'vision']),
  ctx: z.string().min(1),
  build: z.string().min(1),
  profile: z.string().min(1),
  gen_ts: z.string(),
  prompt_ts: z.string(),
  updated_at: z.string().min(1),
});
export type BenchProfile = z.infer<typeof BenchProfile>;

export const benchProfileFields = [
  'machine',
  'rel',
  'mode',
  'ctx',
  'build',
  'profile',
  'gen_ts',
  'prompt_ts',
  'updated_at',
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
  mode: z.enum(['text', 'vision']),
  ctx: z.string().min(1),
  build: z.string().min(1),
  profile: z.string().min(1),
  gen_ts: z.string(),
  prompt_ts: z.string(),
  launch_args: z.string(),
});
export type BenchHistoryEntry = z.infer<typeof BenchHistoryEntry>;

export const benchHistoryFields = [
  'updated_at',
  'machine',
  'rel',
  'mode',
  'ctx',
  'build',
  'profile',
  'gen_ts',
  'prompt_ts',
  'launch_args',
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
  'machine',
  'rel',
  'ctx',
  'build',
  'load_ms',
  'image_encode_ms',
  'prompt_tps',
  'gen_tps',
  'updated_at',
] as const;

// ---- generic TSV helpers -----------------------------------------------

/** Split a TSV row into columns without mangling empty trailing fields. */
export function splitTsvRow(line: string): string[] {
  return line.split('\t');
}

/** Join a record in canonical column order into a TSV row. */
export function formatTsvRow<T extends Record<string, unknown>>(
  fields: readonly (keyof T & string)[],
  record: T,
): string {
  return fields.map((f) => String(record[f] ?? '')).join('\t');
}
