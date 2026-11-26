import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  flat,
  readOrEmpty,
  REPO,
  RESIDENCY_CLI,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #520
// Kills: the docs hiding the status-side session hold, the CLI renderer ignoring
// sessionHold, or the eviction mutation growing a parallel session probe instead
// of sharing probeSessionHold with the status row builder.
describe("#520 residency status idle-evict session hold", () => {
  const operatorSection = flat(sectionBody(SECTIONS.operatorIdleEviction) ?? "");

  for (const pin of [
    "`held SessionsActive: <ids>`",
    "`held SessionsUnknown`",
    "`sessionHold`",
    "The status read-out never releases sessions",
  ] as const) {
    test(`operator idle-eviction section pins ${pin}`, () => {
      expect(operatorSection).toContain(pin);
    });
  }

  test("pushIdleEvictionLines reads sessionHold", () => {
    const body = enclosingBody(readOrEmpty(RESIDENCY_CLI), "function pushIdleEvictionLines(");
    expect(body).not.toBe("");
    expect(body).toContain("sessionHold");
  });

  test("idleEvictionRowFor shares probeSessionHold", () => {
    const procedures = readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"));
    const body = enclosingBody(procedures, "function idleEvictionRowFor(");
    expect(body).not.toBe("");
    expect(body).toContain("probeSessionHold(");
  });

  test("idleEvictSessionHold shares probeSessionHold", () => {
    const procedures = readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"));
    const body = enclosingBody(procedures, "function idleEvictSessionHold(");
    expect(body).not.toBe("");
    expect(body).toContain("probeSessionHold(");
  });
});
