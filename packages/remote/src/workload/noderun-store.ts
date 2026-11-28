import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriteFileSync } from "../atomic-write.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "../safe-fs.js";
import { type NodeRun, NodeRunSchema } from "./noderun-schema.js";
import { defaultWorkloadsDir } from "./store.js";

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
  const raw = readFileSync(path, "utf8");
  return parseNodeRun(raw);
}

export function loadNodeRunByName(name: string, dir: string = defaultNodeRunsDir()): NodeRun {
  const path = nodeRunPath(name, dir);
  if (!existsSync(path)) {
    throw new Error(`NodeRun ${name} not found at ${path}`);
  }
  return loadNodeRun(path);
}

export function saveNodeRun(manifest: NodeRun, dir: string = defaultNodeRunsDir()): string {
  NodeRunSchema.parse(manifest);
  mkdirSync(dir, { recursive: true });
  const path = nodeRunPath(manifest.metadata.name, dir);
  atomicWriteFileSync(path, stringifyYaml(manifest));
  return path;
}

export function listNodeRuns(dir: string = defaultNodeRunsDir()): NodeRun[] {
  if (!existsSync(dir)) return [];
  const out: NodeRun[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    const path = join(dir, entry);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = parseYaml(raw) as { kind?: string } | null;
      if (parsed?.kind !== "NodeRun") continue;
      out.push(NodeRunSchema.parse(parsed));
    } catch {
      // Skip malformed / wrong-kind files silently — `apply`-time
      // validation surfaces real errors there; see `listInvalidNodeRuns`
      // for a report of what was skipped.
    }
  }
  out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return out;
}

export function deleteNodeRun(name: string, dir: string = defaultNodeRunsDir()): boolean {
  const path = nodeRunPath(name, dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export interface InvalidNodeRunFile {
  file: string;
  name: string | null;
  node: string | null;
  error: string;
}

// Narrow view of an unvalidated manifest: only the fields the report needs to
// attribute a failure. Keeps the reads off an index signature (strict gate).
type NodeRunFileHeader = {
  kind?: unknown;
  metadata?: { name?: unknown } | null;
  spec?: { node?: unknown } | null;
};

function invalidEntryFor(entry: string, parsed: unknown): InvalidNodeRunFile | null {
  const header = parsed as NodeRunFileHeader | null;
  if (header?.kind !== "NodeRun") return null;
  const result = NodeRunSchema.safeParse(parsed);
  if (result.success) return null;
  const issues = result.error.issues;
  const error = issues
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return {
    file: entry,
    name: typeof header.metadata?.name === "string" ? header.metadata.name : null,
    node: typeof header.spec?.node === "string" ? header.spec.node : null,
    error,
  };
}

export function listInvalidNodeRuns(dir: string = defaultNodeRunsDir()): InvalidNodeRunFile[] {
  if (!existsSync(dir)) return [];
  const out: InvalidNodeRunFile[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml")) continue;
    const path = join(dir, entry);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = parseYaml(raw) as NodeRunFileHeader | null;
      const item = invalidEntryFor(entry, parsed);
      if (item !== null) out.push(item);
    } catch {
      // Skip files that fail to read or parse as YAML.
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file, "en"));
  return out;
}
