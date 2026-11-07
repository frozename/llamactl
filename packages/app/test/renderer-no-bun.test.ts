import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readdirSync, readFileSync, statSync } from "../src/safe-fs.js";

/**
 * The retained web console bundles packages/app/src/** for the browser,
 * which runs with NO Bun runtime. packages/app keeps
 * ["vite/client","node","bun"] ambient types because @llamactl/remote
 * and core are type-resolved from raw .ts that uses Bun — so a `bun:*`
 * builtin import or a `Bun` global reference in src/** would typecheck
 * cleanly and then crash at runtime. The src/** regex guard below is
 * what keeps the browser bundle Bun-free; the second case pins that the
 * guard still covers the whole retained app — no stray .ts/.tsx may sit
 * outside src/ other than the two root configs.
 */

const APP_DIR = join(import.meta.dir, "..");
const SRC_DIR = join(import.meta.dir, "..", "src");

const PRUNED_DIR_NAMES = new Set([
  "node_modules",
  "out",
  "dist",
  "test",
  "e2e",
  "test-results",
  "playwright-report",
]);
const RETAINED_ROOT_CONFIGS = new Set(["vite.web.config.ts", "playwright.config.ts"]);

const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /\bBun\s*\./, label: "the `Bun` global" },
  { pattern: /["'`]bun:[a-z]/, label: "a `bun:` builtin module" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function appSourceFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix === "" ? entry : join(prefix, entry);
    if (statSync(full).isDirectory()) {
      if (!PRUNED_DIR_NAMES.has(entry)) {
        out.push(...appSourceFiles(full, rel));
      }
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(rel);
    }
  }
  return out;
}

describe("renderer source is Bun-free", () => {
  test("no packages/app/src file references the Bun global or a bun: module", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [i, line] of lines.entries()) {
        for (const { pattern, label } of FORBIDDEN) {
          if (pattern.test(line)) {
            offenders.push(`${file}:${String(i + 1)} references ${label} — ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the src/** scan covers the whole retained app", () => {
    const outsideSrc = appSourceFiles(APP_DIR, "").filter(
      (rel) => !rel.startsWith("src/") && !RETAINED_ROOT_CONFIGS.has(rel),
    );
    expect(outsideSrc).toEqual([]);
  });
});
