import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: declared suite HF revision slice (`--hf-revision` on
// `bench schedule add`, the schedule schema field, loop forwarding, runner
// validation and provenance input, and the doc subsection). Source pins run
// before doc pins so a source mutant surfaces its own needle.
describe("#521 scheduled suite declared hf revision", () => {
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const scheduleSchemaSrc = readOrEmpty(join(REPO, "packages/remote/src/bench/schedule.ts"));
  const loopSrc = readOrEmpty(join(REPO, "packages/remote/src/bench/scheduleLoop.ts"));

  const sec = flat(sectionBody(/^### Declared HF revision for a suite schedule/) ?? "");

  // Kills: the runner skipping hfRevision validation or the provenance input,
  // planAddArgs skipping the --hf-revision gate, or the schema/loop dropping
  // the field.
  test("source pins hfRevision validation and forwarding", () => {
    const runner = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");
    expect(runner, "runner forwards hfRevision to provenance").toContain(
      "hf_revision: req.hfRevision",
    );
    expect(runner, "runner validates hfRevision").toContain("assertDeclaredHfRevision(req)");
    expect(
      enclosingBody(benchScheduleSrc, "function assertDeclaredHfRevision("),
      "assertDeclaredHfRevision names the bad value",
    ).toContain("invalid hfRevision");

    expect(
      enclosingBody(benchScheduleSrc, "function planAddArgs("),
      "planAddArgs validates launch args",
    ).toContain("validateLaunchArgs(");
    expect(
      enclosingBody(benchScheduleSrc, "function validateLaunchArgs("),
      "validateLaunchArgs validates --hf-revision",
    ).toContain("validateHfRevisionArg(");

    expect(benchScheduleSrc).toContain("--hf-revision is only valid when kind is 'suite'");
    expect(benchScheduleSrc).toContain(
      "--hf-revision must be a 40-character lowercase hex commit hash",
    );
    expect(scheduleSchemaSrc).toContain("hfRevision is only valid with kind 'suite'");
    expect(
      enclosingBody(loopSrc, "function declaredProvenanceFields("),
      "declaredProvenanceFields forwards hfRevision",
    ).toContain("schedule.hfRevision");
  });

  // Kills: deleting or misplacing the declared-HF-revision doc text.
  test("doc pins the declared HF revision contract", () => {
    expect(sec.length).toBeGreaterThan(0);
    expect(doc).toContain("### Declared HF revision for a suite schedule");
    for (const needle of [
      "--hf-revision is only valid when kind is 'suite'",
      "--hf-revision must be a 40-character lowercase hex commit hash",
      "hfRevision is only valid with kind 'suite'",
      "invalid hfRevision '<value>' for schedule '<id>' (expected a 40-character lowercase hex commit hash)",
      "validateHfRevisionArg",
      "runWithOutcome",
      "collectEvalProvenance",
      "createPerfBenchSuiteRunner",
      "no GGUF path to derive an HF revision from",
    ]) {
      expect(sec, needle).toContain(needle);
    }
    expect(benchScheduleSrc).toContain("no GGUF path to derive an HF revision from");
  });
});
