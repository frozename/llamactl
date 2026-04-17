import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { findByRel } from './catalog.js';
import { resolveEnv } from './env.js';
import type {
  HFDiscoveryFeed,
  HFModelInfo,
  HFModelSibling,
  HFTree,
} from './schemas.js';

const DEFAULT_TTL_SECONDS = 43_200; // 12h

/**
 * Whether HF network access is allowed. Mirrors the historical shell
 * toggle: any of `off / none / local / false / FALSE / 0` disables
 * HF lookups and downstream helpers degrade to local-only behaviour.
 */
export function hfEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.LOCAL_AI_RECOMMENDATIONS_SOURCE ?? 'hf';
  switch (raw) {
    case 'off':
    case 'none':
    case 'local':
    case 'false':
    case 'FALSE':
    case '0':
      return false;
    default:
      return true;
  }
}

export function cacheTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LOCAL_AI_HF_CACHE_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

function sanitizeRepo(repo: string): string {
  return repo.replace(/\//g, '__');
}

function sanitizeSearch(search: string): string {
  return search.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function modelInfoCacheFile(runtimeDir: string, repo: string): string {
  return join(runtimeDir, `hf-model-info-${sanitizeRepo(repo)}.json`);
}

export function repoTreeCacheFile(runtimeDir: string, repo: string): string {
  return join(runtimeDir, `hf-tree-${sanitizeRepo(repo)}.json`);
}

export function discoveryCacheFile(
  runtimeDir: string,
  author: string,
  limit: number,
  search: string,
): string {
  const safeKey = `${sanitizeRepo(author)}-${sanitizeSearch(search)}-${limit}`;
  return join(runtimeDir, `hf-discovery-${safeKey}.json`);
}

function isCacheFresh(file: string, ttlSeconds: number): boolean {
  try {
    const st = statSync(file);
    const now = Math.floor(Date.now() / 1000);
    const mtime = Math.floor(st.mtimeMs / 1000);
    return now - mtime < ttlSeconds;
  } catch {
    return false;
  }
}

function readJsonFile<T>(file: string): T | null {
  try {
    const raw = readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Write a JSON document to disk atomically via a tmp file + rename.
 * Keeps readers from seeing partially-written cache entries when a
 * second CLI invocation races against a refresh.
 */
function writeJsonFile(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(tmpdir(), `llamactl-hf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

interface FetchWithCacheOpts {
  url: string;
  cacheFile: string;
  ttlSeconds: number;
}

/**
 * Fetch a JSON document, backed by an on-disk cache. Behaviour mirrors
 * the shell helpers byte-for-byte:
 *   1. If the cache file exists and is within the TTL, return it.
 *   2. Otherwise try the live fetch; on success, cache atomically and
 *      return the new payload.
 *   3. On network failure, fall back to the stale cache if present —
 *      offline use of llamactl should not degrade silently beyond "the
 *      numbers are a bit old".
 * Returns null when HF is disabled, the network failed, AND no cache
 * entry exists at all.
 */
async function fetchWithCache(opts: FetchWithCacheOpts): Promise<string | null> {
  const { url, cacheFile, ttlSeconds } = opts;

  if (isCacheFresh(cacheFile, ttlSeconds)) {
    const cached = readJsonFile<unknown>(cacheFile);
    if (cached !== null) return JSON.stringify(cached);
  }

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'llamactl' },
    });
    if (res.ok) {
      const body = await res.text();
      writeJsonFile(cacheFile, body);
      return body;
    }
  } catch {
    // network failure — fall through to stale cache below
  }

  const stale = readJsonFile<unknown>(cacheFile);
  return stale === null ? null : JSON.stringify(stale);
}

/** Fetch (or return cached) HF model-info for a repo. */
export async function fetchModelInfo(
  repo: string,
  resolved = resolveEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<HFModelInfo | null> {
  if (!hfEnabled(env)) return null;
  const cacheFile = modelInfoCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, repo);
  const body = await fetchWithCache({
    url: `https://huggingface.co/api/models/${repo}`,
    cacheFile,
    ttlSeconds: cacheTtlSeconds(env),
  });
  if (!body) return null;
  try {
    return JSON.parse(body) as HFModelInfo;
  } catch {
    return null;
  }
}

/** Fetch (or return cached) HF repo tree at `main`, recursive + expanded. */
export async function fetchRepoTree(
  repo: string,
  resolved = resolveEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<HFTree | null> {
  if (!hfEnabled(env)) return null;
  const cacheFile = repoTreeCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, repo);
  const body = await fetchWithCache({
    url: `https://huggingface.co/api/models/${repo}/tree/main?recursive=1&expand=1`,
    cacheFile,
    ttlSeconds: cacheTtlSeconds(env),
  });
  if (!body) return null;
  try {
    return JSON.parse(body) as HFTree;
  } catch {
    return null;
  }
}

export interface DiscoveryOptions {
  author?: string;
  limit?: number;
  search?: string;
}

/** Fetch (or return cached) HF discovery feed for an author. */
export async function fetchDiscoveryFeed(
  opts: DiscoveryOptions = {},
  resolved = resolveEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<HFDiscoveryFeed | null> {
  if (!hfEnabled(env)) return null;
  const author = opts.author ?? resolved.LOCAL_AI_DISCOVERY_AUTHOR;
  const parsedLimit = Number.parseInt(resolved.LOCAL_AI_DISCOVERY_LIMIT, 10);
  const limit = opts.limit ?? (Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 24);
  const search = opts.search ?? resolved.LOCAL_AI_DISCOVERY_SEARCH;
  const cacheFile = discoveryCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, author, limit, search);
  const body = await fetchWithCache({
    url: `https://huggingface.co/api/models?author=${encodeURIComponent(author)}&search=${encodeURIComponent(search)}&sort=downloads&direction=-1&limit=${limit}&full=true`,
    cacheFile,
    ttlSeconds: cacheTtlSeconds(env),
  });
  if (!body) return null;
  try {
    return JSON.parse(body) as HFDiscoveryFeed;
  } catch {
    return null;
  }
}

// ---- helpers over HF payloads ------------------------------------------

/**
 * Find the first mmproj sibling file on a repo. Case-insensitive match
 * on `mmproj.*\.gguf$`. Returns null when the repo has no projector —
 * consumers use that as the signal that the model is text-only.
 */
export function mmprojFileForRepo(info: HFModelInfo): string | null {
  const siblings = info.siblings ?? [];
  for (const s of siblings) {
    if (/mmproj.*\.gguf$/i.test(s.rfilename)) return s.rfilename;
  }
  return null;
}

/**
 * Find a sibling entry by filename. `file` may be the bare filename
 * (in which case any sibling whose rfilename equals it or ends in
 * `/<file>` matches) or a full repo-relative path.
 */
export function siblingForFile(
  info: HFModelInfo,
  file: string,
): HFModelSibling | null {
  const siblings = info.siblings ?? [];
  const exactSlash = file.includes('/');
  for (const s of siblings) {
    if (s.rfilename === file) return s;
    if (!exactSlash && s.rfilename.endsWith(`/${file}`)) return s;
  }
  return null;
}

/**
 * Look up a file's size from a repo tree, preferring the LFS size when
 * present (llama.cpp GGUFs are typically LFS-stored and `size` on the
 * tree entry reflects the pointer file, not the real blob).
 */
export function fileSizeFromTree(tree: HFTree, file: string): number | null {
  const exactSlash = file.includes('/');
  for (const entry of tree) {
    const matches = exactSlash
      ? entry.path === file
      : entry.path === file || entry.path.endsWith(`/${file}`);
    if (!matches) continue;
    const size = entry.lfs?.size ?? entry.size;
    if (typeof size === 'number' && Number.isFinite(size)) return size;
  }
  return null;
}

/**
 * Human-readable size formatter, matching the shell awk helper:
 *   - `null` / `undefined` are coerced to 0 (mirroring the shell's
 *     `${1:-0}` default) and render as `0 B`. The only `n/a` result is
 *     for genuinely non-numeric inputs like `NaN`.
 *   - integer for bytes
 *   - one decimal for KiB / MiB / GiB / TiB
 */
export function humanSize(bytes: number | null | undefined): string {
  const n = bytes === null || bytes === undefined ? 0 : bytes;
  if (!Number.isFinite(n)) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  if (i === 0) return `${Math.trunc(x)} ${units[i]}`;
  return `${x.toFixed(1)} ${units[i]}`;
}

/** Look up the HF repo id for a rel, via the catalog. */
export function repoForRel(rel: string): string | null {
  return findByRel(rel)?.repo ?? null;
}

/**
 * Resolve an argument that may already be a repo id (`<user>/<name>`)
 * or a rel path. Matches `_llama_hf_repo_for_rel_or_repo` in the shell.
 * Returns null when no catalog entry covers the input.
 */
export function repoForRelOrRepo(relOrRepo: string): string | null {
  if (relOrRepo.includes('/') && !relOrRepo.endsWith('.gguf')) return relOrRepo;
  return repoForRel(relOrRepo);
}

/**
 * Emit the `repo=... downloads=... likes=... updated=... task=... file=...`
 * summary line for a rel, matching the historical shell helper. Returns
 * null when no catalog entry exists or HF is unreachable and nothing is
 * cached.
 */
export async function summaryForRel(
  rel: string,
  resolved = resolveEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const repo = repoForRel(rel);
  if (!repo) return null;
  const info = await fetchModelInfo(repo, resolved, env);
  if (!info) return null;

  const fileName = rel.split('/').pop() ?? rel;
  const downloads = info.downloads ?? 'n/a';
  const likes = info.likes ?? 'n/a';
  const updated = info.lastModified ?? 'n/a';
  const pipeline = info.pipeline_tag ?? info.pipelineTag ?? 'n/a';
  return `repo=${repo} downloads=${downloads} likes=${likes} updated=${updated} task=${pipeline} file=${fileName}`;
}
