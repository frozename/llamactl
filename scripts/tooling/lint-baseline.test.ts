import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const out = join(root, "docs/quality/lint-baseline-2026-06-10.json");
const scriptsDir = join(root, "scripts");
let original: string;

describe("lint baseline capture", () => {
  beforeAll(() => {
    original = readFileSync(out, "utf8");
  });

  afterAll(() => {
    writeFileSync(out, original, "utf8");
  });

  it("writes a per-rule violation JSON to docs/quality/", () => {
    const proc = spawnSync("bun", ["run", "tooling/lint-baseline.ts"], {
      cwd: scriptsDir,
      encoding: "utf8",
      timeout: 700_000,
    });

    expect(proc.status).toBe(0);

    const data = JSON.parse(readFileSync(out, "utf8")) as {
      totals: { errors: number; warnings: number };
      byRule: Record<string, { errors: number; warnings: number }>;
      byFile: Record<string, { errors: number; warnings: number }>;
    };
    const byRuleErrors = Object.values(data.byRule).reduce((sum, item) => sum + item.errors, 0);
    const byRuleWarnings = Object.values(data.byRule).reduce((sum, item) => sum + item.warnings, 0);
    const byFileErrors = Object.values(data.byFile).reduce((sum, item) => sum + item.errors, 0);
    const byFileWarnings = Object.values(data.byFile).reduce((sum, item) => sum + item.warnings, 0);

    expect(byRuleErrors).toBe(data.totals.errors);
    expect(byRuleWarnings).toBe(data.totals.warnings);
    expect(byFileErrors).toBe(data.totals.errors);
    expect(byFileWarnings).toBe(data.totals.warnings);
  }, 800_000);
});
