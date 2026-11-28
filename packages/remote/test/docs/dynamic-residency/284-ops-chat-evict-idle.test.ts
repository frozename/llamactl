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

// Part of #284
// Kills: shipping the Ops Chat idle-eviction preview undocumented,
// re-tiering it as a mutation, or letting the dispatch forward wet-run
// target lists into residencyEvictIdle.
describe("#284 Ops Chat residency.evictIdle dry-run preview", () => {
  test("D1: operator idle eviction documents the read-only Ops Chat preview contract", () => {
    const section = flat(sectionBody(SECTIONS.operatorIdleEviction) ?? "");

    expectPins(section, "ops-chat evict-idle preview", [
      "`llamactl.residency.evictIdle`",
      "read-tier Ops Chat entry",
      "`packages/remote/src/ops-chat/dispatch.ts`",
      "forwards only `node`",
      "one Ops Chat audit entry",
    ]);
  });

  test("D2: dispatch source pins read registration and node-only forwarding", () => {
    const src = readOrEmpty(join(REPO, "packages/remote/src/ops-chat/dispatch.ts"));

    expect(src).toContain('name: "llamactl.residency.evictIdle", tier: "read"');

    const body = enclosingBody(src, "async function executeReadTool(");
    expect(body).not.toBe("");
    expect(body).toContain('caller.residencyEvictIdle({ node: requireString(args, "node") })');
    expect(body).not.toMatch(/targets\s*:/);
    expect(body).not.toContain("args.targets");
    expect(body).not.toContain('args["targets"]');
  });
});
