import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findByRel } from './catalog.js';
import { addCurated } from './catalogWriter.js';
import { resolveEnv } from './env.js';
import type { ResolvedEnv } from './types.js';

/**
 * Candidate LM Studio installation roots, probed in order. Mirrors
 * the layout the LM Studio macOS app uses by default, plus an
 * override so power users can point at a non-default install.
 *
 * Under a hermetic `$LLAMACTL_TEST_PROFILE` the probe is narrowed
 * to a profile-scoped directory so audits don't read the operator's
 * real LM Studio tree. We intentionally do NOT add LMSTUDIO to the
 * resolver's test-profile cascade in `env.ts` — that cascade is
 * owned by production-observed vars and widening it has a larger
 * blast radius. This fallback stays local to `lmstudio.ts`. The
 * profile-scoped dir is created by `env.ensureDirs` (Fix 1 seeds
 * it at Electron startup) so no duplicate `mkdir` here.
 */
function defaultRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.LMSTUDIO_MODELS_DIR;
  const candidates: string[] = [];
  if (override) candidates.push(override);
  const testProfile = env.LLAMACTL_TEST_PROFILE?.trim();
  if (testProfile) {
    candidates.push(join(testProfile, 'ai-models/lmstudio'));
    return candidates;
  }
  const home = homedir();
  candidates.push(join(home, '.lmstudio', 'models'));
  candidates.push(join(home, '.cache', 'lm-studio', 'models'));
  return candidates;
}

export function detectLMStudioRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const candidate of defaultRoots(env)) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

export interface LMStudioModel {
  /** Absolute path to the .gguf file. */
  path: string;
  /** Path inside the LM Studio root (publisher/repo/.../file.gguf). */
  relativePath: string;
  /** Publisher segment (first directory under the root). */
  publisher: string;
  /**
   * Repo id in `<publisher>/<repo>` form, matching the HF convention
   * LM Studio mirrors for GGUF models pulled via the UI. May be
   * `unknown/<repo>` when the LM Studio tree is shallower than
   * expected.
   */
  repo: string;
  /** Basename of the GGUF file. */
  file: string;
  /**
   * Rel path under `$LLAMA_CPP_MODELS` that an import would land at:
   * `<repo-basename>/<file>`. Consistent with `relFromRepoAndFile`.
   */
  rel: string;
  sizeBytes: number;
}

function gguf(name: string): boolean {
  return /\.gguf$/i.test(name);
}

function toRepo(publisher: string, second: string): string {
  if (!publisher || publisher === '.' || publisher === '..') {
    return `unknown/${second || 'model'}`;
  }
  if (!second) return `${publisher}/unknown`;
  return `${publisher}/${second}`;
}

/**
 * Walk an LM Studio models root, returning every GGUF file it finds.
 * Stops descending after four levels to avoid runaway scans on custom
 * symlink farms; matches the observed layout depth.
 */
function walkForGguf(
  root: string,
  relative: string,
  depth: number,
  acc: LMStudioModel[],
): void {
  if (depth > 6) return;
  let entries: string[];
  try {
    entries = readdirSync(join(root, relative));
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, relative, name);
    const nextRel = relative ? `${relative}/${name}` : name;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkForGguf(root, nextRel, depth + 1, acc);
      continue;
    }
    if (!st.isFile()) continue;
    if (!gguf(name)) continue;

    const parts = nextRel.split('/');
    const publisher = parts[0] ?? 'unknown';
    const second = parts[1] ?? '';
    const repo = toRepo(publisher, second);
    const repoBase = repo.slice(repo.lastIndexOf('/') + 1);
    acc.push({
      path: full,
      relativePath: nextRel,
      publisher,
      repo,
      file: name,
      rel: `${repoBase}/${name}`,
      sizeBytes: st.size,
    });
  }
}

export interface ScanOptions {
  /** Override LM Studio models directory (bypasses auto-detection). */
  root?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ScanResult {
  root: string | null;
  models: LMStudioModel[];
}

/**
 * Scan the LM Studio models tree for GGUF files. Returns `root=null`
 * with an empty list when no LM Studio install is detected and no
 * explicit root was supplied.
 */
export function scanLMStudio(opts: ScanOptions = {}): ScanResult {
  const env = opts.env ?? process.env;
  const root = opts.root ?? detectLMStudioRoot(env);
  if (!root) return { root: null, models: [] };
  if (!existsSync(root)) return { root, models: [] };
  const models: LMStudioModel[] = [];
  walkForGguf(root, '', 0, models);
  // Deterministic order for tests and UI listings.
  models.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { root, models };
}

export type ImportAction =
  | 'skip-already-catalogued'
  | 'skip-target-exists'
  | 'link-and-add'
  | 'add';

export interface ImportPlanItem {
  source: LMStudioModel;
  rel: string;
  targetPath: string;
  action: ImportAction;
  reason?: string;
}

export interface ImportPlan {
  root: string | null;
  items: ImportPlanItem[];
}

function planItem(
  model: LMStudioModel,
  resolved: ResolvedEnv,
  link: boolean,
): ImportPlanItem {
  const targetPath = join(resolved.LLAMA_CPP_MODELS, model.rel);
  if (findByRel(model.rel)) {
    return {
      source: model,
      rel: model.rel,
      targetPath,
      action: 'skip-already-catalogued',
      reason: 'Catalog already contains this rel',
    };
  }
  if (link && existsSync(targetPath)) {
    return {
      source: model,
      rel: model.rel,
      targetPath,
      action: 'skip-target-exists',
      reason: `Target path already exists: ${targetPath}`,
    };
  }
  return {
    source: model,
    rel: model.rel,
    targetPath,
    action: link ? 'link-and-add' : 'add',
  };
}

export interface ImportOptions extends ScanOptions {
  /** Materialize catalog entries + optional symlinks. Defaults to false. */
  apply?: boolean;
  /**
   * When applying, create a symlink at `$LLAMA_CPP_MODELS/<rel>`
   * pointing at the LM Studio file so existing llamactl reads work
   * without copying. Defaults to true when `apply` is set.
   */
  link?: boolean;
  resolved?: ResolvedEnv;
}

export function planImport(opts: ImportOptions = {}): ImportPlan {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);
  const scan = scanLMStudio({ root: opts.root, env });
  const link = opts.link ?? true;
  const items = scan.models.map((m) => planItem(m, resolved, link));
  return { root: scan.root, items };
}

export interface ImportResult {
  root: string | null;
  applied: Array<{ rel: string; action: Extract<ImportAction, 'link-and-add' | 'add'> }>;
  skipped: Array<{ rel: string; action: Exclude<ImportAction, 'link-and-add' | 'add'>; reason: string }>;
  errors: Array<{ rel: string; error: string }>;
}

/**
 * Materialize the plan: for each `link-and-add` item, symlink the
 * LM Studio .gguf into `$LLAMA_CPP_MODELS/<rel>`; for `add`, leave
 * the file alone and just register the catalog row. Curated adds
 * are scope=`custom` so they don't auto-evict on `uninstall` without
 * --force.
 */
export async function applyImport(
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);
  const plan = planImport({ ...opts, resolved, env });
  const result: ImportResult = {
    root: plan.root,
    applied: [],
    skipped: [],
    errors: [],
  };

  for (const item of plan.items) {
    if (item.action === 'skip-already-catalogued' || item.action === 'skip-target-exists') {
      result.skipped.push({
        rel: item.rel,
        action: item.action,
        reason: item.reason ?? 'skipped',
      });
      continue;
    }

    if (item.action === 'link-and-add') {
      try {
        mkdirSync(join(resolved.LLAMA_CPP_MODELS, item.rel.split('/')[0] ?? ''), {
          recursive: true,
        });
        if (existsSync(item.targetPath)) {
          // A stale symlink might linger from a previous run; refuse to clobber
          // real files but clean up broken links.
          try {
            const st = statSync(item.targetPath);
            if (!st.isFile()) unlinkSync(item.targetPath);
          } catch {
            // Broken symlink → drop it so we can replace cleanly.
            try {
              unlinkSync(item.targetPath);
            } catch {
              // ignore
            }
          }
        }
        symlinkSync(item.source.path, item.targetPath);
      } catch (err) {
        result.errors.push({
          rel: item.rel,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const add = await addCurated({
      repo: item.source.repo,
      fileOrRel: item.source.file,
      scope: 'custom',
    });
    if (!add.ok) {
      result.errors.push({ rel: item.rel, error: add.error });
      continue;
    }
    result.applied.push({ rel: item.rel, action: item.action });
  }

  return result;
}
