/**
 * Natural-language → RagPipeline YAML scaffolder. The goal is to save
 * an operator the five minutes of staring at the schema reference when
 * they say "crawl example.com into kb-pg" — not to be a magic LLM
 * stand-in. The drafter is intentionally deterministic:
 *
 *   - Extract every URL and filesystem path from the description.
 *   - Map URLs → `http` sources, paths → `filesystem` sources.
 *   - Infer the pipeline name from the first recognized source.
 *   - Default to markdown-aware chunking with conservative sizes.
 *   - Infer `schedule:` from "@daily"/"daily"/"hourly"/"weekly"/"every N{m,h,d}".
 *   - Target rag node: first token matching a caller-provided
 *     availableRagNodes list, else the explicit `--node` override,
 *     else `"kb-pg"` as the conventional llamactl default.
 *
 * The output is a schema-valid manifest plus a warnings list that
 * surfaces anything the draft *couldn't* confidently fill in — that
 * list is the UI hook for "you probably want to tweak X before
 * applying."
 *
 * This file does not call out to an LLM. Callers that want LLM-aware
 * drafting layer it on top: they can feed the NL through whatever
 * planner they like, then pass the result here to get schema
 * validation + warnings for free.
 */

import { stringify as stringifyYaml } from 'yaml';

import {
  RagPipelineManifestSchema,
  type RagPipelineManifest,
  type SourceSpec,
} from './schema.js';

export interface DraftContext {
  /**
   * RAG nodes the operator can target. The drafter picks the first
   * one whose name appears as a bare word in the description; if none
   * matches, it falls back to `defaultRagNode` (below) and emits a
   * warning so the UI surfaces the ambiguity.
   */
  availableRagNodes?: string[];
  /** Used when no rag node name was found in the description. */
  defaultRagNode?: string;
  /** Caller-supplied override for the pipeline name. */
  nameOverride?: string;
}

export interface DraftResult {
  yaml: string;
  manifest: RagPipelineManifest;
  warnings: string[];
}

const URL_RE = /\b(https?:\/\/[^\s"'<>`]+)/g;
// GitHub / GitLab / Gitea: any https URL ending in `.git`, or a bare
// `git@host:org/repo.git` SSH remote. Matches are narrower than the
// general URL_RE so a plain https link to a docs site doesn't become
// a git source.
const GIT_URL_RE = /\b(https?:\/\/[^\s"'<>`]+\.git|git@[\w.-]+:[^\s"'<>`]+\.git)/g;
// Loose "looks like a path" heuristic: leading `/`, `./`, `~/`, or a
// drive-letter. Windows-style backslashes are intentionally ignored
// — llamactl is macOS/Linux-first and `~\foo\bar` would be far more
// likely to be nonsense in a description than a real path.
const PATH_RE = /(?:^|\s)([~./][\w./-]+|\/[\w./-]+)/g;
const SCHEDULE_ALIAS_RE = /@(hourly|daily|weekly)\b/i;
const SCHEDULE_EVERY_RE = /\bevery\s+(\d+)\s*(minutes?|m|hours?|h|days?|d)\b/i;
const COLLECTION_RE = /\bcollection\s+[`"']?([\w-]+)[`"']?/i;

const DEFAULT_RAG_NODE = 'kb-pg';

export function draftPipeline(
  description: string,
  ctx: DraftContext = {},
): DraftResult {
  const warnings: string[] = [];
  const desc = (description ?? '').trim();
  if (desc.length === 0) {
    warnings.push('description was empty — draft is a bare skeleton');
  }

  const gitUrls = uniq(matchAll(desc, GIT_URL_RE));
  const allUrls = uniq(matchAll(desc, URL_RE));
  // Any URL that's also a git URL gets routed to the git fetcher
  // only — otherwise a `.git` URL would get double-emitted as both
  // http (crawl) and git (clone). The bare SSH form never matches
  // URL_RE (no scheme) so we treat it as git-only by construction.
  const gitUrlSet = new Set(gitUrls);
  const httpUrls = allUrls.filter((u) => !gitUrlSet.has(u));
  const paths = uniq(matchAll(desc, PATH_RE));

  const sources: SourceSpec[] = [];
  for (const repo of gitUrls) {
    sources.push({
      kind: 'git',
      repo,
      glob: '**/*.md',
    });
  }
  for (const url of httpUrls) {
    sources.push({
      kind: 'http',
      url,
      max_depth: 2,
      same_origin: true,
      ignore_robots: false,
      rate_limit_per_sec: 2,
      timeout_ms: 10_000,
    });
  }
  for (const root of paths) {
    sources.push({
      kind: 'filesystem',
      root,
      glob: '**/*.md',
    });
  }
  if (sources.length === 0) {
    // Placeholder the operator must replace — we still emit a
    // filesystem source so the manifest parses through the schema.
    sources.push({ kind: 'filesystem', root: '/path/to/docs', glob: '**/*.md' });
    warnings.push(
      'no URL or filesystem path found in description — added a placeholder filesystem source',
    );
  }

  const ragNode = pickRagNode(desc, ctx, warnings);
  // Collection / name inference considers every source URL (git or
  // http) plus filesystem paths — git clone URLs produce a cleaner
  // inferred name (`pytorch-docs` from `.../pytorch/docs.git`) than
  // a plain docs-site URL.
  const unifiedUrls = [...gitUrls, ...httpUrls];
  const collection = pickCollection(desc, unifiedUrls, paths, warnings);
  const name = ctx.nameOverride?.trim() || inferName(desc, unifiedUrls, paths);
  if (!ctx.nameOverride && !inferName(desc, unifiedUrls, paths)) {
    warnings.push('could not infer a pipeline name — defaulted to "draft"');
  }

  const schedule = pickSchedule(desc);

  const manifest: RagPipelineManifest = {
    apiVersion: 'llamactl/v1',
    kind: 'RagPipeline',
    metadata: { name: name || 'draft' },
    spec: {
      destination: { ragNode, collection },
      sources,
      transforms: [
        {
          kind: 'markdown-chunk',
          chunk_size: 800,
          overlap: 150,
          preserve_headings: true,
        },
      ],
      concurrency: 4,
      on_duplicate: 'skip',
      ...(schedule !== null ? { schedule } : {}),
    },
  };

  // Round-trip through the schema so defaults are filled + we know
  // the YAML we emit is one `apply` away from being live. If this
  // ever throws the drafter itself has a bug — we re-raise rather
  // than swallow.
  const parsed = RagPipelineManifestSchema.parse(manifest);
  const yaml = stringifyYaml(parsed);
  return { yaml, manifest: parsed, warnings };
}

function pickRagNode(
  desc: string,
  ctx: DraftContext,
  warnings: string[],
): string {
  const available = ctx.availableRagNodes ?? [];
  for (const node of available) {
    // Word-boundary match, not substring, so "kb-pg" doesn't swallow
    // "kb-pg-replica" and a stray "kb" in the description doesn't
    // silently pick a node whose name starts with those letters.
    const re = new RegExp(`\\b${escapeRegex(node)}\\b`);
    if (re.test(desc)) return node;
  }
  const fallback = ctx.defaultRagNode ?? DEFAULT_RAG_NODE;
  if (available.length > 0) {
    warnings.push(
      `no rag node from availableRagNodes matched — defaulted to '${fallback}'`,
    );
  }
  return fallback;
}

function pickCollection(
  desc: string,
  urls: string[],
  paths: string[],
  warnings: string[],
): string {
  const m = desc.match(COLLECTION_RE);
  if (m) return m[1]!;
  // Infer from the first source: host for URLs (incl. git clone
  // URLs), last path segment for filesystem. Collapses to snake_case.
  if (urls.length > 0) {
    try {
      const url = new URL(urls[0]!);
      return snakeCase(url.hostname.replace(/^www\./, ''));
    } catch {
      // Bare SSH git URLs (`git@host:org/repo.git`) don't parse as
      // URLs. Split on `:` to get the host, then snake_case it.
      const ssh = urls[0]!.match(/^git@([\w.-]+):/);
      if (ssh) return snakeCase(ssh[1]!);
    }
  }
  if (paths.length > 0) {
    const last = paths[0]!.split('/').filter(Boolean).pop() ?? '';
    if (last) return snakeCase(last);
  }
  warnings.push(
    "couldn't infer a collection name — defaulted to 'docs'. Set `collection` explicitly.",
  );
  return 'docs';
}

function pickSchedule(desc: string): string | null {
  const aliasMatch = desc.match(SCHEDULE_ALIAS_RE);
  if (aliasMatch) return `@${aliasMatch[1]!.toLowerCase()}`;
  // Also catch bare "daily" / "hourly" / "weekly" (no @).
  if (/\b(hourly|daily|weekly)\b/i.test(desc)) {
    const m = desc.match(/\b(hourly|daily|weekly)\b/i)!;
    return `@${m[1]!.toLowerCase()}`;
  }
  const everyMatch = desc.match(SCHEDULE_EVERY_RE);
  if (everyMatch) {
    const n = everyMatch[1]!;
    const unit = everyMatch[2]!.toLowerCase();
    const short = unit.startsWith('m') ? 'm' : unit.startsWith('h') ? 'h' : 'd';
    return `@every ${n}${short}`;
  }
  return null;
}

function inferName(desc: string, urls: string[], paths: string[]): string {
  if (urls.length > 0) {
    const first = urls[0]!;
    // Git clone URLs: pull the repo slug out of the path so
    // `https://github.com/pytorch/docs.git` becomes `pytorch-docs`
    // rather than `github-com`.
    if (first.endsWith('.git')) {
      const slugFromHttps = first.match(/\/([^/\s]+?)\/([^/\s]+?)\.git$/);
      if (slugFromHttps) return kebabCase(`${slugFromHttps[1]!}-${slugFromHttps[2]!}`);
      const slugFromSsh = first.match(/:([^/\s]+?)\/([^/\s]+?)\.git$/);
      if (slugFromSsh) return kebabCase(`${slugFromSsh[1]!}-${slugFromSsh[2]!}`);
    }
    try {
      const host = new URL(first).hostname.replace(/^www\./, '');
      return kebabCase(host);
    } catch {
      /* fallthrough */
    }
  }
  if (paths.length > 0) {
    const last = paths[0]!.split('/').filter(Boolean).pop() ?? '';
    if (last) return kebabCase(last);
  }
  // Last-ditch: if the description has a clear "noun-noun" label,
  // use it. E.g. "pytorch docs" → "pytorch-docs".
  const labelMatch = desc.match(/\b([a-z][a-z0-9]+(?:[-\s][a-z][a-z0-9]+)+)\b/i);
  if (labelMatch) return kebabCase(labelMatch[1]!);
  return '';
}

function matchAll(s: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(re)) {
    out.push((m[1] ?? m[0]).trim());
  }
  return out;
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

function snakeCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function kebabCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
