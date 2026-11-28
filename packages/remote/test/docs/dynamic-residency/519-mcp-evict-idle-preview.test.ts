import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #519
// Kills: shipping the MCP idle-eviction preview undocumented, registering it
// as a mutation, letting it forward wet-run targets, or auditing a read-only
// projection.
describe("#519 MCP residency.evictIdle dry-run preview", () => {
  test("D1: operator idle eviction documents the read-only MCP preview contract", () => {
    const section = flat(sectionBody(SECTIONS.operatorIdleEviction) ?? "");

    expectPins(section, "mcp evict-idle preview", [
      "`llamactl.residency.evictIdle`",
      "`packages/mcp/src/tools/residency.ts`",
      "read-only preview of this dry run",
      "never sends `targets`",
      "never stamps the idle hold or stops a workload",
      "`llamactl residency evict-idle --node <name> --yes`",
      "writes no audit line",
    ]);
  });

  test("D2: residency tool source pins registration, read-only projection and no wet inputs", () => {
    const src = readOrEmpty(join(REPO, "packages/mcp/src/tools/residency.ts"));

    const registry = enclosingBody(src, "export function registerResidencyTools(");
    expect(registry).toContain("registerResidencyEvictIdle(server);");

    const evictIdle = enclosingBody(src, "function registerResidencyEvictIdle(");
    expect(evictIdle).not.toBe("");
    expect(evictIdle).toContain("caller.residencyEvictIdle({ node: input.node })");
    expect(evictIdle).toContain("readOnlyHint: true");
    expect(evictIdle).not.toContain("targets:");
    expect(evictIdle).not.toContain("appendAudit");
  });
});
