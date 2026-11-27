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

const APPLY_PROFILE = join(REPO, "packages/remote/src/residency/apply-profile.ts");

describe("#519 profile-switch refusal retry docs", () => {
  test("D1: the status/plan/apply-profile section documents the refusal retry read-out", () => {
    // kills: the docs omitting the read-out.
    expectPins(flat(sectionBody(SECTIONS.statusPlanApply) ?? ""), "refusal retry docs", [
      "`retryAfterMs`",
      "`Cooldown`",
      "`MinResidency`",
      "`Retry in:`",
      "`refusal.retryAfterMs`",
      "`refusal.workloads`",
      "`; workloads: <names>`",
      "`; retry in <t>`",
      "`formatRefusalRetry`",
      "older agent",
    ]);
  });

  test("D2: the retry read-out is shared by the renderers and copied by plannerRefusal", () => {
    // kills: hand-rolled duration formatting in either renderer, or a parallel refusal builder.
    const cli = readOrEmpty(RESIDENCY_CLI);
    const formatRetry = enclosingBody(cli, "export function formatRefusalRetry(");
    expect(formatRetry).not.toBe("");
    expect(formatRetry).toContain("Number.isFinite(");
    expect(formatRetry).toContain("formatMs(");

    const renderPlan = enclosingBody(cli, "export function renderResidencyPlan(");
    expect(renderPlan).toContain("formatRefusalRetry(");
    expect(renderPlan).toContain("Retry in:");

    const failureLine = enclosingBody(cli, "function applyProfileFailureLine(");
    expect(failureLine).toContain("formatRefusalRetry(");
    expect(failureLine).toContain("; retry in ");
    expect(failureLine).toContain("; workloads: ");

    const applyProfile = readOrEmpty(APPLY_PROFILE);
    const plannerRefusal = enclosingBody(applyProfile, "function plannerRefusal(");
    expect(plannerRefusal).toContain("retryAfterMs");
    expect(plannerRefusal).toContain("workloads");
  });
});
