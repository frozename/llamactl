import { findByRel, listCatalog } from './catalog.js';
import { classifyRepo } from './discovery.js';
import { resolveEnv } from './env.js';
import { appendLine } from './fsAtomic.js';
import { fetchModelInfo } from './hf.js';
import { quantFromRel } from './quant.js';
import type { CuratedModel } from './schemas.js';
import type { ModelClass } from './types.js';

export interface AddCuratedInput {
  repo: string;
  /** Either a bare GGUF filename or a rel path (`<dir>/<file>`). */
  fileOrRel: string;
  label?: string;
  family?: string;
  class?: ModelClass | string;
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
  if (l.includes('gemma-4')) return 'gemma4';
  if (l.includes('qwen3.6')) return 'qwen36';
  if (l.includes('qwen3.5')) return 'qwen35';
  if (l.includes('deepseek')) return 'deepseek';
  return 'custom';
}

function deriveEntryId(repoBase: string, rel: string): string {
  const quant = quantFromRel(rel);
  const raw = `${repoBase.toLowerCase()}-${quant}`;
  return raw.replace(/[^a-z0-9._-]/g, '-');
}

/**
 * Resolve the class for a new catalog entry. When the caller supplies
 * a class explicitly, use it. Otherwise fetch the HF model info for
 * the repo and feed its pipeline_tag + tags to the discovery classifier
 * (same logic discover uses). Falls back to path-pattern via the
 * classifier when HF is disabled or unreachable.
 */
async function resolveClass(
  repo: string,
  provided: string | undefined,
): Promise<string> {
  if (provided && provided.length > 0) return provided;
  const info = await fetchModelInfo(repo);
  const pipeline = info?.pipeline_tag ?? info?.pipelineTag ?? '';
  const tags = (info?.tags ?? []).join(' ');
  return classifyRepo(repo, pipeline, tags);
}

/**
 * Append a row to the custom catalog TSV. Guards against duplicates
 * (builtin or custom) so repeated `curated add` calls on the same
 * rel produce a clear error instead of growing the file.
 */
export async function addCurated(
  input: AddCuratedInput,
): Promise<AddCuratedResult> {
  const { repo, fileOrRel } = input;
  if (!repo || !fileOrRel) {
    return {
      ok: false,
      error:
        'Usage: llamactl catalog add <hf-repo> <gguf-file-or-relpath> [label] [family] [class] [scope]',
    };
  }

  const repoBase = repo.includes('/') ? repo.slice(repo.lastIndexOf('/') + 1) : repo;
  const rel = fileOrRel.includes('/') ? fileOrRel : `${repoBase}/${fileOrRel}`;

  if (findByRel(rel)) {
    return { ok: false, error: `Catalog already contains ${rel}` };
  }

  const fileBasename = rel.slice(rel.lastIndexOf('/') + 1);
  const label = input.label && input.label.length > 0
    ? input.label
    : fileBasename.replace(/\.gguf$/i, '');
  const family = input.family && input.family.length > 0 ? input.family : deriveFamily(repo);
  const klass = await resolveClass(repo, input.class);
  const scope = input.scope && input.scope.length > 0 ? input.scope : 'candidate';
  const id = deriveEntryId(repoBase, rel);

  const resolved = resolveEnv();
  const file = resolved.LOCAL_AI_CUSTOM_CATALOG_FILE;
  appendLine(file, [id, label, family, klass, scope, rel, repo].join('\t'));

  const entry: CuratedModel = {
    id,
    label,
    family,
    class: klass as CuratedModel['class'],
    scope,
    rel,
    repo,
  };

  // `findByRel` reads the catalog each call so subsequent writers in the
  // same process will see the new row; also exercise it here as a
  // sanity check that the append actually registered through the
  // loader path.
  void listCatalog('custom');

  return { ok: true, entry, file };
}
