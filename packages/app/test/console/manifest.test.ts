// The dashboard is the landing route. Detail pages retain their own paths.

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
  test("places Dashboard first, followed by the fleet and detail views", async () => {
    const mod = await importManifest();
    expect(mod?.CONSOLE_MODULES).toBeDefined();

    expect(mod!.CONSOLE_MODULES!.map((entry) => entry.id)).toEqual([
      "dashboard",
      "fleet",
      "workloads",
      "nodes",
      "logs",
      "stats",
      "runs",
      "chat",
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
    for (const retired of ["models", "settings", "projects"]) {
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
