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

export function applyPipeline(
  manifest: RagPipelineManifest,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; created: boolean } {
  // Re-parse through the schema so we never persist an invalid
  // manifest — callers who hand us a typed-but-crafted object still
  // get defaults + validation.
  const parsed = RagPipelineManifestSchema.parse(manifest);
  const dir = pipelineDir(parsed.metadata.name, env);
  const path = specPath(parsed.metadata.name, env);
  const created = !existsSync(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, stringifyYaml(parsed), 'utf8');
  return { path, created };
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

export function removePipeline(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const dir = pipelineDir(name, env);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
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
