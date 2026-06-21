#!/usr/bin/env bun
// Strict typecheck gate. Runs `tsc` against tsconfig.eslint.json (exactOptionalPropertyTypes
// + noPropertyAccessFromIndexSignature) and fails ONLY on errors in llamactl's own code.
//
// @nova/* (node_modules file: deps) and ../penumbra/* are consumed as raw-.ts dependencies,
// so tsc follows into their source and applies our strict settings to THEIR code. Those
// errors are out of this repo's control, so they are filtered out here. (nova's own
// typecheck:strict needs no such filter — it has no raw-.ts external deps.)
const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", "tsconfig.eslint.json"], {
  stdout: "pipe",
  stderr: "pipe",
});

const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
const errorLines = output.split("\n").filter((line) => /error TS\d+/.test(line));

function isDependencyError(line: string): boolean {
  const file = line.split("(")[0] ?? "";
  if (file.includes("node_modules") || file.startsWith("..")) return true;
  // A llamactl file that cannot resolve a sibling-repo module (../penumbra, @nova):
  // those source deps are absent in CI's clean checkout, so this is a dependency-
  // availability issue, not a llamactl type bug. A real llamactl typo references a
  // llamactl path and is still reported.
  return /Cannot find module ['"][^'"]*(?:penumbra|nova)/.test(line);
}

const ownErrors = errorLines.filter((line) => !isDependencyError(line));

if (ownErrors.length > 0) {
  process.stdout.write(`${ownErrors.join("\n")}\n`);
  process.stderr.write(`typecheck:strict: ${String(ownErrors.length)} error(s) in llamactl code\n`);
  process.exit(1);
}

const ignored = errorLines.length - ownErrors.length;
process.stdout.write(
  `typecheck:strict: clean (${String(ignored)} dependency-source error(s) ignored)\n`,
);
