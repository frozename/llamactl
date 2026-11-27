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
// Kills: shipping the MCP composite.destroy fence mapping undocumented, or
// implementing it without the shared ops-chat refusal helper.
describe("#520 MCP composite.destroy stop-fence refusal", () => {
  // Kills: leaving the stale sentence.
  // Kills: a GREEN that only deletes the stale sentence (an undocumented
  // mapping), and a doc that omits the code or the message.
  test("D1 session affinity documents the MCP isError destroy refusal contract", () => {
    const section = flat(sectionBody(sectionRe("session affinity")) ?? "");
    const start = section.indexOf("MCP `llamactl.composite.destroy` maps the same refusal");
    expect(start, "composite.destroy MCP mapping paragraph").toBeGreaterThanOrEqual(0);

    const paragraphOpener = section.indexOf("A response-cache hit", start);
    const blankLine = section.indexOf("\n\n", start);
    const ends = [paragraphOpener, blankLine].filter((index) => index >= 0);
    const end = ends.length > 0 ? Math.min(...ends) : Math.min(section.length, start + 1200);
    const slice = section.slice(start, end);

    // These tokens also occur elsewhere in the section at the base (lines 76
    // and 84), so they must be pinned inside the slice and never section-wide.
    expectPins(slice, "composite.destroy MCP mapping", [
      "`isError`",
      "`manifestPreserved: true`",
      "`code: destroy_refused`",
      "composite/<name> not destroyed: a workload stop was refused; manifest preserved",
      "`ok: false`",
      "release-session",
    ]);
    expect(section).not.toContain("is not mapped yet");
  });

  // Kills: a mapping that does not use the shared helper.
  test("D2 composite registration wires the shared refusal helper", () => {
    const composites = readOrEmpty(join(REPO, "packages/mcp/src/tools/composites.ts"));
    const destroy = enclosingBody(
      composites,
      "function registerCompositeDestroy(server: McpServer): void {",
    );
    expect(destroy, "registerCompositeDestroy signature").not.toBe("");
    expectPins(destroy, "registerCompositeDestroy", [
      "opsChatStopRefusal(",
      '"llamactl.composite.destroy"',
      "isError: true",
    ]);
  });
});
