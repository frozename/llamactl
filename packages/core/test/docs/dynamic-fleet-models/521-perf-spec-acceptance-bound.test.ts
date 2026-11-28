import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

describe("#521 perf spec acceptance bound", () => {
  const normaliseSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/normalise.ts"));
  const acceptanceBody = enclosingBody(normaliseSrc, "export function normaliseAcceptance(");
  const evidence = flat(sectionBody(/^### Capturing evidence for an arm/) ?? "");

  test("S1 source pin: normaliseAcceptance refuses impossible acceptance", () => {
    expect(acceptanceBody).toContain("accepted > draft");
    expect(acceptanceBody).toContain("acceptance cannot exceed 1");
  });

  test("D1 doc pin: capturing evidence documents the spec_acceptance bound", () => {
    expect(doc).toContain("### Capturing evidence for an arm");
    expect(evidence).toContain("`spec_acceptance`");
    expect(evidence).toContain(
      "accepted draft tokens of <drafted> drafted; acceptance cannot exceed 1",
    );
    expect(evidence).toContain("normaliseAcceptance");
  });
});
