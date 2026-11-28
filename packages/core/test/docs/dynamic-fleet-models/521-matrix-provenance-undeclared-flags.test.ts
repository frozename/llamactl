import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// #521: matrix provenance launch flags documentation must name the undeclared-flags contract.
const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/runner.ts"));
const sec = flat(sectionBody(/^### Launch flags in matrix provenance$/) ?? "");

describe("#521 matrix provenance undeclared launch flags documentation", () => {
  test("D1: source pins the undeclared launch-flag reasons and provenance wiring", () => {
    expect(runnerSrc).toContain("declares no launch flags (engine ${engine} runs outside eval)");
    expect(runnerSrc).toContain(
      "declares no launch flags (managed=false, so eval does not launch it)",
    );
    expect(enclosingBody(runnerSrc, "function matrixProvenanceInput(")).toContain(
      "flagsUnavailableReason(",
    );
  });

  test("D2: byte-for-byte source reason templates are copied into the doc", () => {
    const matches =
      runnerSrc.match(/`ModelSpec \$\{model\.name\} declares no launch flags \([^`]*\)`/g) ?? [];
    expect(matches).toHaveLength(2);

    for (const match of matches) {
      const documented = match
        .slice(1, -1)
        .replaceAll("${model.name}", "<name>")
        .replaceAll("${engine}", "<engine>");
      expect(sec).toContain(`\`${documented}\``);
    }
  });

  test("D3: doc pins the matrix launch-flags provenance contract", () => {
    for (const needle of [
      "`matrixProvenanceInput`",
      "`flagsUnavailableReason`",
      "`packages/eval/src/matrix/runner.ts`",
      "`isExternalOnlyEngine`",
      "`extra_args`",
      "`validateModelSpec`",
      "`(none)`",
      "`unavailable (<reason>)`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  test("D4: placement follows matrix report provenance without crossing a level-2 heading", () => {
    const lines = doc.split("\n");
    const reportIdx = lines.indexOf("### Provenance in a matrix report");
    const launchFlagsIdx = lines.indexOf("### Launch flags in matrix provenance");

    expect(reportIdx).toBeGreaterThanOrEqual(0);
    expect(launchFlagsIdx).toBeGreaterThan(reportIdx);
    expect(lines.slice(reportIdx + 1, launchFlagsIdx).some((line) => line.startsWith("## "))).toBe(
      false,
    );
  });
});
