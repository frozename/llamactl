/**
 * On-disk persistence for RagPipeline manifests. Mirrors how composites
 * live under `$DEV_STORAGE/composites/<name>.yaml` — one directory per
 * pipeline so the journal + last-run state stay colocated with the
 * spec they describe:
 *
 *   $PIPELINES_DIR/<name>/
 *     spec.yaml          (applied manifest — source of truth)
 *     journal.jsonl      (ingest events — appended by the runtime)
 *     state.json         (last-run summary — updated on each run)
 *
 * The runtime never reads `state.json`; it's a UX surface for the CLI
 * + MCP + future Electron wizard. Tests override the root via
 * `LLAMACTL_RAG_PIPELINES_DIR`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  RagPipelineManifestSchema,
  type RagPipelineManifest,
} from './schema.js';
import type { RunSummary } from './runtime.js';
import { entrySpecHash } from '../../workload/gateway-catalog/hash.js';
import type { CompositeOwnership } from '../../workload/gateway-catalog/schema.js';

export function defaultPipelinesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_RAG_PIPELINES_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'rag-pipelines');
}

export function pipelineDir(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(defaultPipelinesDir(env), name);
}

export function journalPathFor(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(pipelineDir(name, env), 'journal.jsonl');
}

function specPath(name: string, env: NodeJS.ProcessEnv): string {
  return join(pipelineDir(name, env), 'spec.yaml');
}

function statePath(name: string, env: NodeJS.ProcessEnv): string {
  return join(pipelineDir(name, env), 'state.json');
}

export type ApplyConflict =
  | { kind: 'name'; name: string; existingOwner: 'operator' | 'composite' }
  | { kind: 'shape'; name: string; reason: string };

export type ApplyResult =
  | { ok: true; changed: boolean; path: string }
  | { ok: false; conflict: ApplyConflict };

export interface ApplyPipelineOpts {
  ownership?: CompositeOwnership;
  env?: NodeJS.ProcessEnv;
}

export function applyPipeline(
  manifest: RagPipelineManifest,
  opts: ApplyPipelineOpts = {},
): ApplyResult {
  const env = opts.env ?? process.env;

  // Re-parse through the schema so we never persist an invalid
  // manifest — callers who hand us a typed-but-crafted object still
  // get defaults + validation.
  const parsed = RagPipelineManifestSchema.parse(manifest);
  const newHash = entrySpecHash(parsed.spec);
  const cur = loadPipeline(parsed.metadata.name, env);

  // Brand-new write: just store + return.
  if (!cur) {
    const persisted: RagPipelineManifest = opts.ownership
      ? { ...parsed, ownership: { ...opts.ownership, specHash: newHash } }
      : parsed;
    const path = writeManifest(persisted, env);
    return { ok: true, changed: true, path };
  }

  // Existing entry has no ownership marker (operator-owned).
  if (!cur.ownership) {
    if (opts.ownership) {
      return {
        ok: false,
        conflict: { kind: 'name', name: parsed.metadata.name, existingOwner: 'operator' },
      };
    }
    const curHash = entrySpecHash(cur.spec);
    const changed = curHash !== newHash;
    const path = writeManifest(parsed, env);
    return { ok: true, changed, path };
  }

  // Existing entry has ownership marker (composite-owned).
  if (!opts.ownership) {
    return {
      ok: false,
      conflict: { kind: 'name', name: parsed.metadata.name, existingOwner: 'composite' },
    };
  }

  const claimingNames = opts.ownership.compositeNames;
  if (cur.ownership.specHash !== newHash) {
    return {
      ok: false,
      conflict: {
        kind: 'shape',
        name: parsed.metadata.name,
        reason: `existing specHash ${cur.ownership.specHash} != new ${newHash}`,
      },
    };
  }

  const allClaimingAlreadyOwn = claimingNames.every((n) =>
    cur.ownership!.compositeNames.includes(n),
  );
  if (allClaimingAlreadyOwn) {
    return { ok: true, changed: false, path: specPath(parsed.metadata.name, env) };
  }

  const merged = Array.from(
    new Set([...cur.ownership.compositeNames, ...claimingNames]),
  ).sort();
  const persisted: RagPipelineManifest = {
    ...parsed,
    ownership: { source: 'composite', compositeNames: merged, specHash: newHash },
  };
  const path = writeManifest(persisted, env);
  return { ok: true, changed: true, path };
}

function writeManifest(manifest: RagPipelineManifest, env: NodeJS.ProcessEnv): string {
  const dir = pipelineDir(manifest.metadata.name, env);
  const path = specPath(manifest.metadata.name, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, stringifyYaml(manifest), 'utf8');
  return path;
}

export function loadPipeline(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): RagPipelineManifest | null {
  const path = specPath(name, env);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return null;
  }
  const parsed = RagPipelineManifestSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

export interface PipelineRecord {
  name: string;
  manifest: RagPipelineManifest;
  lastRun?: { at: string; summary: RunSummary };
}

function readLastRun(
  name: string,
  env: NodeJS.ProcessEnv,
): { at: string; summary: RunSummary } | undefined {
  const p = statePath(name, env);
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as {
      at?: string;
      summary?: RunSummary;
    };
    if (typeof raw.at === 'string' && raw.summary) {
      return { at: raw.at, summary: raw.summary };
    }
  } catch {
    /* malformed state.json: treat as absent — runtime is the source of truth */
  }
  return undefined;
}

export function listPipelines(
  env: NodeJS.ProcessEnv = process.env,
): PipelineRecord[] {
  const root = defaultPipelinesDir(env);
  if (!existsSync(root)) return [];
  const names = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const out: PipelineRecord[] = [];
  for (const name of names) {
    const manifest = loadPipeline(name, env);
    if (!manifest) continue;
    const lastRun = readLastRun(name, env);
    out.push({ name, manifest, ...(lastRun ? { lastRun } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type RemoveConflict =
  | { kind: 'name'; name: string; existingOwner: 'operator' };

export type RemoveResult =
  | { ok: true; deleted: boolean }
  | { ok: false; conflict: RemoveConflict };

export interface RemovePipelineOpts {
  compositeName?: string;
  env?: NodeJS.ProcessEnv;
}

// Composite-aware overload — ref-counted strip-and-delete. Discriminated
// by the presence of `compositeName: string` on the opts argument. Older
// signatures accepted a positional `NodeJS.ProcessEnv`, which exposed a
// structural-typing footgun: any caller passing a `process.env`-shaped
// object that happened to carry a stray `compositeName` shell variable
// would be silently routed through the composite path. The opts-object
// signature closes that hole — composite intent is now explicit.
export function removePipeline(
  name: string,
  opts: { compositeName: string; env?: NodeJS.ProcessEnv },
): RemoveResult;
// Legacy operator-side overload — preserved for backwards compatibility,
// now accepts an opts object instead of a positional env so the
// process.env collision can no longer arise.
export function removePipeline(
  name: string,
  opts?: { env?: NodeJS.ProcessEnv },
): boolean;
export function removePipeline(
  name: string,
  opts: { compositeName?: string; env?: NodeJS.ProcessEnv } = {},
): boolean | RemoveResult {
  // Sole discriminator: an actual `compositeName: string` value on opts.
  // No structural overlap with `process.env` is possible here because
  // the caller never passes `process.env` directly — they wrap the env
  // they want in `{ env }`.
  const isCompositePath = typeof opts.compositeName === 'string';

  if (!isCompositePath) {
    // Legacy operator-side path — unchanged behavior.
    const env = opts.env ?? process.env;
    const dir = pipelineDir(name, env);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  const env = opts.env ?? process.env;
  const cur = loadPipeline(name, env);
  if (!cur) return { ok: true, deleted: false };

  if (!cur.ownership) {
    return {
      ok: false,
      conflict: { kind: 'name', name, existingOwner: 'operator' },
    };
  }

  if (!opts.compositeName) {
    return { ok: true, deleted: false };
  }

  const remaining = cur.ownership.compositeNames.filter(
    (n) => n !== opts.compositeName,
  );
  if (remaining.length === 0) {
    const dir = pipelineDir(name, env);
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, deleted: true };
  }

  const persisted: RagPipelineManifest = {
    ...cur,
    ownership: { ...cur.ownership, compositeNames: remaining },
  };
  const path = specPath(name, env);
  writeFileSync(path, stringifyYaml(persisted), 'utf8');
  return { ok: true, deleted: false };
}

export function writeLastRun(
  name: string,
  summary: RunSummary,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(pipelineDir(name, env), { recursive: true });
  writeFileSync(
    statePath(name, env),
    JSON.stringify({ at: new Date().toISOString(), summary }, null, 2),
    'utf8',
  );
}
