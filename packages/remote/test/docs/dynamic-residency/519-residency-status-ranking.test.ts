import { describe, expect, test } from "bun:test";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  RESIDENCY_CLI,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #519
// Kills: the docs not describing the ranking status read-out, or the CLI
// renderer or the shared readout being renamed or removed.
describe("#519 residency status ranking", () => {
  test("knobs section documents the ranking status block", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(knobs, "ranking status", [
      "`ranking`",
      "`Ranking: resident preference <p>, cold-load penalty <c>ms (advisory; scope: serving-process)`",
      "`resident: <workloads>`",
      "`drain charged: <workloads>`",
      "`Ranking: disabled (scope: serving-process)`",
      "`Ranking: unavailable (<detail>; scope: serving-process)`",
      "`UnifiedProxyOff`",
      "`StoreAbsent`",
      "`pushRankingLines`",
      "`residencyRankingReadout`",
    ]);
    const body = enclosingBody(readOrEmpty(RESIDENCY_CLI), "function pushRankingLines(");
    expect(body).not.toBe("");
    expect(body).toContain("RANKING_UNAVAILABLE[");
  });
});
