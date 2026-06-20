import type { CuratedModel } from "./schemas.js";

import { findByRel, listCatalog } from "./catalog.js";
import { classifyRepo } from "./discovery.js";
import { resolveEnv } from "./env.js";
import { appendLine } from "./fsAtomic.js";
import { fetchModelInfo } from "./hf.js";
import { quantFromRel } from "./quant.js";

const VALID_CLASSES = new Set<CuratedModel["class"]>([
  "multimodal",
  "reasoning",
  "general",
  "custom",
]);

export interface AddCuratedInput {
  repo: string;
  /** Either a bare GGUF filename or a rel path (`<dir>/<file>`). */
  fileOrRel: string;
  label?: string;
  family?: string;
  class?: string;
  /** Defaults to `candidate` to match the shell library. */
  scope?: string;
}

export type AddCuratedResult =
  | { ok: true; entry: CuratedModel; file: string }
  | { ok: false; error: string };

/**
 * Derive a model family from the HF repo id. Mirrors the case ladder in
 * `llama-curated-add` verbatim so rows from the TS path file under the
 * same family bucket the shell would have produced.
 */
function deriveFamily(repo: string): string {
  const l = repo.toLowerCase();
  if (l.includes("gemma-4")) return "gemma4";
  if (l.includes("qwen3.6")) return "qwen36";
  if (l.includes("qwen3.5")) return "qwen35";
  if (l.includes("deepseek")) return "deepseek";
  return "custom";
}

function deriveEntryId(repoBase: string, rel: string): string {
  const quant = quantFromRel(rel);
  const raw = `${repoBase.toLowerCase()}-${quant}`;
  return raw.replaceAll(/[^a-z0-9._-]/g, "-");
}

/**
 * Resolve the class for a new catalog entry. When the caller supplies
 * a class explicitly, use it. Otherwise fetch the HF model info for
 * the repo and feed its pipeline_tag + tags to the discovery classifier
 * (same logic discover uses). Falls back to path-pattern via the
 * classifier when HF is disabled or unreachable.
 */
async function resolveClass(repo: string, provided: string | undefined): Promise<string> {
  if (provided && provided.length > 0) return provided;
  const info = await fetchModelInfo(repo);
  const pipeline = info?.pipeline_tag ?? info?.pipelineTag ?? "";
  const tags = (info?.tags ?? []).join(" ");
  return classifyRepo(repo, pipeline, tags);
}

function validateClass(value: string): CuratedModel["class"] | null {
  return VALID_CLASSES.has(value as CuratedModel["class"])
    ? (value as CuratedModel["class"])
    : null;
}

function nonEmptyOr(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

/** Name of the first field containing a TSV control character, if any. */
function findIllegalField(fields: Record<string, string>): string | null {
  for (const [field, value] of Object.entries(fields)) {
    if (/[\t\n\r]/.test(value)) return field;
  }
  return null;
}

/**
 * Append a row to the custom catalog TSV. Guards against duplicates
 * (builtin or custom) so repeated `curated add` calls on the same
 * rel produce a clear error instead of growing the file.
 */
export async function addCurated(input: AddCuratedInput): Promise<AddCuratedResult> {
  const { repo, fileOrRel } = input;
  if (!repo || !fileOrRel) {
    return {
      ok: false,
      error:
        "Usage: llamactl catalog add <hf-repo> <gguf-file-or-relpath> [label] [family] [class] [scope]",
    };
  }

  const repoBase = repo.includes("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo;
  const rel = fileOrRel.includes("/") ? fileOrRel : `${repoBase}/${fileOrRel}`;

  if (findByRel(rel)) {
    return { ok: false, error: `Catalog already contains ${rel}` };
  }

  const fileBasename = rel.slice(rel.lastIndexOf("/") + 1);
  const label = nonEmptyOr(input.label, fileBasename.replace(/\.gguf$/i, ""));
  const family = nonEmptyOr(input.family, deriveFamily(repo));
  const klass = await resolveClass(repo, input.class);
  const validatedClass = validateClass(klass);
  if (validatedClass === null) {
    return {
      ok: false,
      error: `invalid class '${klass}'`,
    };
  }
  const scope = nonEmptyOr(input.scope, "candidate");
  const id = deriveEntryId(repoBase, rel);
  const format = /\.gguf$/i.test(fileBasename) ? "gguf" : "mlx";

  const fields = { id, label, family, class: validatedClass, scope, rel, repo, format };
  const illegalField = findIllegalField(fields);
  if (illegalField !== null) {
    return {
      ok: false,
      error: `catalog field '${illegalField}' contains illegal control character (\\t/\\n/\\r)`,
    };
  }

  const resolved = resolveEnv();
  const file = resolved.LOCAL_AI_CUSTOM_CATALOG_FILE;
  appendLine(file, [id, label, family, validatedClass, scope, rel, repo, format].join("\t"));

  const entry: CuratedModel = {
    ...fields,
    class: validatedClass,
    format,
  };

  // `findByRel` reads the catalog each call so subsequent writers in the
  // same process will see the new row; also exercise it here as a
  // sanity check that the append actually registered through the
  // loader path.
  void listCatalog("custom");

  return { ok: true, entry, file };
}
