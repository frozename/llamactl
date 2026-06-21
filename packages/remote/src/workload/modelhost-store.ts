import { join, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriteFileSync } from "../atomic-write.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "../safe-fs.js";
import { type ModelHostManifest, ModelHostManifestSchema } from "./modelhost-schema.js";
import { defaultWorkloadsDir } from "./store.js";

export function defaultModelHostDir(env: NodeJS.ProcessEnv = process.env): string {
  return defaultWorkloadsDir(env);
}

export function parseModelHost(raw: string): ModelHostManifest {
  const parsed = parseYaml(raw) as { apiVersion?: string } | null;
  if (parsed?.apiVersion === "llamactl.io/v1") {
    parsed.apiVersion = "llamactl/v1";
  }
  return ModelHostManifestSchema.parse(parsed);
}

export function modelHostPath(name: string, dir: string = defaultModelHostDir()): string {
  return join(dir, `${name}.yaml`);
}

function ensureModelHostPathWithinDir(path: string, dir: string): string {
  const resolvedDir = resolve(dir);
  const resolvedPath = resolve(path);
  const allowedPrefix = `${resolvedDir}${sep}`;
  if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(allowedPrefix)) {
    throw new Error(
      `ModelHost path escapes workloads dir: ${resolvedPath} not within ${resolvedDir}`,
    );
  }
  return resolvedPath;
}

export function loadModelHost(path: string): ModelHostManifest {
  return parseModelHost(readFileSync(path, "utf8"));
}

export function loadModelHostByName(
  name: string,
  dir: string = defaultModelHostDir(),
): ModelHostManifest {
  const path = ensureModelHostPathWithinDir(modelHostPath(name, dir), dir);
  if (!existsSync(path)) throw new Error(`ModelHost ${name} not found at ${path}`);
  return loadModelHost(path);
}

export function saveModelHost(
  manifest: ModelHostManifest,
  dir: string = defaultModelHostDir(),
): string {
  const { status: _status, ...desired } = manifest as ModelHostManifest & { status?: unknown };
  const validated = ModelHostManifestSchema.parse(desired);
  mkdirSync(dir, { recursive: true });
  const path = ensureModelHostPathWithinDir(modelHostPath(validated.metadata.name, dir), dir);
  atomicWriteFileSync(path, stringifyYaml(validated));
  return path;
}

export function listModelHosts(
  dir: string = defaultModelHostDir(),
  onSkip?: (file: string, err: Error) => void,
): ModelHostManifest[] {
  if (!existsSync(dir)) return [];
  const out: ModelHostManifest[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    const file = join(dir, entry);
    try {
      const parsed = parseYaml(readFileSync(file, "utf8")) as { kind?: string } | null;
      if (parsed?.kind !== "ModelHost") continue;
      out.push(ModelHostManifestSchema.parse(parsed));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      (
        onSkip ??
        ((skippedFile: string, skippedErr: Error): void => {
          console.warn(`listModelHosts: skipped ${skippedFile}: ${skippedErr.message}`);
        })
      )(file, error);
    }
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export function deleteModelHost(name: string, dir: string = defaultModelHostDir()): boolean {
  const path = ensureModelHostPathWithinDir(modelHostPath(name, dir), dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
