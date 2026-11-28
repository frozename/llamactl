import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: perf I/O counter-decrease semantics. Source pins run before
// doc pins so an implementation mutant surfaces its own needle; the decrease
// reason and doc text do not exist at base, so these pins fail by assertion.
describe("#521 perf I/O counter decreases", () => {
  const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/runner.ts"));
  const runIoPhaseBody = enclosingBody(runnerSrc, "async function runIoPhase(");
  const sec = flat(sectionBody(/^### Host reader failures for an arm/) ?? "");
  const decreaseTemplate =
    "`I/O counters decreased between the start and end samples (read_bytes <start> -> <end>, write_bytes <start> -> <end>); the sampled process likely restarted`";

  test("source pins the shared counter-decrease reason", () => {
    expect(runIoPhaseBody).toContain("I/O counters decreased between the start and end samples");
    expect(runIoPhaseBody).toContain("the sampled process likely restarted");
  });

  test("source does not clamp a decreased counter to zero", () => {
    expect(runIoPhaseBody).not.toContain("Math.max(0,");
  });

  test("doc pins the decrease template and the zero-delta boundary", () => {
    expect(doc).toContain("### Host reader failures for an arm");
    expect(sec).toContain(decreaseTemplate);
    expect(sec).toContain("equal start and end counters record 0");
    expect(sec).toContain("`runIoPhase`");
  });
});
