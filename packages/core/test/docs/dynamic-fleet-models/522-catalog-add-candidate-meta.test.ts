import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { doc, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #522: operator docs for `llamactl catalog add --meta <json>`.
// The new "### Adding custom candidate rows" subsection sits inside
// "## Catalog fields" (after it, before "## Residency states and
// exclusion") and pins the usage strings, the CuratedMeta.strict()
// validation contract and its refusal messages, the column-9 wire
// format, the qualification status consumer, the duplicate-rel
// refusal, the `--` terminator and --meta's next-token consumption.
// On the base the subsection does not exist, so every case fails by
// assertion on the missing section or a missing source needle.
const S = sectionBody(/^### Adding custom candidate rows/);

const catalogSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/catalog.ts"));
const binSrc = readOrEmpty(join(REPO, "packages/cli/src/bin.ts"));
const writerSrc = readOrEmpty(join(REPO, "packages/core/src/catalogWriter.ts"));
const qualSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/qualification.ts"));

function section(): string {
  expect(S, "missing '### Adding custom candidate rows' section").toBeDefined();
  return S ?? "";
}

describe("#522 catalog add candidate meta doc", () => {
  test("the subsection sits inside Catalog fields, before Residency states", () => {
    const at = doc.indexOf("### Adding custom candidate rows");
    expect(at, "heading present").toBeGreaterThanOrEqual(0);
    expect(at, "after ## Catalog fields").toBeGreaterThan(doc.indexOf("## Catalog fields"));
    expect(at, "before ## Residency states and exclusion").toBeLessThan(
      doc.indexOf("## Residency states and exclusion"),
    );
  });

  test("D1: usage strings documented and shipped", () => {
    const s = section();
    expect(s).toContain(
      "llamactl catalog add <hf-repo> <gguf-file-or-relpath> [label] [family] [class] [scope] [--meta <json>]",
    );
    expect(catalogSrc).toContain(
      "add <hf-repo> <gguf-file-or-relpath> [label] [family] [class] [scope] [--meta <json>]",
    );
  });

  test("D2: meta validation contract documented", () => {
    const s = section();
    for (const needle of [
      "CuratedMeta",
      ".strict()",
      "invalid catalog meta: unrecognized key(s): <keys>",
      "nothing is written",
    ]) {
      expect(s, needle).toContain(needle);
    }
    for (const needle of [
      "CuratedMeta.strict()",
      "invalid catalog meta: ",
      "unrecognized key(s): ",
    ]) {
      expect(writerSrc, needle).toContain(needle);
    }
  });

  test("D3: CLI refusal messages documented", () => {
    const s = section();
    for (const needle of [
      "catalog add: --meta is not valid JSON",
      "catalog add: --meta requires a JSON value",
      "catalog add: unknown flag <flag>",
    ]) {
      expect(s, needle).toContain(needle);
    }
    for (const needle of [
      "catalog add: --meta is not valid JSON",
      "catalog add: --meta requires a JSON value",
      "catalog add: unknown flag ${",
    ]) {
      expect(catalogSrc, needle).toContain(needle);
    }
  });

  test("D4: column 9 wire format referenced", () => {
    const s = section();
    expect(s).toContain("column 9");
    expect(s).toContain("[tsv-schemas.md](tsv-schemas.md)");
  });

  test("D5: qualification status surface documented", () => {
    const s = section();
    expect(s).toContain("catalogStage");
    expect(s).toContain("llamactl qualification status <rel>");
    expect(qualSrc).toContain("row.qualification?.stage");
    expect(qualSrc).toContain("catalogStageByRel");
  });

  test("D6: duplicate-rel refusal documented", () => {
    const s = section();
    expect(s).toContain("Catalog already contains <rel>");
    expect(writerSrc).toContain("Catalog already contains ");
  });

  test("D7: `--` terminator and --meta next-token consumption documented", () => {
    const s = section();
    expect(s).toContain("`--`");
    expect(s).toContain("next token");
  });

  // Ship-time fix: the --meta value is never a positional. The source
  // half pins the single parser state that stores the value as meta.
  test("D10: --meta value is never a positional, documented and shipped", () => {
    const s = section();
    expect(s).toContain("never counted as a positional argument");
    expect(s).toContain("A bare `--` ends flag");
    expect(s).toContain("a label starting with `--` goes after `--`");
    expect(catalogSrc).toContain(
      'if (acc.state === "metaValue") {\n    acc.meta = arg;\n    acc.state = "flags";\n    return undefined;',
    );
    expect(catalogSrc).toContain('if (arg === "--") {\n    acc.state = "positionals";');
  });

  test("D8: usage strings agree across doc, bin and writer", () => {
    const s = section();
    expect(s).toContain("[--meta <json>]");
    expect(binSrc).toContain(
      "llamactl catalog add <repo> <file> [label] [family] [class] [scope] [--meta <json>]",
    );
    expect(writerSrc).toContain("[scope] [--meta <json>]");
  });

  test("D9: cited packages/ paths exist; no file:line citations", () => {
    const s = section();
    const citations = [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    const repoPaths = citations.filter((c) => c.startsWith("packages/"));
    for (const p of repoPaths) {
      expect(existsSync(join(REPO, p)), `cited path exists: ${p}`).toBe(true);
    }
    for (const c of citations) {
      expect(/\.(?:ts|md):\d+/.test(c), `no file:line citation: ${c}`).toBe(false);
    }
  });
});
