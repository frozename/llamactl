import { readFileSync } from 'node:fs';
import { CuratedModel, curatedTsvFields, formatTsvRow, splitTsvRow } from './schemas.js';

/**
 * Built-in curated catalog. Mirrors `_llama_curated_catalog()` in the
 * shell library verbatim — same ids, same order — so downstream
 * consumers (bench-compare, recommendations, preset resolution) key
 * into the same rows regardless of which path loaded the catalog.
 *
 * Custom user entries live in the TSV file at
 * `LOCAL_AI_CUSTOM_CATALOG_FILE` and are concatenated after this list
 * by `listCatalog`.
 */
export const BUILTIN_CATALOG: readonly CuratedModel[] = [
  {
    id: 'gemma4-e4b-q8',
    label: 'Gemma 4 E4B Q8',
    family: 'gemma4',
    class: 'multimodal',
    scope: 'fast',
    rel: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
    repo: 'unsloth/gemma-4-E4B-it-GGUF',
  },
  {
    id: 'gemma4-e4b-q4',
    label: 'Gemma 4 E4B Q4',
    family: 'gemma4',
    class: 'multimodal',
    scope: 'compact',
    rel: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf',
    repo: 'unsloth/gemma-4-E4B-it-GGUF',
  },
  {
    id: 'gemma4-26b-q4',
    label: 'Gemma 4 26B Q4',
    family: 'gemma4',
    class: 'multimodal',
    scope: 'balanced',
    rel: 'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    repo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
  },
  {
    id: 'gemma4-31b-q4',
    label: 'Gemma 4 31B Q4',
    family: 'gemma4',
    class: 'multimodal',
    scope: 'quality',
    rel: 'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf',
    repo: 'unsloth/gemma-4-31B-it-GGUF',
  },
  {
    id: 'qwen36-q3s',
    label: 'Qwen 3.6 35B-A3B Q3_K_S',
    family: 'qwen36',
    class: 'reasoning',
    scope: 'compact',
    rel: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf',
    repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
  },
  {
    id: 'qwen36-q4m',
    label: 'Qwen 3.6 35B-A3B Q4_K_M',
    family: 'qwen36',
    class: 'reasoning',
    scope: 'balanced',
    rel: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
    repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
  },
  {
    id: 'qwen36-q4',
    label: 'Qwen 3.6 35B-A3B Q4_K_XL',
    family: 'qwen36',
    class: 'reasoning',
    scope: 'quality',
    rel: 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
    repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
  },
  {
    id: 'qwen27-q5',
    label: 'Qwen 3.5 27B Q5',
    family: 'qwen35',
    class: 'reasoning',
    scope: 'legacy-balanced',
    rel: 'Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf',
    repo: 'unsloth/Qwen3.5-27B-GGUF',
  },
] as const;

export type CatalogScope = 'all' | 'builtin' | 'custom';

export interface CatalogLoadOptions {
  customCatalogFile?: string;
}

/**
 * Read custom catalog entries from the on-disk TSV file. Blank lines,
 * lines starting with `#`, and lines with fewer than seven columns are
 * dropped — matching the tolerance of the historical shell awk filter.
 * Each surviving row is validated via zod; rows that fail validation
 * are skipped with a warning on stderr so one malformed append never
 * blows up the whole list.
 */
export function readCustomCatalog(file: string): CuratedModel[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const out: CuratedModel[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const cols = splitTsvRow(line);
    if (cols.length < curatedTsvFields.length) continue;

    const record: Record<string, string> = {};
    for (let j = 0; j < curatedTsvFields.length; j += 1) {
      const field = curatedTsvFields[j];
      if (field === undefined) continue;
      record[field] = cols[j] ?? '';
    }

    const parsed = CuratedModel.safeParse(record);
    if (!parsed.success) {
      process.stderr.write(
        `llamactl: skipping invalid catalog row in ${file}:${i + 1} (${parsed.error.issues.map((i) => i.message).join('; ')})\n`,
      );
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

/**
 * Load the catalog at the requested scope. `all` concatenates builtin
 * and custom in that order, which keeps the built-in presets ranked
 * first for consumers that pick the first matching row (e.g. preset
 * resolution). `builtin` and `custom` are self-descriptive.
 */
export function listCatalog(
  scope: CatalogScope,
  opts: CatalogLoadOptions = {},
): CuratedModel[] {
  const customFile =
    opts.customCatalogFile ?? process.env.LOCAL_AI_CUSTOM_CATALOG_FILE;
  switch (scope) {
    case 'builtin':
      return [...BUILTIN_CATALOG];
    case 'custom':
      return customFile ? readCustomCatalog(customFile) : [];
    case 'all':
    default: {
      const custom = customFile ? readCustomCatalog(customFile) : [];
      return [...BUILTIN_CATALOG, ...custom];
    }
  }
}

/** Serialise an entry as a TSV row using the canonical column order. */
export function formatCatalogRow(entry: CuratedModel): string {
  return formatTsvRow(curatedTsvFields, entry as unknown as Record<string, unknown>);
}

/** Serialise a list of entries as a TSV block (one row per line). */
export function formatCatalogTsv(entries: readonly CuratedModel[]): string {
  return entries.map(formatCatalogRow).join('\n');
}
