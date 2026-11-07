// Issue #410 P5a-3b RED — pins the web entry point. src/main.web.tsx
// must exist and its static import graph must reach the console shell,
// the workloads view and the stop-server action without touching the
// Electron renderer entry, the module registry or the retired
// workloads components; src/index.web.html must mount it on #root and
// must not carry the Google Fonts links the Electron page ships. The
// mount itself is pinned with a stubbed createRoot + document, and the
// web build is pinned to index.web.html as its input with the rename
// plugin emitting index.html. Every case fails by assertion — never
// by import error.

import type { ComponentType, ReactElement } from "react";
import type { Plugin, PluginOption, Rollup } from "vite";

import { afterAll, describe, expect, mock, test } from "bun:test";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StrictMode } from "react";

import { existsSync, readFileSync } from "../../src/safe-fs.js";
import webConfig from "../../vite.web.config";

const APP_DIR = join(import.meta.dir, "..", "..");
const SRC_DIR = join(APP_DIR, "src");
const ENTRY = join(SRC_DIR, "main.web.tsx");
const HTML = join(SRC_DIR, "index.web.html");

const transpiler = new Bun.Transpiler({ loader: "tsx" });

function resolveSpecifier(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = resolve(dirname(importer), specifier);
  } else if (specifier.startsWith("@/")) {
    base = join(SRC_DIR, specifier.slice(2));
  } else {
    return null;
  }
  if ((base.endsWith(".ts") || base.endsWith(".tsx")) && existsSync(base)) {
    return base;
  }
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function reachableFrom(entry: string): Set<string> {
  const reached = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = relative(APP_DIR, file);
    if (reached.has(rel)) continue;
    reached.add(rel);
    const code = readFileSync(file, "utf8");
    for (const imp of transpiler.scanImports(code)) {
      if (imp.kind !== "import-statement") continue;
      const resolved = resolveSpecifier(imp.path, file);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return reached;
}

const uiReal = { ...(await import("../../src/ui/index")) };
void mock.module("@/ui", () => uiReal);

interface RootStub {
  readonly id: string;
}
const rootStub: RootStub = { id: "root" };
interface MountRecord {
  container: unknown;
  element: ReactElement;
}
const createRootCalls: MountRecord[] = [];
const reactDomClientReal = { ...(await import("react-dom/client")) };
void mock.module("react-dom/client", () => ({
  createRoot: (container: unknown): { render: (element: ReactElement) => void } => ({
    render: (element: ReactElement): void => {
      createRootCalls.push({ container, element });
    },
  }),
}));

const globalWithDocument = globalThis as {
  document?: { getElementById(id: string): unknown } | undefined;
};
const hadDocument = "document" in globalThis;
const prevDocument = globalWithDocument.document;
// The entry module body runs exactly once per resolved specifier, so
// the missing-#root case re-imports it under a cache-busting query and
// flips this flag to make the same stub report an absent #root.
let missingRootRequested = false;
globalWithDocument.document = {
  getElementById: (id: string): unknown => {
    if (missingRootRequested) return null;
    return id === rootStub.id ? rootStub : null;
  },
};

void (await import("../../src/main.web.tsx"));
const shellMod = (await import("../../src/console/ConsoleShell.tsx")) as {
  ConsoleShell?: ComponentType;
};

afterAll(() => {
  void mock.module("@/ui", () => uiReal);
  void mock.module("react-dom/client", () => reactDomClientReal);
  if (hadDocument) {
    globalWithDocument.document = prevDocument;
  } else {
    delete globalWithDocument.document;
  }
});

function childOf(element: ReactElement): ReactElement {
  return (element.props as { children: ReactElement }).children;
}

function flattenPlugins(option: PluginOption, out: Plugin[]): void {
  if (!option || typeof option === "boolean") return;
  if (Array.isArray(option)) {
    for (const entry of option) flattenPlugins(entry, out);
    return;
  }
  if ("then" in option) return;
  out.push(option);
}

function renamePlugin(): Plugin {
  const plugins: Plugin[] = [];
  flattenPlugins(webConfig.plugins, plugins);
  const found = plugins.find((plugin) => plugin.name === "llamactl-rename-web-entry");
  expect(found).toBeDefined();
  return found!;
}

function webBuildInput(): string {
  const rollupOptions = webConfig.build?.rollupOptions;
  expect(rollupOptions).toBeDefined();
  const input = rollupOptions?.input;
  if (typeof input === "string" || Array.isArray(input) || input === undefined) {
    throw new Error(`expected a named input object, got ${String(input)}`);
  }
  const entry = input["index"];
  if (typeof entry !== "string") {
    throw new Error(`rollupOptions.input.index must be a path string, got ${String(entry)}`);
  }
  return entry;
}

describe("web entry mount (#410 P5a-3b)", () => {
  test("the entry renders ConsoleShell in StrictMode into the #root element", () => {
    expect(createRootCalls).toHaveLength(1);
    const mount = createRootCalls[0]!;
    expect(mount.container).toBe(rootStub);
    expect(mount.element.type).toBe(StrictMode);
    expect(childOf(mount.element).type).toBe(shellMod.ConsoleShell!);
    expect(typeof shellMod.ConsoleShell).toBe("function");
  });

  test("a document without #root throws 'Root element missing' and mounts nothing", async () => {
    missingRootRequested = true;
    let threw = false;
    let error: unknown;
    try {
      // A non-literal specifier keeps tsc from resolving the cache-busting query.
      const missingRootEntry = "../../src/main.web.tsx?missing-root";
      await import(missingRootEntry);
    } catch (caught) {
      threw = true;
      error = caught;
    } finally {
      missingRootRequested = false;
    }
    expect(threw).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Root element missing");
    expect(createRootCalls).toHaveLength(1);
  });
});

describe("web build config (#410 P5a-3b)", () => {
  test("the build takes src/index.web.html as its only input", () => {
    const input = webBuildInput();
    expect(basename(input)).toBe("index.web.html");
    expect(basename(dirname(input))).toBe("src");
  });

  test("the build roots at the app src dir and empties its output dir", () => {
    const root = webConfig.root;
    expect(typeof root).toBe("string");
    if (typeof root !== "string") return;
    expect(isAbsolute(root)).toBe(true);
    expect(basename(root)).toBe("src");
    expect(webConfig.build?.emptyOutDir).toBe(true);
  });

  test("the rename plugin emits index.web.html as index.html", () => {
    const hook = renamePlugin().generateBundle;
    expect(typeof hook).toBe("function");
    if (typeof hook !== "function") return;
    const bundle: Rollup.OutputBundle = {
      "index.web.html": {
        type: "asset",
        fileName: "index.web.html",
        name: undefined,
        names: [],
        originalFileName: null,
        originalFileNames: [],
        needsCodeReference: false,
        source: '<!doctype html><div id="root"></div>',
      },
    };
    void hook.call({} as Rollup.PluginContext, {} as Rollup.NormalizedOutputOptions, bundle, false);
    expect(bundle["index.web.html"]).toBeUndefined();
    expect(bundle["index.html"]).toBeDefined();
    expect(bundle["index.html"]?.fileName).toBe("index.html");
  });

  test("the rename plugin is a no-op when the web entry asset is absent", () => {
    const hook = renamePlugin().generateBundle;
    expect(typeof hook).toBe("function");
    if (typeof hook !== "function") return;
    const bundle: Rollup.OutputBundle = {};
    void hook.call({} as Rollup.PluginContext, {} as Rollup.NormalizedOutputOptions, bundle, false);
    expect(Object.keys(bundle)).toHaveLength(0);
  });
});

describe("web entry point (#410 P5a-3b)", () => {
  test("src/main.web.tsx exists", () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  test("the web entry's static graph reaches the console and stays off the Electron renderer", () => {
    const reached = existsSync(ENTRY) ? reachableFrom(ENTRY) : new Set<string>();
    for (const required of [
      "src/console/ConsoleShell.tsx",
      "src/console/views/workloads.tsx",
      "src/console/actions/stop-server.tsx",
    ]) {
      expect(reached.has(required)).toBe(true);
    }
    for (const excluded of [
      "src/App.tsx",
      "src/main.tsx",
      "src/modules/registry.ts",
      "src/modules/workloads/apply-panel.tsx",
      "src/modules/workloads/workload-row.tsx",
    ]) {
      expect(reached.has(excluded)).toBe(false);
    }
  });

  test("src/index.web.html mounts main.web.tsx on #root without web fonts", () => {
    expect(existsSync(HTML)).toBe(true);
    const html = existsSync(HTML) ? readFileSync(HTML, "utf8") : "";
    expect(html).toContain('<div id="root"');
    expect(html).toContain('<script type="module" src="./main.web.tsx">');
    expect(html).not.toContain("fonts.googleapis.com");
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
    for (const script of scripts) {
      const openEnd = script.indexOf(">");
      expect(script.slice(0, openEnd + 1)).toContain("src=");
      const body = script.slice(openEnd + 1, script.lastIndexOf("</script>"));
      expect(body.trim()).toBe("");
    }
  });
});
