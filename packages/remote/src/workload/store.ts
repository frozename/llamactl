import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ModelRunSchema, type ModelRun } from './schema.js';

export function defaultWorkloadsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LLAMACTL_WORKLOADS_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'workloads');
}

export function workloadPath(
  name: string,
  dir: string = defaultWorkloadsDir(),
): string {
  return join(dir, `${name}.yaml`);
}

/**
 * Parse + validate a manifest from YAML text. Used by `apply -f` where
 * the file might live outside the workloads dir (typical kubectl flow
 * is to edit a manifest in a git repo, then apply it).
 */
export function parseWorkload(raw: string): ModelRun {
  const parsed = parseYaml(raw);
  return ModelRunSchema.parse(parsed);
}

export function loadWorkload(path: string): ModelRun {
  if (!existsSync(path)) {
    throw new Error(`workload manifest not found: ${path}`);
  }
  return parseWorkload(readFileSync(path, 'utf8'));
}

export function loadWorkloadByName(
  name: string,
  dir: string = defaultWorkloadsDir(),
): ModelRun {
  return loadWorkload(workloadPath(name, dir));
}

export function saveWorkload(
  workload: ModelRun,
  dir: string = defaultWorkloadsDir(),
): string {
  const validated = ModelRunSchema.parse(workload);
  mkdirSync(dir, { recursive: true });
  const path = workloadPath(validated.metadata.name, dir);
  writeFileSync(path, stringifyYaml(validated), 'utf8');
  return path;
}

export function listWorkloadNames(
  dir: string = defaultWorkloadsDir(),
): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => basename(f, '.yaml'))
    .sort();
}

export function listWorkloads(
  dir: string = defaultWorkloadsDir(),
): ModelRun[] {
  // Kind-filter: NodeRun manifests also live in this directory
  // (Phase I.4). Skip anything that isn't `kind: ModelRun`
  // rather than letting Zod throw on a NodeRun-shaped file.
  if (!existsSync(dir)) return [];
  const out: ModelRun[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    const path = join(dir, entry);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = parseYaml(raw) as { kind?: string } | null;
      if (parsed?.kind !== 'ModelRun') continue;
      out.push(ModelRunSchema.parse(parsed));
    } catch {
      // Malformed files surface via `llamactl describe workload <n>`
      // where the operator gets a real error message.
    }
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export function deleteWorkload(
  name: string,
  dir: string = defaultWorkloadsDir(),
): boolean {
  const path = workloadPath(name, dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
