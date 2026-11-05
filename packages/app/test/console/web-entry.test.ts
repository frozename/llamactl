// Issue #410 P5a-3b RED — pins the web entry point. src/main.web.tsx
// must exist and its static import graph must reach the console shell,
// the workloads view and the stop-server action without touching the
// Electron renderer entry, the module registry or the retired
// workloads components; src/index.web.html must mount it on #root and
// must not carry the Google Fonts links the Electron page ships. At the
// base commit neither file exists, so every case fails by assertion —
// never by import error.

import { describe, expect, test } from "bun:test";
import { dirname, join, relative, resolve } from "node:path";

import { existsSync, readFileSync } from "../../src/safe-fs.js";

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
