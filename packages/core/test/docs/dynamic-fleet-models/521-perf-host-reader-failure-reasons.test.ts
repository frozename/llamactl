import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: perf host reader failure reasons slice
// Source pins run before doc pins so a source mutant surfaces its own
// needle; the doc subsection does not exist at base, so the doc
// assertions fail.
describe("#521 perf host reader failure reasons", () => {
  const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/runner.ts"));
  const readersSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/readers.ts"));

  const readPeakGttBody = enclosingBody(runnerSrc, "async function readPeakGtt(");
  const gttReasonBody = enclosingBody(runnerSrc, "function gttObservationReason(");
  const runIoPhaseBody = enclosingBody(runnerSrc, "async function runIoPhase(");
  const runMemoryPhaseBody = enclosingBody(runnerSrc, "async function runMemoryPhase(");
  const readerErrorBody = enclosingBody(runnerSrc, "function readerErrorMessage(");
  const hostReadersBody = enclosingBody(readersSrc, "export function createPerfHostReaders(");

  const sec = flat(sectionBody(/^### Host reader failures for an arm/) ?? "");

  test("source pins: the runner names each reader failure reason", () => {
    expect(readPeakGttBody).toContain("GTT reader failed: ");
    expect(gttReasonBody).toContain("(status: ");
    expect(gttReasonBody).toContain(", source: ");
    expect(gttReasonBody).toContain("usedBytes: ");
    expect(runIoPhaseBody).toContain("I/O reader failed: ");
    expect(runMemoryPhaseBody).toContain("peak-RSS (VmHWM) reader failed: ");
    expect(readerErrorBody).toContain("instanceof Error");
  });

  test("guard: shipped host readers still turn a failed /proc read into null", () => {
    expect(hostReadersBody).toContain("catch {");
    expect(hostReadersBody).toContain("return null;");
  });

  test("doc subsection sits after the load and prefill metrics subsection", () => {
    expect(sec.length).toBeGreaterThan(0);
    const lines = doc.split("\n");
    const hostIdx = lines.findIndex((line) =>
      line.startsWith("### Host reader failures for an arm"),
    );
    const loadIdx = lines.indexOf("### Load and prefill metrics for an arm");
    expect(hostIdx).toBeGreaterThan(loadIdx);
    expect(lines.slice(loadIdx + 1, hostIdx).some((line) => line.startsWith("## "))).toBe(false);
  });

  test("doc pins the reader failure reason templates", () => {
    for (const needle of [
      "`I/O reader failed: <message>`",
      "`I/O reader returned no sample`",
      "`peak-RSS (VmHWM) reader failed: <message>`",
      "`peak-RSS (VmHWM) reader returned no sample`",
      "`GTT reader failed: <message>`",
      "`GTT reader returned no sample`",
      "`GTT reader returned no sample (status: <status>)`",
      "`GTT reader returned no sample (status: <status>, source: <source>)`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  test("doc pins the probe, runner and reader names", () => {
    for (const needle of ["probeGpuGtt", "runPerfSuite", "createPerfHostReaders"]) {
      expect(sec, needle).toContain(needle);
    }
  });

  test("doc pins the probe statuses", () => {
    for (const needle of ["denied", "unavailable", "unsupported"]) {
      expect(sec, needle).toContain(needle);
    }
  });

  test("doc pins the failure-semantics phrases", () => {
    for (const needle of [
      "never recorded as 0",
      "turns a failed /proc read into null",
      "only to an injected reader that throws",
      "reports an empty source",
      "status-only form",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });
});
