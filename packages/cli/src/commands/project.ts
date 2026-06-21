import type { NodeClient } from "@llamactl/remote";

import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { getNodeClient } from "../dispatcher.js";
import { required } from "../required.js";
import { existsSync, readFileSync } from "../safe-fs.js";

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

  route <name> <taskKind> [--json]
      Resolve the routing target for a task kind against a project's
      policy. Full Phase 3 resolution — walks the same path dispatch
      takes for \`project:<name>/<taskKind>\` chat nodes, including
      budget overrides. Read-only — no side effects, no journal
      writes. Prints target + reason (matched | fallback-default |
      project-not-found | over-budget) with an optional budget
      annotation when applicable. --json emits the raw envelope.
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
    case "add":
      return await runAdd(rest);
    case "apply":
      return await runApply(rest);
    case "list":
    case "ls":
      return await runList(rest);
    case "get":
      return await runGet(rest);
    case "rm":
    case "remove":
      return await runRemove(rest);
    case "index":
      return await runIndex(rest);
    case "route":
      return await runRoute(rest);
    case undefined:
    case "--help":
    case "-h":
    case "help":
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

interface AddDraft {
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

const ADD_VALUE_FLAGS = new Set([
  "--path",
  "--purpose",
  "--stack",
  "--rag-node",
  "--rag-collection",
  "--rag-glob",
  "--rag-schedule",
  "--route",
]);

function parseStackList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRoutePair(pair: string, routes: Record<string, string>): string | null {
  const eqIndex = pair.indexOf("=");
  if (eqIndex === -1) {
    return `--route expects <taskKind>=<target>, got '${pair}'`;
  }
  const key = pair.slice(0, eqIndex).trim();
  const value = pair.slice(eqIndex + 1).trim();
  if (!key || !value) {
    return `--route expects a non-empty taskKind and target`;
  }
  routes[key] = value;
  return null;
}

function assignProjectAddFlag(
  draft: AddDraft,
  flag: string,
  value: string | undefined,
): string | null {
  switch (flag) {
    case "--path":
      draft.path = value ?? "";
      return null;
    case "--purpose":
      draft.purpose = value;
      return null;
    case "--stack":
      draft.stack = parseStackList(value ?? "");
      return null;
    case "--rag-node":
      draft.ragNode = value;
      return null;
    case "--rag-collection":
      draft.ragCollection = value;
      return null;
    case "--rag-glob":
      draft.ragGlob = value;
      return null;
    case "--rag-schedule":
      draft.ragSchedule = value;
      return null;
    case "--route":
      return parseRoutePair(value ?? "", draft.routes);
    default:
      return `Unknown flag: ${flag}`;
  }
}

function consumeProjectAddValueFlag(
  draft: AddDraft,
  args: string[],
  i: number,
  arg: string,
): { next: number } | { error: string } | null {
  if (ADD_VALUE_FLAGS.has(arg)) {
    const error = assignProjectAddFlag(draft, arg, args[i + 1]);
    return error ? { error } : { next: i + 2 };
  }
  const eq = arg.indexOf("=");
  if (eq >= 0 && ADD_VALUE_FLAGS.has(arg.slice(0, eq))) {
    const error = assignProjectAddFlag(draft, arg.slice(0, eq), arg.slice(eq + 1));
    return error ? { error } : { next: i + 1 };
  }
  return null;
}

function consumeProjectAddArg(
  draft: AddDraft,
  args: string[],
  i: number,
): { next: number } | { error: string } {
  const arg = required(args[i]);
  const viaValueFlag = consumeProjectAddValueFlag(draft, args, i, arg);
  if (viaValueFlag) return viaValueFlag;
  if (arg === "-h" || arg === "--help") return { error: "help" };
  if (arg.startsWith("-")) return { error: `Unknown flag: ${arg}` };
  if (!draft.name) {
    draft.name = arg;
    return { next: i + 1 };
  }
  return { error: `Unexpected argument: ${arg}` };
}

function validateProjectAdd(draft: AddDraft): AddOpts | { error: string } {
  if (!draft.name) return { error: "project add: <name> is required" };
  if (!draft.path) return { error: "project add: --path is required" };
  if ((draft.ragNode && !draft.ragCollection) || (!draft.ragNode && draft.ragCollection)) {
    return { error: "project add: --rag-node and --rag-collection must be set together" };
  }
  return {
    name: draft.name,
    path: draft.path,
    purpose: draft.purpose,
    stack: draft.stack,
    ragNode: draft.ragNode,
    ragCollection: draft.ragCollection,
    ragGlob: draft.ragGlob,
    ragSchedule: draft.ragSchedule,
    routes: draft.routes,
  };
}

function parseAddFlags(args: string[]): AddOpts | { error: string } {
  const draft: AddDraft = {
    name: "",
    path: "",
    purpose: undefined,
    stack: [],
    ragNode: undefined,
    ragCollection: undefined,
    ragGlob: undefined,
    ragSchedule: undefined,
    routes: {},
  };
  let i = 0;
  while (i < args.length) {
    const step = consumeProjectAddArg(draft, args, i);
    if ("error" in step) return step;
    i = step.next;
  }
  return validateProjectAdd(draft);
}

function buildProjectSpec(parsed: AddOpts): Record<string, unknown> {
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
  return spec;
}

async function runAdd(args: string[]): Promise<number> {
  const parsed = parseAddFlags(args);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const manifest = {
    apiVersion: "llamactl/v1",
    kind: "Project",
    metadata: { name: parsed.name },
    spec: buildProjectSpec(parsed),
  };
  const manifestYaml = stringifyYaml(manifest);
  try {
    const res = await client().projectApply.mutate({ manifestYaml });
    process.stdout.write(
      `${res.created ? "applied" : "updated"} project '${res.name}'\n  path: ${res.path}\n`,
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
  let file = "";
  for (let i = 0; i < args.length; i++) {
    const arg = required(args[i]);
    if (arg === "-f" || arg === "--file") {
      file = args[++i] ?? "";
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    } else if (arg === "-h" || arg === "--help") {
      return { error: "help" };
    } else if (arg.startsWith("-")) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!file) return { error: "project apply: -f <file.yaml> is required" };
  return { file };
}

function readManifestFromStdin(): string | null {
  let manifestYaml: string;
  try {
    manifestYaml = readFileSync(0, "utf8");
  } catch (err) {
    process.stderr.write(
      `project apply: failed reading manifest from stdin: ${(err as Error).message}\n`,
    );
    return null;
  }
  if (!manifestYaml.trim()) {
    process.stderr.write("project apply: stdin was empty — pipe a Project YAML in.\n");
    return null;
  }
  return manifestYaml;
}

function readManifestFromFile(file: string): string | null {
  const absPath = resolve(file);
  if (!existsSync(absPath)) {
    process.stderr.write(`project apply: file not found: ${absPath}\n`);
    return null;
  }
  return readFileSync(absPath, "utf8");
}

async function runApply(args: string[]): Promise<number> {
  const parsed = parseApplyFlags(args);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const manifestYaml =
    parsed.file === "-" ? readManifestFromStdin() : readManifestFromFile(parsed.file);
  if (manifestYaml === null) return 1;
  try {
    const res = await client().projectApply.mutate({ manifestYaml });
    process.stdout.write(
      `${res.created ? "applied" : "updated"} project '${res.name}'\n  path: ${res.path}\n`,
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
    if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") {
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
      process.stdout.write("(no projects registered)\n");
      return 0;
    }
    for (const p of res.projects) {
      const ragLine = p.spec.rag ? `rag=${p.spec.rag.node}/${p.spec.rag.collection}` : "rag=<none>";
      const routeCount = Object.keys(p.spec.routing).length;
      process.stdout.write(
        `${p.metadata.name}\n  path: ${p.spec.path}\n  ${ragLine}  routes=${String(routeCount)}\n`,
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
  let name = "";
  let json = false;
  for (const arg_ of args) {
    const arg = arg_;
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
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
  if (!name || name.startsWith("-")) {
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
  if (!name || name.startsWith("-")) {
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
  let json = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--json") json = true;
    else positional.push(a);
  }
  const [name, taskKind] = positional;
  if (!name || name.startsWith("-")) {
    process.stderr.write(`project route: <name> is required\n\n${USAGE}`);
    return 1;
  }
  if (!taskKind || taskKind.startsWith("-")) {
    process.stderr.write(`project route: <taskKind> is required\n\n${USAGE}`);
    return 1;
  }
  try {
    // Use the Phase 3 `projectRoutePreview` path — it runs the
    // full in-dispatch routing resolution (including budget
    // checks when wired) against a `project:<name>/<taskKind>`
    // node name, without journaling or firing a chat.
    const res = await client().projectRoutePreview.query({
      node: `project:${name}/${taskKind}`,
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    if (!res.decision) {
      // Should be unreachable (the node prefix guarantees a decision)
      // but keep the fallback useful.
      process.stdout.write(`${name}/${taskKind} → ${res.node}\n`);
      return 0;
    }
    const d = res.decision;
    const budgetNote = d.budget
      ? ` · budget ${d.budget.usdToday?.toFixed(4) ?? "?"}/${d.budget.limit?.toFixed(2) ?? "?"} USD`
      : "";
    process.stdout.write(`${name}/${taskKind} → ${d.target} (${d.reason})${budgetNote}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`project route: ${(err as Error).message}\n`);
    return 1;
  }
}
