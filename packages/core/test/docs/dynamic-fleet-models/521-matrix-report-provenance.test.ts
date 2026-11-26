// #521 RED: the matrix report provenance contract must stay documented beside the arm docs.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

describe("#521 matrix report provenance documentation", () => {
  const reportSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/report.ts"));
  const cliSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/cli.ts"));
  const sec = flat(sectionBody(/^### Provenance in a matrix report/) ?? "");

  for (const needle of [
    '"## Provenance"',
    '"| Run | Model | Field | Value |"',
    '"not recorded"',
    '"(none)"',
    '"(all)"',
    "PERF_PROVENANCE_DIFF_FIELDS",
  ]) {
    test(`source pin ${needle}`, () => {
      expect(reportSrc, needle).toContain(needle);
    });
  }

  test("source pin writeReport loads matrix provenance", () => {
    expect(enclosingBody(cliSrc, "export async function writeReport(")).toContain(
      "listMatrixProvenance(",
    );
  });

  for (const needle of [
    "`## Provenance`",
    "`| Run | Model | Field | Value |`",
    "`unavailable (<reason>)`",
    "`unavailable (not recorded)`",
    "`(none)`",
    "`(all)`",
    "`PERF_PROVENANCE_DIFF_FIELDS`",
    "`--report-all-runs`",
    "`writeReport`",
    "`packages/eval/src/matrix/cli.ts`",
    "The CSV report carries no provenance.",
  ]) {
    test(`doc pin ${needle}`, () => {
      expect(sec, needle).toContain(needle);
    });
  }

  test("placement follows the host reader failures subsection without crossing a level-2 heading", () => {
    const lines = doc.split("\n");
    const hostIdx = lines.indexOf("### Host reader failures for an arm");
    const provenanceIdx = lines.indexOf("### Provenance in a matrix report");

    expect(hostIdx).toBeGreaterThanOrEqual(0);
    expect(provenanceIdx).toBeGreaterThan(hostIdx);
    expect(lines.slice(hostIdx + 1, provenanceIdx).some((line) => line.startsWith("## "))).toBe(
      false,
    );
  });
});
