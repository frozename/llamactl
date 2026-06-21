import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readdirSync, readFileSync, statSync } from "../src/safe-fs.js";

/**
 * Renderer source (packages/app/src/**) is bundled into the Electron
 * renderer, which runs in a browser context with NO Bun runtime. The
 * renderer tsconfig (tsconfig.web.json) keeps the "bun" ambient types
 * because the electron/trpc/* glue it also compiles legitimately runs
 * under Bun — but that means a `bun:*` builtin import or a `Bun` global
 * reference in renderer source would typecheck cleanly and then crash at
 * runtime. This guard fails CI on any such usage so renderer code stays
 * browser-safe. electron/** (which does run under Bun) is intentionally
 * out of scope; only src/** is scanned.
 */

const SRC_DIR = join(import.meta.dir, "..", "src");

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
});
