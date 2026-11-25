import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

describe("#518 qualification evidence from matrix doc", () => {
  // Kills: shipping the subcommand undocumented.
  test("qualification section documents the evidence command and matrix semantics", () => {
    const section = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    for (const needle of [
      "`llamactl qualification evidence --db <matrix.db> --model <name> --map <file.json> [--run-id <id>] [--baseline-run-id <id> [--baseline-model <name>]]`",
      "`qualificationEvidenceFromCells`",
      "n_rows-weighted mean of `primary_metric_value`",
      "`regression` and `improvement` are refused in the map",
      "`regression` is the fraction of compared workloads whose `primary_metric_value` dropped below the baseline",
      "Without `--baseline-run-id` the evidence carries no `regression` or `improvement`, so `propose` answers `insufficient-evidence`",
      "no matrix cell for model",
      "no baseline matrix cell for model",
      "`invalid evidence from matrix cells` for evidence values out of range",
      "opens the matrix db read-only and never writes the overrides file",
      "`matrix:<model>@<run ids>;baseline=<model>@<run id>`",
    ]) {
      expect(section, needle).toContain(needle);
    }
  });

  // Kills: unwiring the CLI from the adapter.
  test("the CLI and eval package wire the evidence adapter", () => {
    const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/qualification.ts"));
    expect(cli).toContain("qualificationEvidenceFromCells(");
    expect(cli).toContain("readMatrixCellRows(");

    const evalIndex = readOrEmpty(join(REPO, "packages/eval/src/index.ts"));
    expect(evalIndex).toContain("./qualification/evidence.js");
  });
});
