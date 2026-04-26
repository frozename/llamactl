import {
  curatedStatusForRepoFile,
  relFromRepoAndFile,
  repoKnown,
  type CuratedStatus,
} from './catalog.js';
import { resolveEnv } from './env.js';
import {
  fetchDiscoveryFeed,
  fetchModelInfo,
  fetchRepoTree,
  fileSizeFromTree,
  humanSize,
  mmprojFileForRepo,
} from './hf.js';
import { normalizeProfile } from './profile.js';
import { quantFromRel } from './quant.js';
import type { HFModelInfo } from './schemas.js';
import type { MachineProfile, ModelClass } from './types.js';

export type DiscoveryFilter =
  | 'all'
  | 'other'
  | 'new'
  | 'curated'
  | 'known'
  | 'reasoning'
  | 'multimodal'
  | 'general'
  | 'fits-16g'
  | 'fits-32g'
  | 'fits-48g'
  | (string & {});

export type DiscoveryFit = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export interface DiscoveryRow {
  fit: DiscoveryFit;
  fitScore: number;
  class: ModelClass;
  catalogStatus: CuratedStatus;
  repo: string;
  file: string;
  rel: string;
  quant: string;
  downloads: number;
  likes: number;
  updated: string;
  pipeline: string;
  estimatedSize: string;
  visionStatus: 'ready' | 'needs-mmproj' | 'text';
}

export interface DiscoveryResult {
  filter: DiscoveryFilter;
  profile: MachineProfile;
  author: string;
  limit: number;
  rows: DiscoveryRow[];
}

// ---- profile resolution ------------------------------------------------

/**
 * Pick the effective machine profile for discovery. `fits-*` filters
 * force their corresponding profile so "does this fit a 16 GiB Mac?"
 * always evaluates against the 16 GiB envelope even when called from a
 * bigger machine. Everything else honours the user's requested profile
 * (or falls back to the current environment).
 */
export function profileForDiscovery(
  filter: string | undefined,
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MachineProfile {
  switch (filter) {
    case 'fits-16g':
      return 'mac-mini-16g';
    case 'fits-32g':
      return 'balanced';
    case 'fits-48g':
      return 'macbook-pro-48g';
    default: {
      const resolved = resolveEnv(env);
      if (!requested || requested === 'current') {
        return (
          normalizeProfile(resolved.LLAMA_CPP_MACHINE_PROFILE) ?? 'macbook-pro-48g'
        );
      }
      return normalizeProfile(requested) ?? 'macbook-pro-48g';
    }
  }
}

// ---- classification ---------------------------------------------------

/**
 * Classify a repo into {multimodal, reasoning, general}. Mirrors
 * `_llama_discovery_classify_repo`: pipeline_tag=image-text-to-text
 * short-circuits to multimodal; otherwise tag substrings or repo-name
 * heuristics decide. Matching is case-insensitive everywhere.
 */
export function classifyRepo(
  repo: string,
  pipeline: string,
  tags: string,
): ModelClass {
  const repoL = repo.toLowerCase();
  const pipelineL = pipeline.toLowerCase();
  const tagsL = tags.toLowerCase();

  if (pipelineL === 'image-text-to-text') return 'multimodal';

  if (tagsL.includes('vision') || tagsL.includes('multimodal')) return 'multimodal';
  if (repoL.includes('gemma-4-')) return 'multimodal';

  if (
    tagsL.includes('reasoning') ||
    tagsL.includes('thinking') ||
    repoL.includes('deepseek') ||
    repoL.includes('qwq') ||
    repoL.includes('qwen') ||
    repoL.includes('r1')
  ) {
    return 'reasoning';
  }

  return 'general';
}

// ---- quant ladder -----------------------------------------------------

/**
 * Preference ladder used to pick a quant from an HF repo's sibling list.
 * Small-machine profiles prefer smaller quants; bigger machines jump
 * straight to UD-Q4_K_XL (the best all-rounder for plenty of RAM).
 * Matches `_llama_discovery_pick_file` in the shell.
 */
const QUANT_PREFS: Record<MachineProfile, readonly string[]> = {
  'mac-mini-16g': [
    'UD-Q3_K_S.gguf',
    'UD-Q3_K_M.gguf',
    'UD-Q4_K_M.gguf',
    'UD-Q4_K_XL.gguf',
    'Q4_K_M.gguf',
    'Q8_0.gguf',
    'UD-Q5_K_XL.gguf',
  ],
  balanced: [
    'UD-Q4_K_M.gguf',
    'UD-Q4_K_XL.gguf',
    'Q4_K_M.gguf',
    'UD-Q3_K_M.gguf',
    'Q8_0.gguf',
    'UD-Q5_K_XL.gguf',
  ],
  'macbook-pro-48g': [
    'UD-Q4_K_XL.gguf',
    'UD-Q5_K_XL.gguf',
    'UD-Q4_K_M.gguf',
    'Q4_K_M.gguf',
    'Q8_0.gguf',
    'UD-Q6_K_XL.gguf',
  ],
} as const;

/**
 * Pick the best-matching file from a list of GGUF sibling names for a
 * given profile. Walks the preference ladder top-to-bottom and returns
 * the first sibling whose name contains the current preference string.
 * Falls back to the first sibling in the list when nothing matches.
 */
export function pickFile(
  profile: MachineProfile,
  siblings: readonly string[],
): string | null {
  if (siblings.length === 0) return null;
  const prefs = QUANT_PREFS[profile];
  for (const pref of prefs) {
    const hit = siblings.find((s) => s.includes(pref));
    if (hit) return hit;
  }
  return siblings[0] ?? null;
}

/**
 * Extract the GGUF sibling names from an HF model-info that llamactl
 * considers usable: `.gguf` files that aren't mmproj sidecars, aren't
 * inside bf16/fp16/f16 subdirs, and aren't multi-part shards. Matches
 * the jq filter in the shell discovery feed loop.
 */
export function eligibleGgufSiblings(info: HFModelInfo): string[] {
  const siblings = info.siblings ?? [];
  const out: string[] = [];
  for (const sib of siblings) {
    const name = sib.rfilename;
    if (!/\.gguf$/i.test(name)) continue;
    if (name.toLowerCase().includes('mmproj')) continue;
    if (/(^|\/)(bf16|fp16|f16)\//i.test(name)) continue;
    if (/-\d{5}-of-\d{5}\.gguf$/i.test(name)) continue;
    out.push(name);
  }
  return out;
}

// ---- size + fit -------------------------------------------------------

/**
 * Estimate the on-disk footprint for a candidate: the picked quant's
 * size, plus the mmproj sidecar size when the repo is multimodal. Uses
 * the cached repo tree so the estimate is accurate to the byte on warm
 * HF data, and returns null when we can't determine a number (stale
 * cache miss, file absent from tree, etc.).
 */
export async function estimatedBytes(
  repo: string,
  file: string,
  klass: ModelClass,
): Promise<number | null> {
  const tree = await fetchRepoTree(repo);
  if (!tree) return null;
  const modelBytes = fileSizeFromTree(tree, file);
  if (modelBytes === null) return null;

  let total = modelBytes;
  if (klass === 'multimodal') {
    const info = await fetchModelInfo(repo);
    if (info) {
      const mmproj = mmprojFileForRepo(info);
      if (mmproj) {
        const mmprojBytes = fileSizeFromTree(tree, mmproj);
        if (mmprojBytes !== null) total += mmprojBytes;
      }
    }
  }
  return total;
}

const GIB = 1024 * 1024 * 1024;

const SIZE_TIERS: Record<MachineProfile, { excellent: number; good: number; fair: number }> = {
  'mac-mini-16g': { excellent: 8.5, good: 12.5, fair: 16.5 },
  balanced: { excellent: 20.0, good: 28.0, fair: 36.0 },
  'macbook-pro-48g': { excellent: 30.0, good: 42.0, fair: 52.0 },
};

function sizeFit(gib: number, profile: MachineProfile): DiscoveryFit {
  const t = SIZE_TIERS[profile];
  if (gib <= t.excellent) return 'excellent';
  if (gib <= t.good) return 'good';
  if (gib <= t.fair) return 'fair';
  return 'poor';
}

function quantFallbackFit(file: string): DiscoveryFit {
  const f = file;
  if (/Q2|Q3_K_S|Q3_K_M/.test(f)) return 'good';
  if (/Q4_K_M|UD-Q4_K_M|UD-Q4_K_XL/.test(f)) return 'excellent';
  if (/Q5|Q6/.test(f)) return 'good';
  if (/Q8_0/.test(f)) return 'fair';
  return 'fair';
}

/**
 * Apply the repo-name + quant overrides the shell layers on top of the
 * size-tier baseline. Keeps unusual combinations honest: a Q2 on a
 * mac-mini is upgraded to `excellent`, a 70B+ on anything smaller than
 * the 48 GiB machine is clamped to `poor`.
 */
function applyRepoQuantOverrides(
  base: DiscoveryFit,
  profile: MachineProfile,
  repoL: string,
  file: string,
): DiscoveryFit {
  let fit = base;

  switch (profile) {
    case 'mac-mini-16g': {
      if (/Q2|Q3_K_S|Q3_K_M/.test(file)) fit = 'excellent';
      else if (/Q4_K_M|UD-Q4_K_M|UD-Q4_K_XL/.test(file)) fit = 'good';
      else if (/Q8_0/.test(file)) fit = 'fair';
      if (/35b-a3b|31b|27b|26b/.test(repoL)) {
        fit = /Q2|Q3_K_S|Q3_K_M/.test(file) ? 'good' : 'poor';
      } else if (/671b|405b|123b|120b|72b|70b|v3|v4/.test(repoL)) {
        fit = 'poor';
      }
      break;
    }
    case 'balanced': {
      if (/Q2/.test(file)) fit = 'fair';
      else if (/Q3_K_S|Q3_K_M/.test(file)) fit = 'good';
      else if (/Q4_K_M|UD-Q4_K_M|UD-Q4_K_XL/.test(file)) fit = 'excellent';
      if (/671b|405b|123b|120b|72b|70b/.test(repoL)) fit = 'poor';
      break;
    }
    default: {
      if (/671b|405b|123b|120b/.test(repoL)) fit = 'poor';
    }
  }

  return fit;
}

/**
 * Final fit heuristic. Combines (a) size-tier classification when the
 * repo tree yielded a real byte count, (b) a quant-pattern fallback
 * when we can't compute bytes, (c) per-profile repo overrides, and
 * (d) a hard clamp on known-too-big multimodal/deepseek families.
 */
export async function discoveryFit(
  profile: MachineProfile,
  repo: string,
  klass: ModelClass,
  file: string,
): Promise<DiscoveryFit> {
  if (!file) return 'unknown';

  let fit: DiscoveryFit = 'unknown';
  const bytes = await estimatedBytes(repo, file, klass);
  if (bytes !== null) {
    fit = sizeFit(bytes / GIB, profile);
  } else {
    fit = quantFallbackFit(file);
  }

  const repoL = repo.toLowerCase();
  fit = applyRepoQuantOverrides(fit, profile, repoL, file);

  if (
    (klass === 'reasoning' && (/deepseek-v3/.test(repoL) || /deepseek-v4/.test(repoL))) ||
    (klass === 'multimodal' && (/72b/.test(repoL) || /70b/.test(repoL)))
  ) {
    fit = 'poor';
  }

  return fit;
}

export function fitScore(fit: DiscoveryFit): number {
  switch (fit) {
    case 'excellent':
      return 5;
    case 'good':
      return 4;
    case 'fair':
      return 3;
    case 'poor':
      return 2;
    default:
      return 1;
  }
}

// ---- filter semantics -------------------------------------------------

/**
 * Decide whether a (class, repo, fit) triple matches the requested
 * discovery filter. Mirrors `_llama_discovery_filter_matches` exactly,
 * including the fallthrough that accepts any filter value appearing in
 * the class or repo path.
 */
export function filterMatches(
  filter: string,
  klass: ModelClass,
  repo: string,
  fit: DiscoveryFit,
): boolean {
  switch (filter) {
    case 'all':
    case '':
      return true;
    case 'other':
    case 'new':
      return !repoKnown(repo);
    case 'curated':
    case 'known':
      return repoKnown(repo);
    case 'reasoning':
    case 'multimodal':
    case 'general':
      return klass === filter;
    case 'fits-16g':
    case 'fits-32g':
    case 'fits-48g':
      return fit === 'excellent' || fit === 'good';
    default: {
      if (klass === filter) return true;
      // Real HF repo names are mixed-case (`unsloth/Qwen3.6-27B-GGUF`);
      // operators type lowercase filters (`discover qwen3`). Lowercase
      // both sides so the substring fallthrough catches the natural
      // case-insensitive intent. Class equality above stays exact since
      // both sides come from the same internal vocabulary.
      return repo.toLowerCase().includes(filter.toLowerCase());
    }
  }
}

// ---- top-level orchestrator -------------------------------------------

export interface DiscoverOptions {
  filter?: string;
  requestedProfile?: string;
  limit?: number;
  author?: string;
  search?: string;
}

/**
 * Run a full discovery pass: fetch the feed, classify + pick + fit for
 * each repo, filter, and return the rows sorted the same way the shell
 * does (fit_score desc, downloads desc, repo asc). Consumers (CLI,
 * Electron tRPC) format the rows how they wish.
 */
export async function discover(
  opts: DiscoverOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveryResult | null> {
  const resolved = resolveEnv(env);
  const filter = opts.filter ?? 'other';
  const profile = profileForDiscovery(filter, opts.requestedProfile, env);
  const author = opts.author ?? resolved.LOCAL_AI_DISCOVERY_AUTHOR;
  const parsedLimit = Number.parseInt(resolved.LOCAL_AI_DISCOVERY_LIMIT, 10);
  const limit =
    opts.limit ?? (Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 24);
  const search = opts.search ?? resolved.LOCAL_AI_DISCOVERY_SEARCH;

  const feed = await fetchDiscoveryFeed({ author, limit, search }, resolved, env);
  if (!feed) return null;

  const rows: DiscoveryRow[] = [];
  for (const repoInfo of feed) {
    const repo = repoInfo.id;
    if (!repo) continue;
    const siblings = eligibleGgufSiblings(repoInfo);
    if (siblings.length === 0) continue;

    const pipeline = repoInfo.pipeline_tag ?? repoInfo.pipelineTag ?? '';
    const tags = (repoInfo.tags ?? []).join('|');
    const klass = classifyRepo(repo, pipeline, tags);
    const file = pickFile(profile, siblings);
    if (!file) continue;
    const rel = relFromRepoAndFile(repo, file);
    const fit = await discoveryFit(profile, repo, klass, file);
    if (!filterMatches(filter, klass, repo, fit)) continue;

    const bytes = await estimatedBytes(repo, file, klass);
    const info = await fetchModelInfo(repo, resolved, env);
    const mmproj = info ? mmprojFileForRepo(info) : null;
    const visionStatus: DiscoveryRow['visionStatus'] =
      klass === 'multimodal' ? (mmproj ? 'ready' : 'needs-mmproj') : 'text';

    rows.push({
      fit,
      fitScore: fitScore(fit),
      class: klass,
      catalogStatus: curatedStatusForRepoFile(repo, file),
      repo,
      file,
      rel,
      quant: quantFromRel(rel),
      downloads: repoInfo.downloads ?? 0,
      likes: repoInfo.likes ?? 0,
      updated: repoInfo.lastModified ?? '',
      pipeline: pipeline || 'n/a',
      estimatedSize: humanSize(bytes),
      visionStatus,
    });
  }

  rows.sort((a, b) => {
    if (b.fitScore !== a.fitScore) return b.fitScore - a.fitScore;
    if (b.downloads !== a.downloads) return b.downloads - a.downloads;
    return a.repo.localeCompare(b.repo);
  });

  return { filter, profile, author, limit, rows };
}
