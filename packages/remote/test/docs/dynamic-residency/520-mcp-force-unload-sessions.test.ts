import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  sectionBody,
  sectionRe,
} from "./helpers.js";

// Part of #520
// Kills: shipping the force-unload session read-out undocumented, or making
// the dry-run preview mutate sessions/leases instead of only reading them.
describe("#520 MCP force-unload session release", () => {
  test("D1 session affinity documents the force-unload session contract", () => {
    const affinity = flat(sectionBody(sectionRe("session affinity")) ?? "");
    expectPins(affinity, "session affinity", [
      "MCP `llamactl.residency.forceUnload`",
      "`wouldReleaseSessions`",
      "`sessionsDetail`",
    ]);
  });

  test("D2 forceUnload wires the session preview into its dry-run payload", () => {
    const src = readOrEmpty(join(REPO, "packages/mcp/src/tools/residency.ts"));
    const registration = enclosingBody(
      src,
      "function registerResidencyForceUnload(server: McpServer): void {",
    );
    expect(registration, "registerResidencyForceUnload signature").not.toBe("");
    expectPins(registration, "registerResidencyForceUnload", [
      "previewForceUnloadSessions(workload)",
      "wouldReleaseSessions",
    ]);
  });

  test("D3 the session preview only reads the installed registry", () => {
    const src = readOrEmpty(join(REPO, "packages/mcp/src/tools/residency.ts"));
    const helper = enclosingBody(src, "function previewForceUnloadSessions(");

    expect(helper, "previewForceUnloadSessions signature").not.toBe("");
    expectPins(helper, "previewForceUnloadSessions", [
      "currentSessionRefcounts()",
      "activeSessions(",
      "could not list sessions",
    ]);
    expect(helper).not.toContain("forceRelease(");
    expect(helper).not.toContain("checkUnload(");
    expect(helper).not.toContain("releaseSession(");
    expect(helper).not.toContain("residencyForceUnload(");
  });
});
