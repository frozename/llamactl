import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: launch-flags provenance slice — `flags` joins
// PROVENANCE_UNAVAILABLE_FIELDS as a null-with-reason field. collectFlags
// owns the collector default, the bench-schedule runner and eval perf's
// buildProvenance own the caller reasons, and the doc pins the sentences.
// Source pins run before doc pins so a source mutant surfaces its own
// needle; every needle is absent at base, so each case fails by assertion.
describe("#521 provenance launch flags unavailable", () => {
  const typesSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/types.ts"));
  const provenanceSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/provenance.ts"));
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));

  const sec = flat(sectionBody(/^### Capturing evidence for an arm/) ?? "");
  const sched = flat(sectionBody(/^### Scheduled perf suites for an arm/) ?? "");

  const fieldsOpener = "export const PROVENANCE_UNAVAILABLE_FIELDS = [";
  const fieldsStart = typesSrc.indexOf(fieldsOpener);
  const fieldsEnd =
    fieldsStart === -1 ? -1 : typesSrc.indexOf("] as const", fieldsStart + fieldsOpener.length);
  const fieldsBody =
    fieldsStart === -1 || fieldsEnd === -1
      ? ""
      : typesSrc.slice(fieldsStart + fieldsOpener.length, fieldsEnd);

  // Kills: flags staying a plain string[] outside the unavailable set, or a
  // collector, runner or CLI caller that keeps guessing [] instead of
  // null + reason.
  test("source pins flags as an unavailable-capable provenance field", () => {
    expect(fieldsBody, "PROVENANCE_UNAVAILABLE_FIELDS lists flags").toContain('"flags"');
    expect(typesSrc, "EvalProvenance.flags admits null").toContain("flags: string[] | null;");
    expect(
      enclosingBody(provenanceSrc, "function collectFlags("),
      "collectFlags default reason",
    ).toContain("no engine launch flags supplied");

    const runner = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");
    expect(runner, "runner records the gateway flags reason").toContain(
      "through the agent gateway; the engine launch flags are not known",
    );
    expect(runner, "runner drops the hard-coded flags: []").not.toContain("flags: [],");

    const prov = enclosingBody(evalPerfSrc, "function buildProvenance(");
    expect(prov, "buildProvenance forwards flags").toContain("flags: input.flags");
    expect(prov, "buildProvenance names the absent --flags reason").toContain(
      `no --flags given; the launch flags of the engine at \${input.url} are not known`,
    );
  });

  // Kills: rewording or dropping the eval perf flags sentences; the
  // --flags-absent sentence gaining a file citation the 522 table lacks.
  test("doc pins the eval perf launch-flags contract", () => {
    for (const needle of [
      "`quant`, `ctx` and `flags` — is either a value or null with a reason in `provenance.unavailable`",
      'Without `--flags`, `flags` is recorded null with the reason "no --flags given; the launch flags of the engine at <url> are not known".',
      "`--quant`, `--ctx` and `--flags` fill their fields.",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: rewording or dropping the scheduled-suite flags sentence.
  test("doc pins the scheduled suite launch-flags reason", () => {
    expect(sched, "scheduled suite flags reason").toContain(
      "The launch `flags` are recorded null as well, with the reason `scheduled suites reach <rel> through the agent gateway; the engine launch flags are not known`.",
    );
  });
});
