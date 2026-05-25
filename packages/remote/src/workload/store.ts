import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ModelRunSchema, type ModelRun } from './schema.js';
import { ModelHostManifestSchema, type ModelHostManifest } from './modelhost-schema.js';

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
 * Substitute `${env:VAR_NAME}` references in raw manifest text against
 * `env`. Throws on any unset variable so a missing binding is surfaced
 * at apply time rather than silently producing a literal `${env:...}`
 * string in the parsed manifest. Variable names must match
 * `[A-Z_][A-Z0-9_]*` to avoid matching unrelated shell-style tokens.
 */
export function interpolateEnvRefs(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return raw.replace(/\$\{env:([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) {
      throw new Error(`workload manifest references env:${name} but it is not set`);
    }
    return value;
  });
}

function interpolateEnvRefsDeep(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (typeof value === 'string') return interpolateEnvRefs(value, env);
  if (Array.isArray(value)) return value.map((entry) => interpolateEnvRefsDeep(entry, env));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = interpolateEnvRefsDeep(entry, env);
  }
  return out;
}

export function parseManifestYaml(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  return interpolateEnvRefsDeep(parseYaml(raw), env);
}

/**
 * Parse + validate a manifest from YAML text. Used by `apply -f` where
 * the file might live outside the workloads dir (typical kubectl flow
 * is to edit a manifest in a git repo, then apply it).
 */
export function parseWorkload(raw: string): ModelRun {
  const parsed = parseManifestYaml(raw);
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

export function loadWorkloadByNameAny(
  name: string,
  dir: string = defaultWorkloadsDir(),
): ModelRun | ModelHostManifest {
  const path = workloadPath(name, dir);
  if (!existsSync(path)) {
    throw new Error(`workload manifest not found: ${path}`);
  }

  const parsed = parseYaml(readFileSync(path, 'utf8')) as { kind?: string; apiVersion?: string } | null;
  if (parsed && parsed.apiVersion === 'llamactl.io/v1') {
    parsed.apiVersion = 'llamactl/v1';
  }

  if (parsed?.kind === 'ModelHost') {
    return ModelHostManifestSchema.parse(parsed);
  }
  return ModelRunSchema.parse(parsed);
}

export function saveWorkload(
  workload: ModelRun,
  dir: string = defaultWorkloadsDir(),
): string {
  const validated = ModelRunSchema.parse(workload);
  mkdirSync(dir, { recursive: true });
  const path = workloadPath(validated.metadata.name, dir);
  // Atomic write: a partial writeFileSync on the target can race with a
  // concurrent reader (or a second writer for the same name) and leave
  // truncated YAML on disk. Write to a sibling tmp file and rename over
  // the target — POSIX rename on the same filesystem is atomic.
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, stringifyYaml(validated), 'utf8');
  renameSync(tmp, path);
  return path;
}

/**
 * In-process async mutex keyed by `workloadsDir`. Concurrent callers
 * for the same directory are serialized, so a list→check→save
 * transaction (port-collision preflight in `applyOne` plus the
 * subsequent `saveWorkload`) can't interleave with another such
 * transaction inside the same controller process. Cross-process
 * coordination still relies on `acquireLock` from `./lock.ts`.
 */
const workloadsMutexQueues = new Map<string, Promise<unknown>>();

export function withWorkloadsMutex<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tail = (workloadsMutexQueues.get(key) ?? Promise.resolve()).catch(
    () => undefined,
  );
  const run = tail.then(fn);
  workloadsMutexQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
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
  onSkip?: (file: string, err: Error) => void,
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
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      (onSkip ?? ((skippedFile: string, skippedErr: Error) => {
        console.warn(`listWorkloads: skipped ${skippedFile}: ${skippedErr.message}`);
      }))(path, error);
    }
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

function projectModelHostToModelRun(manifest: ModelHostManifest): ModelRun {
  return {
    apiVersion: manifest.apiVersion,
    kind: 'ModelRun',
    metadata: {
      name: manifest.metadata.name,
      labels: manifest.metadata.labels ?? {},
      annotations: {},
    },
    spec: {
      node: manifest.spec.node,
      enabled: manifest.spec.enabled,
      target: { kind: 'rel', value: manifest.spec.hostedModels[0]!.rel },
      extraArgs: manifest.spec.extraArgs,
      workers: [],
      restartPolicy: manifest.spec.restartPolicy,
      resources: manifest.spec.resources,
      timeoutSeconds: manifest.spec.timeoutSeconds,
      endpoint: manifest.spec.endpoint,
      binary: manifest.spec.binary,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

export function listAnyWorkloadsForAdmission(
  dir: string = defaultWorkloadsDir(),
): ModelRun[] {
  if (!existsSync(dir)) return [];
  const out: ModelRun[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    const path = join(dir, entry);
    try {
      const parsed = parseYaml(readFileSync(path, 'utf8')) as { kind?: string; apiVersion?: string } | null;
      if (parsed && parsed.apiVersion === 'llamactl.io/v1') {
        parsed.apiVersion = 'llamactl/v1';
      }
      if (parsed?.kind === 'ModelRun') {
        out.push(ModelRunSchema.parse(parsed));
      } else if (parsed?.kind === 'ModelHost') {
        const host = ModelHostManifestSchema.parse(parsed);
        out.push(projectModelHostToModelRun(host));
      }
    } catch {
      // Malformed files are ignored during admission; describe/load paths surface the error.
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
