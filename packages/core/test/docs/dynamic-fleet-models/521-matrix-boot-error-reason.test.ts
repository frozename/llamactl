import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

const runner = readOrEmpty(join(REPO, "packages/eval/src/matrix/runner.ts"));
const S = flat(sectionBody(/^### Unscored matrix cells for an arm/) ?? "");

describe("#521 matrix boot error reason documentation", () => {
  // Kills: documenting the reason as absent, omitting either prefix, or letting
  // multi-line stderr tails into the documented cell contract.
  test("D1 unscored matrix cells document stored boot error reasons", () => {
    for (const needle of [
      '`per_class_metrics_json` `{"error":"<reason>"}`',
      "`model boot failed: <first line of the boot error>`",
      "`judge <judge> boot failed: <first line of the boot error>`",
      "only the first line of the boot error is stored",
      "a boot error cell reads `no rows scored (model boot failed: <first line of the boot error>)`",
    ]) {
      expect(S, needle).toContain(needle);
    }
  });

  // Kills: storing {}, omitting the reason argument at either caller, changing
  // the judge prefix, or dropping the first-line split.
  test("D2 runner stores first-line boot error reasons byte-for-byte", () => {
    const bootBody = enclosingBody(runner, "function recordBootError(");
    expect(bootBody).toContain("per_class_metrics_json: JSON.stringify({ error }),");

    const modelCellsBody = enclosingBody(runner, "async function runModelCells(");
    expect(modelCellsBody).toContain('const reason = bootErrorReason("model boot failed", err);');
    expect(modelCellsBody).toContain(
      "recordBootError(model, opts.workloads, runId, opts.db, reason)",
    );

    const workloadBody = enclosingBody(runner, "async function runWorkloadCell(");
    expect(workloadBody).toContain(
      "const reason = bootErrorReason(`judge ${judge.name} boot failed`, err);",
    );
    expect(workloadBody).toContain("recordBootError(model, [workload], runId, opts.db, reason)");

    const bootErrorReasonBody = enclosingBody(runner, "function bootErrorReason(");
    expect(bootErrorReasonBody.length).toBeGreaterThan(0);
    expect(bootErrorReasonBody).toContain(String.raw`.split("\n")[0]`);
  });

  // Kills: writing line-number citations that go stale.
  test("D3 the section has no runner file:line citations", () => {
    expect(/runner\.ts:\d/.test(S)).toBe(false);
  });
});
