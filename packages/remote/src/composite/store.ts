/**
 * Composite manifest storage — file-per-manifest YAML pattern,
 * mirrors the workload store in `../workload/store.ts`. Default
 * directory is `~/.llamactl/composites/` with the
 * `LLAMACTL_COMPOSITES_DIR` env override (identical convention to
 * workloads / infra / kubeconfig stores, so ops tools that bulk-
 * relocate llamactl state can redirect all of them uniformly).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CompositeSchema, type Composite } from './schema.js';

export function defaultCompositesDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LLAMACTL_COMPOSITES_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'composites');
}

export function compositePath(
  name: string,
  dir: string = defaultCompositesDir(),
): string {
  return join(dir, `${name}.yaml`);
}

/**
 * Parse + validate a composite from YAML text. Refuses to produce a
 * `Composite` when the document's `kind` field is anything other
 * than `'Composite'` — a file with `kind: ModelRun` should route
 * through the workload store instead.
 */
export function parseComposite(raw: string): Composite {
  const parsed = parseYaml(raw);
  return CompositeSchema.parse(parsed);
}

export function loadComposite(
  name: string,
  dir: string = defaultCompositesDir(),
): Composite | null {
  const path = compositePath(name, dir);
  if (!existsSync(path)) return null;
  return parseComposite(readFileSync(path, 'utf8'));
}

export function saveComposite(
  manifest: Composite,
  dir: string = defaultCompositesDir(),
): string {
  const validated = CompositeSchema.parse(manifest);
  mkdirSync(dir, { recursive: true });
  const path = compositePath(validated.metadata.name, dir);
  writeFileSync(path, stringifyYaml(validated), 'utf8');
  return path;
}

export function listCompositeNames(
  dir: string = defaultCompositesDir(),
): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => basename(f, '.yaml'))
    .sort();
}

/**
 * Enumerate every valid composite in the directory. Kind-filters so
 * files with `kind: ModelRun` (or any other manifest type that
 * ended up in this directory) don't throw — we only return
 * `Composite`-kinded manifests, sorted by name. Malformed files
 * are silently skipped; `llamactl describe composite <n>` surfaces
 * the real error to operators on demand.
 */
export function listComposites(
  dir: string = defaultCompositesDir(),
): Composite[] {
  if (!existsSync(dir)) return [];
  const out: Composite[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    const path = join(dir, entry);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = parseYaml(raw) as { kind?: string } | null;
      if (parsed?.kind !== 'Composite') continue;
      out.push(CompositeSchema.parse(parsed));
    } catch {
      // Skip malformed files; operators see these via describe.
    }
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export function deleteComposite(
  name: string,
  dir: string = defaultCompositesDir(),
): boolean {
  const path = compositePath(name, dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
