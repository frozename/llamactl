// packages/app/test/console/manifest.test.ts
// Issue #410, P5a RED — pins the console module manifest: exactly four
// modules (fleet, workloads, nodes, logs) in shell order, each with a
// non-empty label and a console path outside /api. The retired Electron
// modules (chat, models, settings, projects) must never come back
// through this registry. The module does not exist at the base commit,
// so every case fails by assertion through the import-catch pattern —
// never by import error.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync, readdirSync } from "../../src/safe-fs.js";

const MANIFEST_SPEC = "../../src/console/console-manifest.ts";

interface ConsoleModuleEntry {
  id: string;
  label: string;
  path: string;
}

interface ConsoleManifestModule {
  CONSOLE_MODULES?: ConsoleModuleEntry[];
}

async function importManifest(): Promise<ConsoleManifestModule | null> {
  return (await import(MANIFEST_SPEC).catch(() => null)) as ConsoleManifestModule | null;
}

describe("console module manifest (#410 P5a)", () => {
  test("lists exactly fleet, workloads, nodes, logs in order", async () => {
    const mod = await importManifest();
    expect(mod?.CONSOLE_MODULES).toBeDefined();

    expect(mod!.CONSOLE_MODULES!.map((entry) => entry.id)).toEqual([
      "fleet",
      "workloads",
      "nodes",
      "logs",
    ]);
  });

  test("every entry has a non-empty label", async () => {
    const mod = await importManifest();
    expect(mod?.CONSOLE_MODULES).toBeDefined();

    for (const entry of mod!.CONSOLE_MODULES!) {
      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  test("every entry has a console path outside /api", async () => {
    const mod = await importManifest();
    expect(mod?.CONSOLE_MODULES).toBeDefined();

    for (const entry of mod!.CONSOLE_MODULES!) {
      expect(entry.path.startsWith("/")).toBe(true);
      expect(entry.path.startsWith("/api")).toBe(false);
    }
  });

  test("module ids are unique", async () => {
    const mod = await importManifest();
    expect(mod?.CONSOLE_MODULES).toBeDefined();

    const ids = mod!.CONSOLE_MODULES!.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no retired module ids are present", async () => {
    const mod = await importManifest();
    expect(mod?.CONSOLE_MODULES).toBeDefined();

    const ids = mod!.CONSOLE_MODULES!.map((entry) => entry.id);
    for (const retired of ["chat", "models", "settings", "projects"]) {
      expect(ids).not.toContain(retired);
    }
  });

  test("shipped modules equal the console manifest (#410 P7-A RED 5)", async () => {
    const mod = await importManifest();
    expect(mod?.CONSOLE_MODULES).toBeDefined();

    const modulesDir = join(import.meta.dir, "..", "..", "src", "modules");
    expect(existsSync(join(modulesDir, "registry.ts"))).toBe(false);

    const moduleIds = new Set(mod!.CONSOLE_MODULES!.map((entry) => entry.id));
    const shipped = readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(shipped.filter((name) => !moduleIds.has(name))).toEqual([]);
  });
});
