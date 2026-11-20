import { describe, expect, test } from "bun:test";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  RESIDENCY_CLI,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #519
// Kills: the docs not describing the status read-out, or the CLI renderer
// being renamed or removed.
describe("#519 residency status idle-eviction lines", () => {
  test("operator idle-eviction section documents the status Idle evict block", () => {
    const s = flat(sectionBody(SECTIONS.operatorIdleEviction) ?? "");
    expectPins(s, "idle-evict status", [
      "`llamactl residency status --node <name>` prints the `idleEviction` section as an `Idle evict:` block",
      "`pushIdleEvictionLines`",
      "`Idle evict: window <n>s, <k> ready workload(s) (advisory; scope: serving-process)`",
      "`due`",
      "`held MinResidency for <t>`",
      "`not due (due in <t>)`",
      "`not due (leased or draining)`",
      "`not due (activity unknown)`",
      "`Idle evict: disabled (scope: serving-process)`",
      "`Idle evict: unavailable (<detail>; scope: serving-process)`",
    ]);
    const body = enclosingBody(readOrEmpty(RESIDENCY_CLI), "function pushIdleEvictionLines(");
    expect(body).not.toBe("");
    expect(body).toContain("IDLE_EVICTION_UNAVAILABLE[");
  });
});
