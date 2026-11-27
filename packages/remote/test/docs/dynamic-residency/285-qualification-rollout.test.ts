import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { expectPins, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

describe("DF-12 qualification and rollback runbook (#285)", () => {
  test("manual rollback requires teardown proof and a fresh reservation before victim start", () => {
    const manual = flat(sectionBody(sectionRe("stage 1 - manual switch")) ?? "");
    const hold = "Keep the committed reservation, fence and lifecycle rows intact";
    const proof = "prove the exact replacement generation is down and its capacity is released";
    const reserve = "obtain a fresh finite reservation before restoring any victim";
    expectPins(manual, "manual rollback", [
      "process-local",
      hold,
      proof,
      reserve,
      "Keep the node out of the canary",
    ]);
    expect(manual.indexOf(proof)).toBeLessThan(manual.indexOf(reserve));
    expect(manual).not.toContain("then `llamactl apply -f` the prior manifest");
    const update = readOrEmpty(join(REPO, "docs/self-update.md"));
    expect(update).toContain("A binary rollback cannot resolve an unknown residency operation");
    const deployment = readOrEmpty(join(REPO, "docs/deployment-mac-mini.md"));
    expect(deployment).toContain("dynamic-residency.md#staged-enable-order-and-rollback");
  });

  test("hardware evidence and native activation have separate opt-in gates", () => {
    const qualification = flat(sectionBody(sectionRe("qualification evidence")) ?? "");
    expectPins(qualification, "qualification", [
      "Hermetic PASS",
      "Hardware PASS",
      "BLOCKED",
      "baseline → canary → restored baseline",
      "full observed wall-clock window",
      "swap-in and swap-out deltas",
      "existing quorum rules",
    ]);
    const native = flat(sectionBody(sectionRe("stage 3 - native unload/wake")) ?? "");
    expectPins(native, "native rollout", [
      "BLOCKED",
      "production caller",
      "probe-induced wake",
      "whole-process",
    ]);
  });

  test("the evidence template has empty comparison windows and no activation approval", () => {
    const example = sectionBody(sectionRe("evidence manifest example")) ?? "";
    const json = /```json\n([\s\S]*?)\n```/.exec(example)?.[1];
    expect(json).toBeDefined();
    expect(JSON.parse(json ?? "null") as unknown).toMatchObject({
      schemaVersion: 1,
      sourceCommit: null,
      stage: 0,
      activationApproved: false,
      builds: { controller: null, agent: null, engine: null },
      workerCapabilities: [],
      hermetic: { status: "NOT_RUN", evidence: [] },
      hardware: {
        status: "NOT_RUN",
        backend: null,
        cases: [],
        windows: { baseline: null, canary: null, restoredBaseline: null },
      },
      rollback: { trigger: null, restorationEvidence: null },
      blockers: ["No hardware qualification has been run"],
    });
  });
});
