import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: the doc sentence missing or reworded; keepAliveStartRefusal absent
// from packages/remote/src/router.ts; the gate placed after the detached
// `spawn("bun"` or before the duplicate-supervisor `verdict === "unknown"`
// check inside the keepAliveStart procedure; the helper missing
// resolveTarget or exclusiveGroupLaunchRefusal.
describe("#517 agent keep-alive start exclusive-group refusal", () => {
  test("doc and source pin the keepAliveStart exclusive-group refusal", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "The agent's `keepAliveStart` procedure (`packages/remote/src/router.ts`), which serves `llamactl keep-alive start` on remote dispatch, runs the same gate through `keepAliveStartRefusal` on the rel `resolveTarget` returns, after its duplicate-supervisor checks and before it spawns the detached `keep-alive worker`, so an occupied group returns `ok: false` with `error` set to the `keep-alive start: residency lifecycle refused ...` text and spawns nothing; the CLI prints that `error` and exits 1 (#517).",
    );

    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const blockStart = routerSrc.indexOf("keepAliveStart: t.procedure");
    const blockEnd = routerSrc.indexOf("candidateTestRun: t.procedure", blockStart);
    const block = blockStart === -1 || blockEnd === -1 ? "" : routerSrc.slice(blockStart, blockEnd);
    const gateAt = block.indexOf("keepAliveStartRefusal(");
    expect(gateAt, "keepAliveStart calls keepAliveStartRefusal").toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(block.indexOf('spawn("bun"'));
    expect(gateAt).toBeGreaterThan(block.indexOf('verdict === "unknown"'));

    const helperBody = enclosingBody(routerSrc, "function keepAliveStartRefusal(");
    expect(helperBody, "keepAliveStartRefusal body").not.toBe("");
    expect(helperBody).toContain("resolveTarget(");
    expect(helperBody).toContain("exclusiveGroupLaunchRefusal(");
  });
});
