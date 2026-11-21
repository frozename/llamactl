import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: declared suite provenance slice (`--quant`/`--ctx` on
// `bench schedule add`, the schedule schema's quant/ctx fields, the loop's
// provenance forwarding, the CLI-side runner's quant/ctx validation and
// provenance inputs). Source pins run before doc pins so a source mutant
// surfaces its own needle; the doc subsection does not exist at base, so
// the doc assertions fail.
describe("#521 scheduled suite declared provenance", () => {
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));

  const sec = flat(sectionBody(/^### Declared quant and context for a suite schedule/) ?? "");

  // Kills: deleting or misplacing the declared-provenance doc text.
  test("doc pins the declared quant/ctx contract", () => {
    for (const needle of [
      "A suite schedule can declare the quant label with `--quant <label>` and the context size with `--ctx <n>`",
      "`--quant is only valid when kind is 'suite'`",
      "`--ctx is only valid when kind is 'suite'`",
      "`--ctx must be a positive integer`",
      "`--quant must be a non-blank quant label`",
      "without a declared `--quant` or `--ctx`, that field is recorded null with the gateway reason",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: the runner passing quant/ctx through unvalidated, or
  // planAddArgs skipping the --quant/--ctx gate.
  test("source pins provenance validation in the runner and add planning", () => {
    const runner = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");
    expect(runner, "runner validates ctx").toContain("invalid ctx");
    expect(runner, "runner validates quant").toContain("invalid quant");
    expect(
      enclosingBody(benchScheduleSrc, "function planAddArgs("),
      "planAddArgs validates --quant/--ctx",
    ).toContain("validateProvenanceArgs(");
  });
});
