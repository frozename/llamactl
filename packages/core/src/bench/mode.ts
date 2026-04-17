import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findByRel } from '../catalog.js';
import { resolveEnv } from '../env.js';
import { findLocalMmproj } from '../mmproj.js';
import type { BenchMode } from '../types.js';

/**
 * Pick the bench mode label for a rel. Used to key bench records and
 * to guide which bench flow (text-throughput vs vision-path) runs.
 *
 * Phase 1 port omits the HF-backed layer — the shell helper consults
 * the repo's pipeline_tag to upgrade unknown rels to `vision`. That
 * path lands alongside the HF module in a later batch. For now:
 *
 *   1. `Qwen3.5-27B-GGUF/*` is locked to `text` (no mmproj, MoE).
 *   2. If the model file exists locally and has an `mmproj*` sibling,
 *      the label is `vision`.
 *   3. Catalog lookup: class `multimodal` -> vision, anything else -> text.
 *   4. Fallback: `text`.
 *
 * For installed models (the common bench-show case) step 2 is
 * decisive. For uninstalled rels the catalog fallback is the best we
 * can do without network; when HF wires in, that layer slots between
 * (2) and (3).
 */
export function defaultModeForRel(
  rel: string,
  resolved = resolveEnv(),
): BenchMode {
  if (/^Qwen3\.5-27B-GGUF\//.test(rel)) return 'text';

  const modelPath = join(resolved.LLAMA_CPP_MODELS, rel);
  if (existsSync(modelPath)) {
    const sep = rel.lastIndexOf('/');
    if (sep >= 0) {
      const modelDir = join(resolved.LLAMA_CPP_MODELS, rel.slice(0, sep));
      if (findLocalMmproj(modelDir)) return 'vision';
    }
  }

  const entry = findByRel(rel);
  if (entry?.class === 'multimodal') return 'vision';

  return 'text';
}

/**
 * Normalised machine label used in bench records. The shell helper
 * uses `_local_ai_profile_name` which collapses user aliases down to
 * one of the three canonical values; the TS version pulls the already
 * resolved env variable, which went through the same normalisation.
 */
export function machineLabel(resolved = resolveEnv()): string {
  return resolved.LLAMA_CPP_MACHINE_PROFILE;
}
