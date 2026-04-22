import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { NodeClient } from '@llamactl/remote';
import { getNodeClient } from '../dispatcher.js';

/**
 * `llamactl project …` — first-class project resource CLI (Phase 2
 * of trifold-orchestrating-engelbart.md). Projects live in
 * `~/.llamactl/projects.yaml` (override via `$LLAMACTL_PROJECTS_FILE`)
 * and declare a filesystem path + optional RAG target + a task-kind
 * → routing-target map. `project index` auto-generates and applies a
 * `RagPipeline` manifest against the declared rag node.
 *
 * All subcommands forward to tRPC procedures on the control-plane
 * node; routing targets are validated as strings only here — the
 * router hook expands them lazily at chat dispatch time.
 */

const USAGE = `Usage: llamactl project <subcommand>

Subcommands:
  add <name> --path <abs> [--purpose "..."] [--stack <a,b,c>]
             [--rag-node <node>] [--rag-collection <col>]
             [--rag-glob <glob>] [--rag-schedule <cron>]
             [--route <taskKind>=<target>]...
      Generate a minimal Project manifest and persist it to
      $LLAMACTL_PROJECTS_FILE (or ~/.llamactl/projects.yaml). --path
      must be absolute; --rag-node + --rag-collection enable later
      indexing via \`project index\`. --route may repeat.

  apply -f <file.yaml | ->
      Apply a Project manifest from a file or stdin. Re-applies are
      idempotent — the named project is upserted in place.

  list [--json]
      Enumerate every registered project with its path + rag + route
      count. --json emits the raw list.

  get <name> [--json]
      Print the stored manifest as YAML (or JSON with --json).

  rm <name>
      Remove the project entry from projects.yaml. Does NOT touch
      data already indexed in the rag node — mirrors the
      \`rag pipeline rm\` contract.

  index <name>
      Auto-generate a RagPipeline manifest from spec.rag and apply
      it. Pipeline name: \`project-<name>\`. Requires spec.rag to be
      set; errors otherwise.

  route <name> <taskKind>
      Resolve the routing target for a task kind against a project's
      policy. Read-only — no side effects. Prints the target plus
      whether the policy matched explicitly.
`;

export interface ProjectTestSeams {
  nodeClient?: NodeClient;
}

let testSeams: ProjectTestSeams = {};

export function __setProjectTestSeams(seams: ProjectTestSeams): void {
  testSeams = { ...seams };
}

export function __resetProjectTestSeams(): void {
  testSeams = {};
}

function client(): NodeClient {
  return testSeams.nodeClient ?? getNodeClient();
}

export async function runProject(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'add':
      return runAdd(rest);
    case 'apply':
      return runApply(rest);
    case 'list':
    case 'ls':
      return runList(rest);
    case 'get':
      return runGet(rest);
    case 'rm':
    case 'remove':
      return runRemove(rest);
    case 'index':
      return runIndex(rest);
    case 'route':
      return runRoute(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown project subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

// ---- add ------------------------------------------------------------

interface AddOpts {
  name: string;
  path: string;
  purpose: string | undefined;
  stack: string[];
  ragNode: string | undefined;
  ragCollection: string | undefined;
  ragGlob: string | undefined;
  ragSchedule: string | undefined;
  routes: Record<string, string>;
}

function parseAddFlags(args: string[]): AddOpts | { error: string } {
  let name = '';
  let path = '';
  let purpose: string | undefined;
  let stack: string[] = [];
  let ragNode: string | undefined;
  let ragCollection: string | undefined;
  let ragGlob: string | undefined;
  let ragSchedule: string | undefined;
  const routes: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--path') {
      path = args[++i] ?? '';
    } else if (arg.startsWith('--path=')) {
      path = arg.slice('--path='.length);
    } else if (arg === '--purpose') {
      purpose = args[++i];
    } else if (arg.startsWith('--purpose=')) {
      purpose = arg.slice('--purpose='.length);
    } else if (arg === '--stack') {
      stack = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--stack=')) {
      stack = arg.slice('--stack='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--rag-node') {
      ragNode = args[++i];
    } else if (arg.startsWith('--rag-node=')) {
      ragNode = arg.slice('--rag-node='.length);
    } else if (arg === '--rag-collection') {
      ragCollection = args[++i];
    } else if (arg.startsWith('--rag-collection=')) {
      ragCollection = arg.slice('--rag-collection='.length);
    } else if (arg === '--rag-glob') {
      ragGlob = args[++i];
    } else if (arg.startsWith('--rag-glob=')) {
      ragGlob = arg.slice('--rag-glob='.length);
    } else if (arg === '--rag-schedule') {
      ragSchedule = args[++i];
    } else if (arg.startsWith('--rag-schedule=')) {
      ragSchedule = arg.slice('--rag-schedule='.length);
    } else if (arg === '--route') {
      const pair = args[++i] ?? '';
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) {
        return { error: `--route expects <taskKind>=<target>, got '${pair}'` };
      }
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      if (!key || !value) {
        return { error: `--route expects a non-empty taskKind and target` };
      }
      routes[key] = value;
    } else if (arg.startsWith('--route=')) {
      const pair = arg.slice('--route='.length);
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) {
        return { error: `--route expects <taskKind>=<target>, got '${pair}'` };
      }
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      if (!key || !value) {
        return { error: `--route expects a non-empty taskKind and target` };
      }
      routes[key] = value;
    } else if (arg === '-h' || arg === '--help') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}` };
    } else if (!name) {
      name = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!name) return { error: 'project add: <name> is required' };
  if (!path) return { error: 'project add: --path is required' };
  if ((ragNode && !ragCollection) || (!ragNode && ragCollection)) {
    return { error: 'project add: --rag-node and --rag-collection must be set together' };
  }
  return {
    name,
    path,
    purpose,
    stack,
    ragNode,
    ragCollection,
    ragGlob,
    ragSchedule,
    routes,
  };
}

async function runAdd(args: string[]): Promise<number> {
  const parsed = parseAddFlags(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const spec: Record<string, unknown> = { path: parsed.path };
  if (parsed.purpose) spec.purpose = parsed.purpose;
  if (parsed.stack.length > 0) spec.stack = parsed.stack;
  if (parsed.ragNode && parsed.ragCollection) {
    const rag: Record<string, unknown> = {
      node: parsed.ragNode,
      collection: parsed.ragCollection,
    };
    if (parsed.ragGlob) rag.docsGlob = parsed.ragGlob;
    if (parsed.ragSchedule) rag.schedule = parsed.ragSchedule;
    spec.rag = rag;
  }
  if (Object.keys(parsed.routes).length > 0) spec.routing = parsed.routes;
  const manifest = {
    apiVersion: 'llamactl/v1',
    kind: 'Project',
    metadata: { name: parsed.name },
    spec,
  };
  const manifestYaml = stringifyYaml(manifest);
  try {
    const res = await client().projectApply.mutate({ manifestYaml });
    process.stdout.write(
      `${res.created ? 'applied' : 'updated'} project '${res.name}'\n  path: ${res.path}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`project add: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- apply ----------------------------------------------------------

interface ApplyOpts {
  file: string;
}

function parseApplyFlags(args: string[]): ApplyOpts | { error: string } {
  let file = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--file') {
      file = args[++i] ?? '';
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else if (arg === '-h' || arg === '--help') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!file) return { error: 'project apply: -f <file.yaml> is required' };
  return { file };
}

async function runApply(args: string[]): Promise<number> {
  const parsed = parseApplyFlags(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  let manifestYaml: string;
  if (parsed.file === '-') {
    try {
      manifestYaml = readFileSync(0, 'utf8');
    } catch (err) {
      process.stderr.write(
        `project apply: failed reading manifest from stdin: ${(err as Error).message}\n`,
      );
      return 1;
    }
    if (!manifestYaml.trim()) {
      process.stderr.write('project apply: stdin was empty — pipe a Project YAML in.\n');
      return 1;
    }
  } else {
    const absPath = resolve(parsed.file);
    if (!existsSync(absPath)) {
      process.stderr.write(`project apply: file not found: ${absPath}\n`);
      return 1;
    }
    manifestYaml = readFileSync(absPath, 'utf8');
  }
  try {
    const res = await client().projectApply.mutate({ manifestYaml });
    process.stdout.write(
      `${res.created ? 'applied' : 'updated'} project '${res.name}'\n  path: ${res.path}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`project apply: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- list -----------------------------------------------------------

async function runList(args: string[]): Promise<number> {
  let json = false;
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`Unknown flag: ${a}\n\n${USAGE}`);
      return 1;
    }
  }
  try {
    const res = await client().projectList.query();
    if (json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    if (res.projects.length === 0) {
      process.stdout.write('(no projects registered)\n');
      return 0;
    }
    for (const p of res.projects) {
      const ragLine = p.spec.rag
        ? `rag=${p.spec.rag.node}/${p.spec.rag.collection}`
        : 'rag=<none>';
      const routeCount = Object.keys(p.spec.routing).length;
      process.stdout.write(
        `${p.metadata.name}\n  path: ${p.spec.path}\n  ${ragLine}  routes=${routeCount}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`project list: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- get ------------------------------------------------------------

async function runGet(args: string[]): Promise<number> {
  let name = '';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown flag: ${arg}\n\n${USAGE}`);
      return 1;
    } else if (!name) {
      name = arg;
    } else {
      process.stderr.write(`Unexpected argument: ${arg}\n\n${USAGE}`);
      return 1;
    }
  }
  if (!name) {
    process.stderr.write(`project get: <name> is required\n\n${USAGE}`);
    return 1;
  }
  try {
    const res = await client().projectGet.query({ name });
    if (json) {
      process.stdout.write(`${JSON.stringify(res.project)}\n`);
      return 0;
    }
    process.stdout.write(stringifyYaml(res.project));
    return 0;
  } catch (err) {
    process.stderr.write(`project get: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- rm -------------------------------------------------------------

async function runRemove(args: string[]): Promise<number> {
  const [name] = args;
  if (!name || name.startsWith('-')) {
    process.stderr.write(`project rm: <name> is required\n\n${USAGE}`);
    return 1;
  }
  try {
    const res = await client().projectRemove.mutate({ name });
    if (!res.removed) {
      process.stderr.write(`project rm: '${name}' not found\n`);
      return 1;
    }
    process.stdout.write(`removed project '${name}'\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`project rm: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- index ----------------------------------------------------------

async function runIndex(args: string[]): Promise<number> {
  const [name] = args;
  if (!name || name.startsWith('-')) {
    process.stderr.write(`project index: <name> is required\n\n${USAGE}`);
    return 1;
  }
  try {
    const res = await client().projectIndex.mutate({ name });
    process.stdout.write(
      `indexed project '${name}'\n  pipeline: ${res.pipelineName}\n  spec: ${res.path}\n` +
        `  next: \`llamactl rag pipeline run ${res.pipelineName}\`\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`project index: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- route ----------------------------------------------------------

async function runRoute(args: string[]): Promise<number> {
  const [name, taskKind] = args;
  if (!name || name.startsWith('-')) {
    process.stderr.write(`project route: <name> is required\n\n${USAGE}`);
    return 1;
  }
  if (!taskKind || taskKind.startsWith('-')) {
    process.stderr.write(`project route: <taskKind> is required\n\n${USAGE}`);
    return 1;
  }
  try {
    const res = await client().projectResolveRouting.query({
      project: name,
      taskKind,
    });
    const label = res.matched ? 'matched' : 'default';
    process.stdout.write(
      `${name}/${taskKind} → ${res.target} (${label})\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`project route: ${(err as Error).message}\n`);
    return 1;
  }
}
