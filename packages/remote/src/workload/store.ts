import type { ResolvedEnv } from "@llamactl/core";

import { llamactlHome } from "@llamactl/core/config/env";
import { basename, join, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriteFileSync } from "../atomic-write.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "../safe-fs.js";
import { estimateModelHostMemoryGiB } from "./admission.js";
import { type ModelHostManifest, ModelHostManifestSchema } from "./modelhost-schema.js";
import { type ModelRun, ModelRunSchema } from "./schema.js";

export function defaultWorkloadsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LLAMACTL_WORKLOADS_DIR"]?.trim();
  if (override) return override;
  const base = llamactlHome(env);
  return join(base, "workloads");
}

export function workloadPath(name: string, dir: string = defaultWorkloadsDir()): string {
  return join(dir, `${name}.yaml`);
}

function ensureWorkloadPathWithinDir(path: string, dir: string): string {
  const resolvedDir = resolve(dir);
  const resolvedPath = resolve(path);
  const allowedPrefix = `${resolvedDir}${sep}`;
  if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(allowedPrefix)) {
    throw new Error(
      `workload path escapes workloads dir: ${resolvedPath} not within ${resolvedDir}`,
    );
  }
  return resolvedPath;
}

/**
 * Substitute `${env:VAR_NAME}` references in raw manifest text against
 * `env`. Throws on any unset variable so a missing binding is surfaced
 * at apply time rather than silently producing a literal `${env:...}`
 * string in the parsed manifest. Variable names must match
 * `[A-Z_][A-Z0-9_]*` to avoid matching unrelated shell-style tokens.
 */
export function interpolateEnvRefs(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  return raw.replaceAll(/\$\{env:([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) {
      throw new Error(`workload manifest references env:${name} but it is not set`);
    }
    return value;
  });
}

function interpolateEnvRefsDeep(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === "string") return interpolateEnvRefs(value, env);
  if (Array.isArray(value)) return value.map((entry) => interpolateEnvRefsDeep(entry, env));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = interpolateEnvRefsDeep(entry, env);
  }
  return out;
}

export function parseManifestYaml(raw: string, env: NodeJS.ProcessEnv = process.env): unknown {
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
  return parseWorkload(readFileSync(path, "utf8"));
}

export function loadWorkloadByName(name: string, dir: string = defaultWorkloadsDir()): ModelRun {
  return loadWorkload(ensureWorkloadPathWithinDir(workloadPath(name, dir), dir));
}

export function loadWorkloadByNameAny(
  name: string,
  dir: string = defaultWorkloadsDir(),
): ModelRun | ModelHostManifest {
  const path = ensureWorkloadPathWithinDir(workloadPath(name, dir), dir);
  if (!existsSync(path)) {
    throw new Error(`workload manifest not found: ${path}`);
  }

  const parsed = parseYaml(readFileSync(path, "utf8")) as {
    kind?: string;
    apiVersion?: string;
  } | null;
  if (parsed?.apiVersion === "llamactl.io/v1") {
    parsed.apiVersion = "llamactl/v1";
  }

  if (parsed?.kind === "ModelHost") {
    return ModelHostManifestSchema.parse(parsed);
  }
  return ModelRunSchema.parse(parsed);
}

export function saveWorkload(workload: ModelRun, dir: string = defaultWorkloadsDir()): string {
  const validated = ModelRunSchema.parse(workload);
  mkdirSync(dir, { recursive: true });
  const path = ensureWorkloadPathWithinDir(workloadPath(validated.metadata.name, dir), dir);
  atomicWriteFileSync(path, stringifyYaml(validated));
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

export function withWorkloadsMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = (workloadsMutexQueues.get(key) ?? Promise.resolve()).catch(() => undefined);
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

export function listWorkloadNames(dir: string = defaultWorkloadsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => basename(f, ".yaml"))
    .sort();
}

/**
 * Parse one manifest file as a ModelRun. Returns null for non-ModelRun
 * kinds and for unreadable/invalid files (reported via `onSkip`).
 */
function readModelRunEntry(
  path: string,
  onSkip: ((file: string, err: Error) => void) | undefined,
): ModelRun | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parseYaml(raw) as { kind?: string } | null;
    if (parsed?.kind !== "ModelRun") return null;
    return ModelRunSchema.parse(parsed);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    (
      onSkip ??
      ((skippedFile: string, skippedErr: Error): void => {
        console.warn(`listWorkloads: skipped ${skippedFile}: ${skippedErr.message}`);
      })
    )(path, error);
    return null;
  }
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
  const manifestPathsByName = new Map<string, string[]>();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    const path = join(dir, entry);
    const manifest = readModelRunEntry(path, onSkip);
    if (!manifest) continue;
    out.push(manifest);
    const byName = manifestPathsByName.get(manifest.metadata.name) ?? [];
    byName.push(path);
    manifestPathsByName.set(manifest.metadata.name, byName);
  }
  for (const [name, paths] of manifestPathsByName) {
    if (paths.length > 1) {
      console.warn(
        `listWorkloads: duplicate metadata.name '${name}' in manifests: ${paths.join(", ")}`,
      );
    }
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

function projectModelHostToModelRun(manifest: ModelHostManifest, resolved?: ResolvedEnv): ModelRun {
  const expectedMemoryGiB = resolved
    ? estimateModelHostMemoryGiB(manifest, resolved)
    : (manifest.spec.resources?.expectedMemoryGiB ?? null);
  const firstHostedModel = manifest.spec.hostedModels[0];
  if (!firstHostedModel) {
    throw new Error(`ModelHost ${manifest.metadata.name} must declare at least one hosted model`);
  }
  return {
    apiVersion: manifest.apiVersion,
    kind: "ModelRun",
    metadata: {
      name: manifest.metadata.name,
      labels: manifest.metadata.labels ?? {},
      annotations: {},
    },
    spec: {
      node: manifest.spec.node,
      enabled: manifest.spec.enabled,
      target: { kind: "rel", value: firstHostedModel.rel },
      extraArgs: manifest.spec.extraArgs,
      workers: [],
      restartPolicy: manifest.spec.restartPolicy,
      resources: expectedMemoryGiB !== null ? { expectedMemoryGiB } : undefined,
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
  resolved?: ResolvedEnv,
): ModelRun[] {
  if (!existsSync(dir)) return [];
  const out: ModelRun[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    const path = join(dir, entry);
    try {
      const parsed = parseYaml(readFileSync(path, "utf8")) as {
        kind?: string;
        apiVersion?: string;
      } | null;
      if (parsed?.apiVersion === "llamactl.io/v1") {
        parsed.apiVersion = "llamactl/v1";
      }
      if (parsed?.kind === "ModelRun") {
        out.push(ModelRunSchema.parse(parsed));
      } else if (parsed?.kind === "ModelHost") {
        const host = ModelHostManifestSchema.parse(parsed);
        out.push(projectModelHostToModelRun(host, resolved));
      }
    } catch {
      // Malformed files are ignored during admission; describe/load paths surface the error.
    }
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export function deleteWorkload(name: string, dir: string = defaultWorkloadsDir()): boolean {
  const path = ensureWorkloadPathWithinDir(workloadPath(name, dir), dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
