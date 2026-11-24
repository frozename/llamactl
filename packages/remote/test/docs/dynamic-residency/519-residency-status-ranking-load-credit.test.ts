import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  RESIDENCY_CLI,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #519
// Kills: shipping the load-credit read-out undocumented, or leaving the
// CLI renderer body, the MCP tool description or the ranking source
// stale.
describe("#519 residency status ranking load credit", () => {
  test("knobs section documents the loadCredited field and line", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(knobs, "ranking load credit", [
      "`loadCredited`",
      "`load credited: <workload> ready in <t>`",
    ]);
    expect(knobs).not.toContain("does not list the credit yet");
  });

  test("the CLI renderer prints the load credited line", () => {
    const body = enclosingBody(readOrEmpty(RESIDENCY_CLI), "function pushRankingLines(");
    expect(body).not.toBe("");
    expect(body).toContain("load credited:");
  });

  test("the MCP residency status description covers the load credit", () => {
    const src = readOrEmpty(join(REPO, "packages/mcp/src/tools/residency.ts"));
    expect(src).toContain("loadCredited");
  });

  test("the ranking read-out source carries the field and no stale gap text", () => {
    const src = readOrEmpty(join(REPO, "packages/remote/src/proxy/residency-ranking.ts"));
    expect(src).not.toContain("the readout does not list the credit yet");
    expect(src).toContain("loadCredited");
  });
});
