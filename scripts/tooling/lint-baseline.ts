// scripts/tooling/lint-baseline.ts
// Thin CLI: delegates to lint-baseline-lib and writes the output path.

import { join } from "node:path";

import { runLintBaseline } from "./lint-baseline-lib.js";

const root = join(import.meta.dir, "..", "..");
const eslintBin = join(root, "node_modules", ".bin", "eslint");
const outDir = join(root, "docs/quality");

const outputPath = runLintBaseline({
  root,
  eslintBin,
  outDir,
  now: new Date(),
  env: process.env,
});

process.stdout.write(`wrote ${outputPath}\n`);
