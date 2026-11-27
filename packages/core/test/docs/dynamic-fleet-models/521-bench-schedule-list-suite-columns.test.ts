import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: `bench schedule list` and `bench schedule status` render a
// schedule's kind and declared suite fields. Source pins run before doc pins;
// at base the section and both render helpers are missing, so D1-D4 fail by
// assertion.

const src = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
const sec = flat(sectionBody(/^### Listing suite schedules/) ?? "");

const FIELD_NAMES = ["engine", "slots", "quant", "ctx", "flags", "hfRevision"] as const;
const FIELD_LITERALS = FIELD_NAMES.map((name) => `${name}=`);

function backtickedNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function docFieldOrder(section: string): string[] {
  const at = section.indexOf("in the order");
  if (at === -1) return [];
  return backtickedNames(section.slice(at)).filter((name) =>
    (FIELD_NAMES as readonly string[]).includes(name),
  );
}

describe("#521 bench schedule list suite columns", () => {
  // Kills: ROW_HEADERS missing KIND/DECLARED, rowCells bypassing the two
  // helpers, or the helpers dropping the suite prefix, flags count, or HF revision.
  test("D1 source pins the columns and render helpers", () => {
    expect(src).toContain('"KIND",');
    expect(src).toContain('"DECLARED",');

    const rows = enclosingBody(src, "function rowCells(");
    expect(rows).toContain("scheduleKindCell(row)");
    expect(rows).toContain("declaredSuiteFieldsCell(row)");

    const declared = enclosingBody(src, "function declaredSuiteFieldsCell(");
    expect(declared).toContain("flags=");
    expect(declared).toContain("hfRevision=");
    expect(enclosingBody(src, "function scheduleKindCell(")).toContain("suite:");
  });

  // Kills: the section landing outside the declared-HF-revision/comparing
  // perf-run neighborhood, or a new level-2 heading splitting that neighborhood.
  test("D2 doc section is placed between the neighboring suite sections", () => {
    const lines = doc.split("\n");
    const listing = lines.indexOf("### Listing suite schedules");
    const hfRevision = lines.indexOf("### Declared HF revision for a suite schedule");
    const comparing = lines.indexOf("### Comparing perf runs for an arm");

    expect(hfRevision).toBeGreaterThanOrEqual(0);
    expect(comparing).toBeGreaterThan(hfRevision);
    expect(listing).toBeGreaterThan(hfRevision);
    expect(listing).toBeLessThan(comparing);
    expect(lines.slice(hfRevision + 1, comparing).some((line) => line.startsWith("## "))).toBe(
      false,
    );
  });

  // Kills: deleting the listing contract, omitting either verb, dropping the
  // fixed field order, or failing to name the implementation identifiers.
  test("D3 doc pins the listing contract", () => {
    expect(sec.length).toBeGreaterThan(0);
    for (const needle of [
      "llamactl bench schedule list",
      "llamactl bench schedule status",
      "`KIND`",
      "`DECLARED`",
      "`preset`",
      "`suite:<suite>`",
      "`-`",
      "`engine`, `slots`, `quant`, `ctx`, `flags`, `hfRevision`",
      "<field>=<value>",
      "the number of declared launch-flag tokens",
      "ROW_HEADERS",
      "scheduleKindCell",
      "declaredSuiteFieldsCell",
      "packages/cli/src/commands/bench-schedule.ts",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: the doc order drifting from the code, or the doc naming helper
  // identifiers that do not exist in bench-schedule.ts.
  test("D4 doc field order and identifiers cross-check the source", () => {
    const named = backtickedNames(sec);
    for (const identifier of ["ROW_HEADERS", "scheduleKindCell", "declaredSuiteFieldsCell"]) {
      if (named.includes(identifier)) expect(src, identifier).toContain(identifier);
    }

    const body = enclosingBody(src, "function declaredSuiteFieldsCell(");
    const positions = FIELD_LITERALS.map((literal, index) => ({
      literal,
      index,
      position: body.indexOf(literal),
    }));
    for (const entry of positions) {
      expect(entry.position, entry.literal).toBeGreaterThanOrEqual(0);
    }
    const sourceOrder = positions
      .sort((a, b) => a.position - b.position || a.index - b.index)
      .map((entry) => entry.literal.slice(0, -1));
    expect(docFieldOrder(sec)).toEqual(sourceOrder);
  });
});
