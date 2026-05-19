import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { defaultWorkloadsDir } from './store.js';
import { ModelHostManifestSchema, type ModelHostManifest } from './modelhost-schema.js';

export function defaultModelHostDir(env: NodeJS.ProcessEnv = process.env): string {
  return defaultWorkloadsDir(env);
}

export function parseModelHost(raw: string): ModelHostManifest {
  const parsed = parseYaml(raw) as { apiVersion?: string } | null;
  if (parsed && parsed.apiVersion === 'llamactl.io/v1') {
    parsed.apiVersion = 'llamactl/v1';
  }
  return ModelHostManifestSchema.parse(parsed);
}

export function modelHostPath(name: string, dir: string = defaultModelHostDir()): string {
  return join(dir, `${name}.yaml`);
}

export function loadModelHost(path: string): ModelHostManifest {
  return parseModelHost(readFileSync(path, 'utf8'));
}

export function loadModelHostByName(name: string, dir: string = defaultModelHostDir()): ModelHostManifest {
  const path = modelHostPath(name, dir);
  if (!existsSync(path)) throw new Error(`ModelHost ${name} not found at ${path}`);
  return loadModelHost(path);
}

export function saveModelHost(manifest: ModelHostManifest, dir: string = defaultModelHostDir()): string {
  const validated = ModelHostManifestSchema.parse(manifest);
  mkdirSync(dir, { recursive: true });
  const path = modelHostPath(validated.metadata.name, dir);
  writeFileSync(path, stringifyYaml(validated), 'utf8');
  return path;
}

export function listModelHosts(dir: string = defaultModelHostDir()): ModelHostManifest[] {
  if (!existsSync(dir)) return [];
  const out: ModelHostManifest[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    try {
      const parsed = parseYaml(readFileSync(join(dir, entry), 'utf8')) as { kind?: string };
      if (parsed?.kind !== 'ModelHost') continue;
      out.push(ModelHostManifestSchema.parse(parsed));
    } catch {}
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export function deleteModelHost(name: string, dir: string = defaultModelHostDir()): boolean {
  const path = modelHostPath(name, dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
