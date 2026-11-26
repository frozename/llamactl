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
// Kills: shipping the MCP server.stop fence mapping undocumented, leaving the
// stale raw-result contract in the docs, or implementing the tool without the
// shared ops-chat refusal helper exported for it.
describe("#520 MCP server.stop stop-fence refusal", () => {
  test("D1 session affinity documents the MCP isError refusal contract", () => {
    const affinity = flat(sectionBody(sectionRe("session affinity")) ?? "");
    expectPins(affinity, "session affinity", [
      "MCP `llamactl.server.stop`",
      "`isError`",
      "`stop_refused`",
      "serverStop refused by the node stop fence (<reason>: <ids>); nothing was stopped",
    ]);
    expect(affinity).not.toContain("still returns the raw result");
  });

  test("D2 server-control wires the shared refusal helper exported from remote", () => {
    const serverControl = readOrEmpty(join(REPO, "packages/mcp/src/tools/server-control.ts"));
    const stop = enclosingBody(
      serverControl,
      "function registerServerStop(server: McpServer): void {",
    );
    expect(stop, "registerServerStop signature").not.toBe("");
    expectPins(stop, "registerServerStop", ["opsChatStopRefusal(", "isError: true"]);

    const index = readOrEmpty(join(REPO, "packages/remote/src/index.ts"));
    const dispatchExport =
      /export\s*\{([^}]*)\}\s*from\s*"\.\/ops-chat\/dispatch\.js"/.exec(index)?.[1] ?? "";
    expect(dispatchExport).toContain("opsChatStopRefusal");
  });
});
