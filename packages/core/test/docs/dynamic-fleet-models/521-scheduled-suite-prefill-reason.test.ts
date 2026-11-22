import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: scheduled suite prefill reason slice.
// Source pins run before doc pins so a source mutant surfaces its own
// needle; the doc assertions fail at base because the reason does not
// exist yet.
describe("#521 scheduled suite prefill reason", () => {
  const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/runner.ts"));
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));

  const benchBody = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");
  const prefillBody = enclosingBody(runnerSrc, "async function runPrefillSize(");

  const loadSec = flat(sectionBody(/^### Load and prefill metrics for an arm/) ?? "");
  const declSec = flat(sectionBody(/^### Declared quant and context for a suite schedule/) ?? "");

  // Kills: the runner ignoring opts.prefillReason or checking it after
  // the context guard; createPerfBenchSuiteRunner dropping prefillReason,
  // passing a literal placeholder, or ordering it before loadReason.
  test("source pins prefillReason in the runner and the suite runner", () => {
    expect(runnerSrc).toContain("prefillReason?: string;");
    expect(prefillBody).toContain("run.opts.prefillReason");
    const reasonAt = prefillBody.indexOf("run.opts.prefillReason");
    expect(reasonAt).toBeGreaterThanOrEqual(0);
    expect(reasonAt).toBeLessThan(prefillBody.indexOf('"model context unknown"'));
    expect(benchBody).toContain(
      "const prefillReason = `prefill for ${req.rel} on node '${req.node}' is not measured; scheduled suites reach the engine through the agent gateway, which forwards only /v1/* and not the engine's /tokenize`;",
    );
    const start = benchBody.indexOf("ev.runPerfSuite)(db, {");
    expect(start).toBeGreaterThanOrEqual(0);
    const loadReasonAt = benchBody.indexOf("loadReason,", start);
    const prefillReasonAt = benchBody.indexOf("prefillReason,", start);
    expect(loadReasonAt).toBeGreaterThan(start);
    expect(prefillReasonAt).toBeGreaterThan(loadReasonAt);
  });

  // Kills: the doc drifting from the reason text in bench-schedule.ts.
  test("doc pins the rendered prefill reason in the load section", () => {
    const m = /const prefillReason = `([^`]+)`;/.exec(benchBody);
    expect(m).not.toBeNull();
    const rendered = (m?.[1] ?? "")
      .replaceAll("${req.rel}", "<rel>")
      .replaceAll("${req.node}", "<node>");
    expect(loadSec).toContain(`\`${rendered}\``);
    expect(loadSec).toContain("A scheduled suite never measures prefill");
    expect(loadSec).toContain("even when the schedule declares `--ctx`");
  });

  // Kills: the doc keeping the stale no-context prefill claims, or the
  // declared-provenance section losing the gateway-reason guard.
  test("doc drops the stale scheduled-suite prefill claims", () => {
    expect(loadSec).not.toContain("A scheduled suite sets no model context");
    expect(declSec).not.toContain("a declared `--ctx` also bounds the prefill sizes");
    expect(declSec).toContain(
      "a scheduled suite still records the gateway prefill reason for every prefill size",
    );
    expect(declSec).toContain(
      "without a declared `--quant` or `--ctx`, that field is recorded null with the gateway reason",
    );
  });
});
