import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: declared suite slots slice (#521 `--slots` on
// `bench schedule add`, the schedule schema's slots field, the loop's
// slots forwarding, the CLI-side runner's slots/slotsReason split).
// Source pins run before doc pins so a source mutant surfaces its own
// needle; the doc subsection does not exist at base, so the doc
// assertions fail.
describe("#521 scheduled suite declared slots", () => {
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));

  const sec = flat(sectionBody(/^### Concurrency slots for c2 and c4/) ?? "");

  // Kills: deleting or misplacing the declared-slots doc text.
  test("doc pins the declared-slots contract", () => {
    for (const needle of [
      "A suite schedule can declare the slot count with `--slots <n>`",
      "`--slots is only valid when kind is 'suite'`",
      "`--slots must be a positive integer`",
      "without `--slots`, scheduled suite runs set no slot count",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: the runner passing req.slots through unvalidated, or
  // planAddArgs skipping the --slots gate.
  test("source pins slots validation in the runner and add planning", () => {
    expect(
      enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner("),
      "runner validates slots",
    ).toContain("invalid slots");
    expect(
      enclosingBody(benchScheduleSrc, "function planAddArgs("),
      "planAddArgs validates --slots",
    ).toContain("validateSlotsArg(");
  });
});
