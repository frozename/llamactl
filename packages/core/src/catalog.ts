import { resolveCustomCatalogFile } from "./env.js";
import { readFileSync } from "./safe-fs.js";
import {
  CuratedMeta,
  curatedMetaFields,
  CuratedModel,
  curatedTsvFields,
  formatTsvRow,
  splitTsvRow,
} from "./schemas.js";

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
    id: "gemma4-e4b-q8",
    label: "Gemma 4 E4B Q8",
    family: "gemma4",
    class: "multimodal",
    scope: "fast",
    rel: "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf",
    repo: "unsloth/gemma-4-E4B-it-GGUF",
    format: "gguf",
  },
  {
    id: "gemma4-e4b-q4",
    label: "Gemma 4 E4B Q4",
    family: "gemma4",
    class: "multimodal",
    scope: "compact",
    rel: "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf",
    repo: "unsloth/gemma-4-E4B-it-GGUF",
    format: "gguf",
  },
  {
    id: "gemma4-26b-q4",
    label: "Gemma 4 26B Q4",
    family: "gemma4",
    class: "multimodal",
    scope: "balanced",
    rel: "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf",
    repo: "unsloth/gemma-4-26B-A4B-it-GGUF",
    format: "gguf",
  },
  {
    id: "gemma4-31b-q4",
    label: "Gemma 4 31B Q4",
    family: "gemma4",
    class: "multimodal",
    scope: "quality",
    rel: "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf",
    repo: "unsloth/gemma-4-31B-it-GGUF",
    format: "gguf",
  },
  {
    // Tightest fit on 16 GiB unified memory (M4-class). 35B-A3B at
    // IQ2_M is ~11.5 GB; with KV-cache headroom under Metal's
    // 12.7 GB working-set cap the workload runs reliably with
    // operator-set `-c 4096 -ctk q4_0 -ctv q4_0`.
    id: "qwen36-iq2m",
    label: "Qwen 3.6 35B-A3B IQ2_M",
    family: "qwen36",
    class: "reasoning",
    scope: "compact-fit-16g",
    rel: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-IQ2_M.gguf",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    format: "gguf",
  },
  {
    id: "qwen36-q3s",
    label: "Qwen 3.6 35B-A3B Q3_K_S",
    family: "qwen36",
    class: "reasoning",
    scope: "compact",
    rel: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    format: "gguf",
  },
  {
    id: "qwen36-q4m",
    label: "Qwen 3.6 35B-A3B Q4_K_M",
    family: "qwen36",
    class: "reasoning",
    scope: "balanced",
    rel: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    format: "gguf",
  },
  {
    id: "qwen36-q4",
    label: "Qwen 3.6 35B-A3B Q4_K_XL",
    family: "qwen36",
    class: "reasoning",
    scope: "quality",
    rel: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    format: "gguf",
  },
  {
    // 27B at IQ2_M is ~10.2 GB; the smallest fit-on-16g rel for
    // the qwen35 family. Same KV-quant guidance as qwen36-iq2m.
    id: "qwen27-iq2m",
    label: "Qwen 3.5 27B IQ2_M",
    family: "qwen35",
    class: "reasoning",
    scope: "compact-fit-16g",
    rel: "Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-IQ2_M.gguf",
    repo: "unsloth/Qwen3.5-27B-GGUF",
    format: "gguf",
  },
  {
    id: "qwen27-q5",
    label: "Qwen 3.5 27B Q5",
    family: "qwen35",
    class: "reasoning",
    scope: "legacy-balanced",
    rel: "Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf",
    repo: "unsloth/Qwen3.5-27B-GGUF",
    format: "gguf",
  },
  {
    // Granite 4.1 8b at Q4_K_M — top agentic candidate per the
    // 2026-05-06 fleet eval (composite 1.000 on M4 Pro, 0.896 on
    // mac-mini; perfect 12/12 on penumbra-shaped tool-calling).
    id: "granite41-8b-q4",
    label: "Granite 4.1 8B Q4",
    family: "granite41",
    class: "general",
    scope: "compact-fit-16g",
    rel: "granite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf",
    repo: "unsloth/granite-4.1-8b-GGUF",
    format: "gguf",
  },
  {
    // Granite 4.1 3b at Q4_K_M — best small-model agentic candidate
    // per the 2026-05-06 fleet eval (composite 1.000 on both M4 Pro
    // and mac-mini; ~88 tps on M4 Pro, ~44 tps on mac-mini).
    id: "granite41-3b-q4",
    label: "Granite 4.1 3B Q4",
    family: "granite41",
    class: "general",
    scope: "fast",
    rel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q4_K_M.gguf",
    repo: "unsloth/granite-4.1-3b-GGUF",
    format: "gguf",
  },
  {
    // Quant revision 07c62fcdeaf1c05d22bd123c3da8058a1b1e63e2; base
    // zai-org/GLM-5.3-Flash@46a050bec13002ad29ee795c16e61cf4fa3c4a9c. The
    // GGUF arch is glm5next, which mainline llama.cpp cannot load. The rel
    // is the Z13 on-disk dir; no HF repo carries that name. The revisions
    // live here because repo stays a plain HF id: pull and hf read it.
    id: "glm53-flash-aj-iq2xxs",
    label: "GLM-5.3-Flash AJ-IQ2_XXS",
    family: "glm53",
    class: "reasoning",
    scope: "candidate",
    rel: "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf",
    repo: "aj9o9/GLM-5.3-Flash-GGUF",
    format: "gguf",
    qualification: { stage: "experimental" },
    runtime: { engines: ["llamacpp"], minBuild: "fork:mikealanni/gufo@2e499c39" },
    contextMax: 1048576,
    residencyGroup: "z13-large-gpu",
    license:
      "drafter: Anbeeld/GLM-5.3-Flash-DFlash2-GGUF CC-BY-NC-ND-4.0 (non-commercial); incoai/GLM-5.3-Flash-DFlash2 licence unknown",
  },
  {
    // Revision 2688c0c3c2c3b052ec4f6d10a8417b0ef7ee4eba; diskBackedGiB is
    // the IQ4_NL Engram on SSD.
    id: "deepseek41-flash-1017-ud-iq1s",
    label: "DeepSeek V4.1 Flash 1017 UD-IQ1_S",
    family: "deepseek41",
    class: "reasoning",
    scope: "candidate",
    rel: "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/UD-IQ1_S/DeepSeek-V4.1-Flash-1017-UD-IQ1_S-00001-of-00005.gguf",
    repo: "unsloth/DeepSeek-V4.1-Flash-1017-GGUF",
    format: "gguf",
    availability: {
      declared: "unavailable",
      reason: "artifact-not-downloaded; runtime-not-pinned",
    },
    qualification: { stage: "experimental" },
    runtime: { engines: ["llamacpp", "libosmos"], minBuild: "b11870" },
    memory: { residentGiB: 114.0, diskBackedGiB: 103 },
    residencyGroup: "z13-large-gpu",
  },
  {
    // Revision 2688c0c3c2c3b052ec4f6d10a8417b0ef7ee4eba; diskBackedGiB is
    // the IQ4_NL Engram on SSD.
    id: "deepseek41-flash-1017-ud-iq1m",
    label: "DeepSeek V4.1 Flash 1017 UD-IQ1_M",
    family: "deepseek41",
    class: "reasoning",
    scope: "candidate",
    rel: "DeepSeek-V4.1-Flash-1017-GGUF/UD-IQ1_M/DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf",
    repo: "unsloth/DeepSeek-V4.1-Flash-1017-GGUF",
    format: "gguf",
    availability: {
      declared: "unavailable",
      reason: "artifact-not-downloaded; runtime-not-pinned",
    },
    qualification: { stage: "experimental" },
    runtime: { engines: ["llamacpp", "libosmos"], minBuild: "b11870" },
    memory: { residentGiB: 130.2, diskBackedGiB: 103 },
    residencyGroup: "z13-large-gpu",
  },
  {
    // Revision and shard file names were not captured, so rel is the quant
    // dir only. Pin it when the artifact is approved.
    id: "deepseek41-flash-1017-gsq-rco-iq1m",
    label: "DeepSeek V4.1 Flash 1017 GSQ-RCO IQ1_M",
    family: "deepseek41",
    class: "reasoning",
    scope: "candidate",
    rel: "DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF/IQ1_M",
    repo: "ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF",
    format: "gguf",
    availability: {
      declared: "unavailable",
      reason: "artifact-not-downloaded; runtime-not-pinned; exceeds-node-budget-resident",
    },
    qualification: { stage: "experimental" },
    runtime: { engines: ["llamacpp"], minBuild: "b11870" },
    residencyGroup: "z13-large-gpu",
  },
  {
    // Revision b6e95d58; base XiaomiMiMo/MiMo-V2.6-Flash-MOPD@5220c3f5.
    id: "mimo26-flash-mopd-bpw25",
    label: "MiMo-V2.6-Flash MOPD BPW2.5",
    family: "mimo26",
    class: "reasoning",
    scope: "candidate",
    rel: "MiMo-V2.6-Flash-MOPD-GGUF-AesSedai/b6e95d58/BPW2.5/MiMo-V2.6-Flash-MOPD-BPW2.5-00001-of-00003.gguf",
    repo: "AesSedai/MiMo-V2.6-Flash-MOPD-GGUF",
    format: "gguf",
    availability: { declared: "unavailable", reason: "artifact-not-downloaded" },
    qualification: { stage: "experimental" },
    runtime: {
      engines: ["llamacpp"],
      minBuild: "b11298",
      toolCallFormat: "mimo-xml",
      reasoningFormat: "think-tags",
    },
    residencyGroup: "z13-large-gpu",
  },
  {
    // Revision 7c9ba384; rel is the quant dir only (file name not captured).
    // Pin it when the artifact is approved.
    id: "mimo26-flash-mopd-a4x",
    label: "MiMo-V2.6-Flash MOPD a4-x",
    family: "mimo26",
    class: "reasoning",
    scope: "candidate",
    rel: "MiMo-V2.6-Flash-MOPD-a4-x",
    repo: "j2ipper/MiMo-V2.6-Flash-MOPD-a4-x",
    format: "gguf",
    availability: {
      declared: "unavailable",
      reason: "artifact-not-downloaded; runtime-unverified",
    },
    qualification: { stage: "experimental" },
    runtime: {
      engines: ["llamacpp"],
      minBuild: "b11298",
      toolCallFormat: "mimo-xml",
      reasoningFormat: "think-tags",
    },
    residencyGroup: "z13-large-gpu",
  },
  {
    // File name not captured; rel is the quant dir only. Pin it when the
    // artifact is approved.
    id: "mimo26-flash-mopd-bpw30",
    label: "MiMo-V2.6-Flash MOPD BPW3.0",
    family: "mimo26",
    class: "reasoning",
    scope: "candidate",
    rel: "MiMo-V2.6-Flash-MOPD-GGUF/BPW3.0",
    repo: "AesSedai/MiMo-V2.6-Flash-MOPD-GGUF",
    format: "gguf",
    availability: { declared: "unavailable", reason: "exceeds-node-budget" },
    qualification: { stage: "experimental" },
    runtime: {
      engines: ["llamacpp"],
      minBuild: "b11298",
      toolCallFormat: "mimo-xml",
      reasoningFormat: "think-tags",
    },
    residencyGroup: "z13-large-gpu",
  },
];

export type CatalogScope = "all" | "builtin" | "custom";

export interface CatalogLoadOptions {
  customCatalogFile?: string;
}

function buildLegacyRecord(cols: readonly string[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [j, field] of curatedTsvFields.entries()) {
    if (field === "format" && (cols[j] === undefined || cols[j] === "")) {
      record[field] = "gguf";
      continue;
    }
    record[field] = cols[j] ?? "";
  }
  return record;
}

function parseMetaColumn(raw: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return "invalid meta JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "meta must be a JSON object";
  }
  const obj = value as Record<string, unknown>;
  const record: Record<string, unknown> = {};
  for (const key of curatedMetaFields) {
    if (Object.hasOwn(obj, key)) {
      record[key] = obj[key];
    }
  }
  return record;
}

export type CatalogRowParse = { ok: true; entry: CuratedModel } | { ok: false; error: string };

export function parseCatalogRow(line: string): CatalogRowParse {
  const cols = splitTsvRow(line);
  if (cols.length < curatedTsvFields.length - 1) {
    return { ok: false, error: "too few columns" };
  }

  const record = buildLegacyRecord(cols);
  const metaRaw = cols[curatedTsvFields.length];
  if (metaRaw !== undefined && metaRaw !== "") {
    const meta = parseMetaColumn(metaRaw);
    if (typeof meta === "string") {
      return { ok: false, error: meta };
    }
    Object.assign(record, meta);
  }

  const parsed = CuratedModel.safeParse(record);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, entry: parsed.data };
}

/**
 * Custom-catalog rows tolerate blank lines, `#` comments, and rows with
 * fewer than seven columns — matching the historical shell awk filter.
 * A non-empty column 9 (`meta`) must be a JSON object matching the
 * candidate-metadata schema; anything else, including trailing text on
 * a hand-edited legacy row, skips the row with a warning on stderr so
 * one malformed append never blows up the whole list.
 */
function parseCustomCatalogRow(line: string, lineNo: number, file: string): CuratedModel | null {
  if (splitTsvRow(line).length < curatedTsvFields.length - 1) return null;

  const cols = splitTsvRow(line);
  const rel = cols[5] ?? "";
  const result = parseCatalogRow(line);
  if (result.ok) return result.entry;

  process.stderr.write(
    `llamactl: skipping invalid catalog row in ${file}:${String(lineNo)} rel=${rel} (${result.error})\n`,
  );
  return null;
}

export function readCustomCatalog(file: string): CuratedModel[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const out: CuratedModel[] = [];
  for (const [i, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const parsed = parseCustomCatalogRow(line, i + 1, file);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Load the catalog at the requested scope. `all` concatenates builtin
 * and custom in that order, which keeps the built-in presets ranked
 * first for consumers that pick the first matching row (e.g. preset
 * resolution). `builtin` and `custom` are self-descriptive.
 */
export function listCatalog(scope: CatalogScope, opts: CatalogLoadOptions = {}): CuratedModel[] {
  // resolveCustomCatalogFile() honours the env var first and then falls
  // back to the same `$LOCAL_AI_RUNTIME_DIR/curated-models.tsv` default
  // the writers resolve through resolveEnv(), so readers see custom rows
  // even when nothing exported the var into process.env (launchd agents,
  // bare LLAMACTL_TEST_PROFILE shells). Evaluated lazily — the builtin
  // path never pays for path resolution or the machine-profile probe a
  // full resolveEnv() would run.
  const customFile = (): string => opts.customCatalogFile ?? resolveCustomCatalogFile();
  switch (scope) {
    case "builtin":
      return [...BUILTIN_CATALOG];
    case "custom":
      return readCustomCatalog(customFile());
    case "all":
    default:
      return [...BUILTIN_CATALOG, ...readCustomCatalog(customFile())];
  }
}

/** Serialise an entry as a TSV row using the canonical column order. */
export function formatCatalogRow(entry: CuratedModel): string {
  const normalized = { ...entry, format: entry.format };
  const line = formatTsvRow(curatedTsvFields, normalized as unknown as Record<string, unknown>);

  const picked: Record<string, unknown> = {};
  for (const key of curatedMetaFields) {
    const value = entry[key];
    if (value !== undefined) picked[key] = value;
  }
  if (Object.keys(picked).length === 0) return line;

  const canonical = CuratedMeta.safeParse(picked);
  if (!canonical.success) return line;

  return `${line}\t${JSON.stringify(canonical.data)}`;
}

/** Serialise a list of entries as a TSV block (one row per line). */
export function formatCatalogTsv(entries: readonly CuratedModel[]): string {
  return entries.map(formatCatalogRow).join("\n");
}

/**
 * Look up a catalog entry by relative GGUF path. Searches `all` by
 * default (builtin first, then custom) to match the shell helper's
 * priority order.
 */
export function findByRel(
  rel: string,
  opts: CatalogLoadOptions & { scope?: CatalogScope } = {},
): CuratedModel | null {
  const entries = listCatalog(opts.scope ?? "all", opts);
  for (const entry of entries) {
    if (entry.rel === rel) return entry;
  }
  return null;
}

/** Look up a catalog entry by (repo, file); `file` may be a relpath. */
export function findByRepoFile(
  repo: string,
  file: string,
  opts: CatalogLoadOptions & { scope?: CatalogScope } = {},
): CuratedModel | null {
  const entries = listCatalog(opts.scope ?? "all", opts);
  for (const entry of entries) {
    if (entry.repo !== repo) continue;
    if (entry.rel === file) return entry;
    if (entry.rel.endsWith(`/${file}`)) return entry;
  }
  return null;
}

/** Is this HF repo id referenced by any catalog entry? */
export function repoKnown(
  repo: string,
  opts: CatalogLoadOptions & { scope?: CatalogScope } = {},
): boolean {
  for (const entry of listCatalog(opts.scope ?? "all", opts)) {
    if (entry.repo === repo) return true;
  }
  return false;
}

/** Is this rel covered by any catalog entry? */
export function relKnown(
  rel: string,
  opts: CatalogLoadOptions & { scope?: CatalogScope } = {},
): boolean {
  return findByRel(rel, opts) !== null;
}

/**
 * Join a repo id and a file name into a rel path. If `file` already
 * contains a slash we assume it's already a relpath; otherwise we
 * prefix with the repo basename (matching `_llama_rel_from_repo_and_file`
 * in the shell library).
 */
export function relFromRepoAndFile(repo: string, file: string): string {
  if (file.includes("/")) return file;
  const basename = repo.includes("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo;
  return `${basename}/${file}`;
}

/**
 * Classify a (repo, file) pair against the catalog: `curated` when the
 * rel is in the catalog, `family-known` when the repo is in the catalog
 * but this specific rel isn't, and `new` otherwise. Used by discovery
 * to annotate rows with their catalog provenance.
 */
export type CuratedStatus = "curated" | "family-known" | "new";

export function curatedStatusForRepoFile(
  repo: string,
  file: string,
  opts: CatalogLoadOptions = {},
): CuratedStatus {
  const rel = relFromRepoAndFile(repo, file);
  if (relKnown(rel, opts)) return "curated";
  if (repoKnown(repo, opts)) return "family-known";
  return "new";
}
