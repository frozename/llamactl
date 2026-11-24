import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: declared suite launch flags slice (`--flags=<args>` on
// `bench schedule add`, the schedule schema's flags field, the loop's
// flags forwarding, the CLI-side runner's flags validation and
// provenance input, and the doc subsection). Source pins run before doc
// pins so a source mutant surfaces its own needle; the doc subsection
// does not exist at base, so the doc assertions fail.
describe("#521 scheduled suite declared launch flags", () => {
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const scheduleSchemaSrc = readOrEmpty(join(REPO, "packages/remote/src/bench/schedule.ts"));
  const loopSrc = readOrEmpty(join(REPO, "packages/remote/src/bench/scheduleLoop.ts"));

  const sec = flat(sectionBody(/^### Declared launch flags for a suite schedule/) ?? "");

  // Kills: the runner skipping flags validation or the provenance input,
  // planAddArgs skipping the --flags gate, or the schema/loop dropping
  // the field.
  test("source pins flags validation and forwarding", () => {
    const runner = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");
    expect(runner, "runner asserts declared flags").toContain("assertDeclaredLaunchFlags(req)");
    expect(runner, "runner forwards flags to provenance").toContain("flags: req.flags");
    expect(runner, "runner drops the hard-coded flags: []").not.toContain("flags: [],");

    expect(
      enclosingBody(benchScheduleSrc, "function assertDeclaredLaunchFlags("),
      "assertDeclaredLaunchFlags names the schedule",
    ).toContain("invalid flags for schedule");

    expect(
      enclosingBody(benchScheduleSrc, "function planAddArgs("),
      "planAddArgs validates --flags",
    ).toContain("validateFlagsArg(");

    expect(benchScheduleSrc).toContain("--flags is only valid when kind is 'suite'");
    expect(benchScheduleSrc).toContain("--flags must list at least one launch flag");
    expect(scheduleSchemaSrc).toContain("flags is only valid with kind 'suite'");
    expect(
      enclosingBody(loopSrc, "function declaredProvenanceFields("),
      "declaredProvenanceFields forwards flags",
    ).toContain("schedule.flags");
  });

  // Kills: deleting or misplacing the declared-flags doc text.
  test("doc pins the declared launch flags contract", () => {
    expect(sec.length).toBeGreaterThan(0);
    for (const needle of [
      "A suite schedule can declare the engine launch flags with `--flags=<args>`",
      "`--flags is only valid when kind is 'suite'`",
      "`--flags must list at least one launch flag`",
      "`flags is only valid with kind 'suite'`",
      "`invalid flags for schedule '<id>' (expected a non-empty list of launch-flag tokens)`",
      "without a declared `--flags`, `flags` is recorded null with the gateway reason",
      "A space-separated `--flags` value is refused when it starts with a dash",
      "--flags must be attached with '=' when its value starts with '-'; use --flags=\"...\"",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: the subsection landing outside the scheduled-suite block or
  // under a new ## parent.
  test("the subsection sits between the declared quant/ctx and comparing sections", () => {
    const lines = doc.split("\n");
    const indexOf = (re: RegExp): number => lines.findIndex((line) => re.test(line));
    const quantIdx = indexOf(/^### Declared quant and context for a suite schedule/);
    const flagsIdx = indexOf(/^### Declared launch flags for a suite schedule/);
    const compareIdx = indexOf(/^### Comparing perf runs for an arm/);
    expect(quantIdx).toBeGreaterThanOrEqual(0);
    expect(compareIdx).toBeGreaterThan(quantIdx);
    expect(flagsIdx).toBeGreaterThan(quantIdx);
    expect(flagsIdx).toBeLessThan(compareIdx);
    expect(lines.slice(quantIdx, compareIdx).some((line) => line.startsWith("## "))).toBe(false);
  });

  // Kills: doc error strings drifting from the code strings — every
  // backticked error form naming flags must appear verbatim in a source
  // file, with the doc's <id> placeholder rendered as ${req.scheduleId}.
  test("every doc error string appears verbatim in the sources", () => {
    expect(sec.length).toBeGreaterThan(0);
    const quoted = [...sec.matchAll(/`([^`]+)`/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    const errors = [
      ...new Set(
        quoted.filter((s) => s.includes("flags ") && !s.includes('"') && /(?:'|\)|flag)$/.test(s)),
      ),
    ];
    expect(errors.length).toBeGreaterThanOrEqual(4);
    for (const error of errors) {
      const rendered = error.replaceAll("<id>", "${req.scheduleId}");
      expect(
        benchScheduleSrc.includes(rendered) || scheduleSchemaSrc.includes(rendered),
        `doc error appears in source: ${error}`,
      ).toBe(true);
    }
  });
});
