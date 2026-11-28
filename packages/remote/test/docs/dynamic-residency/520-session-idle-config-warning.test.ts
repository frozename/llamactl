import { describe, expect, test } from "bun:test";

import {
  AGENT_CLI,
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #520
describe("#520 session-idle config warning", () => {
  test("D1: leases section documents startup warnings and the no-registry signal", () => {
    const body = flat(sectionBody(SECTIONS.leases) ?? "");
    expectPins(body, "leases section", [
      "warning: LLAMACTL_RESIDENCY_SESSION_IDLE_MS is set but LLAMACTL_RESIDENCY_LEASES is off; no session registry is installed, so bound sessions do not block unloads",
      "warning: LLAMACTL_RESIDENCY_SESSION_IDLE_MS is not a positive integer of milliseconds; ignoring it, so no session registry is installed",
      "`residency status`",
      "`NoRegistry`",
      "it means set to a positive integer",
      "when managed residency is enabled",
      "nonempty `executionAdmission` list",
    ]);
  });

  test("D2a: agent startup checks the effective options for the residency warning", () => {
    const src = readOrEmpty(AGENT_CLI);
    const body = enclosingBody(src, "async function runServe(");
    expect(body).toContain("residencySessionConfigWarning(process.env, options, managed)");
  });

  test("D2b: serve usage documents warning-only rejection and the leases-off case", () => {
    const src = readOrEmpty(AGENT_CLI);
    const usage = /const SERVE_USAGE = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
    expect(usage).not.toBe("");
    const text = flat(usage);
    expect(text).toContain("ignored with a startup warning");
    expect(text).toContain(
      "LLAMACTL_RESIDENCY_LEASES, managed residency, or execution admission groups",
    );
  });
});
