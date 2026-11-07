// packages/app/test/console/web-graph-electron-free.test.ts
// Issue #410, P7-A regression ban — the web console graph must stay
// free of the Electron IPC bridge. A static walk from every src/console
// module (plus the HTTP transport root and src/main.web.tsx) resolves
// each specifier through the "@/" alias and the usual extension list,
// then fails if any reached file — or its source text, which also
// catches the type-only imports Bun.Transpiler.scanImports drops —
// touches electron, electron-trpc, ipc-link, ui-client.electron or
// transport/ipc. A second pin bundles the four console entrypoints for
// the browser and fails if any output still references electronTRPC.
// The Electron renderer is gone (#410 P7-A); this guard keeps the
// bridge from ever growing back into the console graph.

import { describe, expect, test } from "bun:test";
import { dirname, join, relative, resolve } from "node:path";

import { existsSync, readdirSync, readFileSync, statSync } from "../../src/safe-fs.js";

const APP_DIR = join(import.meta.dir, "..", "..");
const SRC_DIR = join(APP_DIR, "src");
const CONSOLE_DIR = join(SRC_DIR, "console");
const WEB_ENTRY = join(SRC_DIR, "main.web.tsx");
const HTTP_TRANSPORT = join(SRC_DIR, "lib", "transport", "http.ts");
const SCOPED_PROVIDER = join(CONSOLE_DIR, "node-scoped-provider.tsx");

const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const transpiler = new Bun.Transpiler({ loader: "tsx" });

const BANNED_BARE_SPECIFIER = /^electron$|^electron-trpc(?:\/|$)/;
const BANNED_REACHED_PATH =
  /src\/lib\/transport\/ipc\.ts$|ipc-link|ui-client\.electron|\/electron\//;
const BANNED_SOURCE_TEXT =
  /\belectronTRPC\b|from\s+["'][^"']*(?:\/electron\/|electron-trpc|ipc-link|transport\/ipc)["']/;

function rel(path: string): string {
  return relative(APP_DIR, path);
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(entry.name)) {
      yield path;
    }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

type Resolution =
  | { kind: "bare"; specifier: string }
  | { kind: "file"; path: string }
  | { kind: "ignored" };

function resolveSpecifier(fromFile: string, specifier: string): Resolution {
  const clean = specifier.split(/[?#]/)[0] ?? specifier;
  if (clean.endsWith(".css")) {
    return { kind: "ignored" };
  }
  let base: string;
  if (clean.startsWith("@/")) {
    base = join(SRC_DIR, clean.slice(2));
  } else if (clean.startsWith(".")) {
    base = resolve(dirname(fromFile), clean);
  } else {
    return { kind: "bare", specifier: clean };
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (isFile(candidate)) {
      return { kind: "file", path: candidate };
    }
  }
  return { kind: "ignored" };
}

interface ConsoleGraph {
  sources: Map<string, string>;
  parents: Map<string, { from: string; specifier: string }>;
  bareImporters: Map<string, string>;
}

function seedRoots(graph: ConsoleGraph): string[] {
  const roots = [...sourceFiles(CONSOLE_DIR), HTTP_TRANSPORT];
  if (existsSync(WEB_ENTRY)) {
    roots.push(WEB_ENTRY);
  }
  roots.sort();
  const queue: string[] = [];
  for (const root of roots) {
    if (!graph.sources.has(root)) {
      graph.sources.set(root, readFileSync(root, "utf8"));
      queue.push(root);
    }
  }
  return queue;
}

function reachSourceFile(
  fromFile: string,
  specifier: string,
  path: string,
  graph: ConsoleGraph,
  queue: string[],
): void {
  if (!/\.tsx?$/.test(path) || graph.sources.has(path)) {
    return;
  }
  graph.sources.set(path, readFileSync(path, "utf8"));
  graph.parents.set(path, { from: fromFile, specifier });
  queue.push(path);
}

function scanReachedFile(file: string, graph: ConsoleGraph, queue: string[]): void {
  for (const scanned of transpiler.scanImports(graph.sources.get(file) ?? "")) {
    const resolution = resolveSpecifier(file, scanned.path);
    if (resolution.kind === "bare") {
      if (!graph.bareImporters.has(resolution.specifier)) {
        graph.bareImporters.set(resolution.specifier, file);
      }
    } else if (resolution.kind === "file") {
      reachSourceFile(file, scanned.path, resolution.path, graph, queue);
    }
  }
}

function walkConsoleGraph(): ConsoleGraph {
  const graph: ConsoleGraph = {
    sources: new Map(),
    parents: new Map(),
    bareImporters: new Map(),
  };
  const queue = seedRoots(graph);
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) {
      break;
    }
    scanReachedFile(file, graph, queue);
  }
  return graph;
}

function chainTo(graph: ConsoleGraph, file: string): string {
  const hops: string[] = [];
  let current = file;
  for (;;) {
    const parent = graph.parents.get(current);
    if (parent === undefined) {
      break;
    }
    hops.unshift(`${rel(parent.from)} ->${parent.specifier}`);
    current = parent.from;
  }
  hops.push(rel(file));
  return hops.join(" ");
}

function electronOffenders(graph: ConsoleGraph): string[] {
  const offenders: string[] = [];
  for (const [specifier, importer] of graph.bareImporters) {
    if (BANNED_BARE_SPECIFIER.test(specifier)) {
      offenders.push(`bare specifier "${specifier}" imported by ${rel(importer)}`);
    }
  }
  for (const [file, source] of graph.sources) {
    const reasons: string[] = [];
    if (BANNED_REACHED_PATH.test(file)) {
      reasons.push("banned path");
    }
    if (BANNED_SOURCE_TEXT.test(source)) {
      reasons.push("banned source text");
    }
    if (reasons.length > 0) {
      offenders.push(`${rel(file)} (${reasons.join(" + ")}) reached via ${chainTo(graph, file)}`);
    }
  }
  return offenders.sort();
}

const graph = walkConsoleGraph();

describe("web console graph stays electron-free (#410)", () => {
  test("no module reachable from src/console touches the Electron IPC bridge", () => {
    expect(electronOffenders(graph)).toEqual([]);
  });

  test("bundled console entrypoints contain no electronTRPC reference", async () => {
    const result = await Bun.build({
      entrypoints: [
        join(APP_DIR, "src/console/node-trpc.ts"),
        join(APP_DIR, "src/console/node-scoped-provider.tsx"),
        join(APP_DIR, "src/console/create-node-scope.ts"),
        join(APP_DIR, "src/console/actions/stop-server.tsx"),
      ],
      target: "browser",
      packages: "external",
      tsconfig: join(APP_DIR, "tsconfig.json"),
    });
    expect(result.success).toBe(true);
    const hits: string[] = [];
    for (const output of result.outputs) {
      if ((await output.text()).includes("electronTRPC")) {
        hits.push(output.path);
      }
    }
    expect(hits).toEqual([]);
  });

  test("positive control: the walk reaches the HTTP transport and the scoped provider", () => {
    expect(graph.sources.has(HTTP_TRANSPORT)).toBe(true);
    expect(graph.sources.has(SCOPED_PROVIDER)).toBe(true);
  });
});
