import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: `llamactl eval perf-diff` wires perfDiffMain into the eval
// dispatcher. Source pins run before doc pins; at base the dispatch case,
// the runEvalPerfDiff wrapper, the USAGE line and the doc text are all
// missing, so every case fails by assertion.
describe("#521 llamactl eval perf-diff (comparing perf runs)", () => {
  const evalSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval.ts"));

  // Kills: removing the `case "perf-diff"` dispatch or the runEvalPerfDiff
  // call, or pointing the wrapper at the wrong entry point.
  test("dispatch routes perf-diff through runEvalPerfDiff to perfDiffMain(argv, process.env)", () => {
    const runBody = enclosingBody(evalSrc, "export async function runEval(");
    for (const needle of ['case "perf-diff":', "runEvalPerfDiff(rest)"]) {
      expect(runBody, needle).toContain(needle);
    }
    for (const needle of ['case "run":', 'case "report":', 'case "leaderboard":', 'case "perf":']) {
      expect(runBody, needle).toContain(needle);
    }
    expect(enclosingBody(evalSrc, "function runEvalPerfDiff(")).toContain(
      "perfDiffMain(argv, process.env)",
    );
  });

  // Kills: the perf-diff USAGE line going missing, or drifting to an
  // interpolated line.
  test("USAGE lists the perf-diff synopsis verbatim", () => {
    const line =
      "  perf-diff --base <run_id> --candidate <run_id> [--db <path>] [--model <name>] [--format md|json] [--tolerance <fraction>]";
    expect(evalSrc.split("\n")).toContain(line);
    expect(evalSrc).not.toMatch(/\n {2}\$\{[A-Z_]+\}\n/);
  });

  // Kills: the doc going stale against the verb, or the verb shipping
  // without a doc update.
  test("comparing perf runs section names the verb and its delegation", () => {
    const s = flat(sectionBody(/^### Comparing perf runs for an arm/) ?? "");
    for (const needle of [
      "`llamactl eval perf-diff`",
      "the `run`, `report`, `leaderboard`, `perf` and `perf-diff` subcommands (`runEval`, `packages/cli/src/commands/eval.ts`)",
      "delegates to `perfDiffMain`",
      "the same exit codes and `perf-diff:` messages",
    ]) {
      expect(s, needle).toContain(needle);
    }
    expect(s).not.toContain("There is no `llamactl` verb for it");
  });
});
