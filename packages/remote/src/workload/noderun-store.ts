import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { defaultWorkloadsDir } from './store.js';
import { NodeRunSchema, type NodeRun } from './noderun-schema.js';

/**
 * NodeRun manifests share the ~/.llamactl/workloads/ directory with
 * ModelRun files. Kind discrimination happens at parse time: the
 * store reads every .yaml, inspects `kind`, returns only the kind
 * the caller asked for. Operators can mix both kinds in one directory
 * and apply them with a single `llamactl apply -f dir/`.
 */

export function defaultNodeRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  return defaultWorkloadsDir(env);
}

export function parseNodeRun(raw: string): NodeRun {
  return NodeRunSchema.parse(parseYaml(raw));
}

export function nodeRunPath(name: string, dir: string = defaultNodeRunsDir()): string {
  return join(dir, `${name}.yaml`);
}

export function loadNodeRun(path: string): NodeRun {
  const raw = readFileSync(path, 'utf8');
  return parseNodeRun(raw);
}

export function loadNodeRunByName(
  name: string,
  dir: string = defaultNodeRunsDir(),
): NodeRun {
  const path = nodeRunPath(name, dir);
  if (!existsSync(path)) {
    throw new Error(`NodeRun ${name} not found at ${path}`);
  }
  return loadNodeRun(path);
}

export function saveNodeRun(
  manifest: NodeRun,
  dir: string = defaultNodeRunsDir(),
): string {
  NodeRunSchema.parse(manifest);
  mkdirSync(dir, { recursive: true });
  const path = nodeRunPath(manifest.metadata.name, dir);
  writeFileSync(path, stringifyYaml(manifest), 'utf8');
  return path;
}

export function listNodeRuns(dir: string = defaultNodeRunsDir()): NodeRun[] {
  if (!existsSync(dir)) return [];
  const out: NodeRun[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    const path = join(dir, entry);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = parseYaml(raw) as { kind?: string };
      if (parsed?.kind !== 'NodeRun') continue;
      out.push(NodeRunSchema.parse(parsed));
    } catch {
      // Skip malformed / wrong-kind files silently — `apply`-time
      // validation surfaces real errors there.
    }
  }
  out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return out;
}

export function deleteNodeRun(
  name: string,
  dir: string = defaultNodeRunsDir(),
): boolean {
  const path = nodeRunPath(name, dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
