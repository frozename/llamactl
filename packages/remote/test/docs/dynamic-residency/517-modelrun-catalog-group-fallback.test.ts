import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517

const DOC_SENTENCE =
  "When that label is absent, `serverStart` takes the group from the catalog row of the rel `resolveTarget` returns for its `target` input, the same fallback `admit measure` uses; a label always wins, so a label naming an undeclared group opts the run out (#517).";

describe("#517 ModelRun catalog residency-group fallback", () => {
  test("the direct ModelHost start and stop section documents the catalog fallback", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");

    expect(section).toContain(DOC_SENTENCE);
  });

  test("catalogTargetGroup resolves the input target before reading the catalog row", () => {
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const groupBody = enclosingBody(routerSrc, "function catalogTargetGroup(");

    expect(groupBody).not.toBe("");
    expect(groupBody).toContain("targetMod.resolveTarget(target)");
    expect(groupBody).toContain("catalog.findByRel(rel)");
    expect(groupBody).toContain("?.residencyGroup");
  });

  test("directModelRunStartOpts composes the label opts with the catalog fallback", () => {
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const startOpts = enclosingBody(routerSrc, "function directModelRunStartOpts(");

    expect(startOpts).not.toBe("");
    expect(startOpts).toContain("directModelRunOpts(workload)");
    expect(startOpts).toContain("catalogTargetGroup(target)");
  });

  test("serverStart passes the input target to the start opts helper", () => {
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const start = routerSrc.indexOf("serverStart: t.procedure");
    const end = start === -1 ? -1 : routerSrc.indexOf("lmstudioScan: t.procedure", start);
    const block = start === -1 || end === -1 ? "" : routerSrc.slice(start, end);

    expect(block).toContain("directModelRunStartOpts(input.workload, input.target)");
    expect(block).not.toContain("directModelRunOpts(input.workload)");
  });
});
