// Part of #522: reading candidate rows with catalog list and catalog status

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CuratedModel } from "../../../src/schemas.js";

import {
  BUILTIN_CATALOG,
  formatCatalogRow,
  listCatalog,
  parseCatalogRow,
} from "../../../src/catalog.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../../src/safe-fs.js";
import { curatedMetaFields, curatedTsvFields } from "../../../src/schemas.js";
import { doc, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

const S = sectionBody(/^### Reading candidate rows with `catalog list` and `catalog status`/);

const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/catalog.ts"));
const core = readOrEmpty(join(REPO, "packages/core/src/catalog.ts"));
const schemas = readOrEmpty(join(REPO, "packages/core/src/schemas.ts"));
const router = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));

const tmp = mkdtempSync(join(tmpdir(), "llamactl-522-list-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function section(): string {
  expect(S, "missing section").toBeDefined();
  return flat(S ?? "");
}

function noMetaRow(): CuratedModel | undefined {
  return BUILTIN_CATALOG.find((row) => curatedMetaFields.every((key) => row[key] === undefined));
}

describe("#522 catalog list and status readout", () => {
  test("places the section after adding custom rows and before residency states", () => {
    const s = section();
    expect(s).toContain("catalog list");

    const at = doc.indexOf("### Reading candidate rows with");
    expect(at, "section heading present").toBeGreaterThanOrEqual(0);
    expect(at, "after adding custom candidate rows").toBeGreaterThan(
      doc.indexOf("### Adding custom candidate rows"),
    );
    expect(at, "before residency states and exclusion").toBeLessThan(
      doc.indexOf("## Residency states and exclusion"),
    );
  });

  test("documents the catalog list synopsis and defaults", () => {
    const s = section();
    expect(s).toContain("llamactl catalog list [all|builtin|custom] [--json|--tsv]");
    expect(s).toContain("builtin rows first");
    expect(s).toContain("no header line");

    expect(cli).toContain("list [all|builtin|custom] [--json|--tsv]");
    expect(cli).toContain('let scope: Scope = "all";');
    expect(cli).toContain('let format: Format = "tsv";');
  });

  test("all lists builtin rows first, then custom rows", () => {
    const s = section();
    expect(s).toContain("`all` prints the builtin rows first, then the custom rows");

    const base = noMetaRow();
    expect(base).toBeDefined();
    const custom: CuratedModel = {
      ...base!,
      id: "doc-522-custom-row",
      rel: "doc-522-custom/doc-522-custom-row.gguf",
    };
    const file = join(tmp, "curated-models.tsv");
    writeFileSync(file, `${formatCatalogRow(custom)}\n`);

    const rows = listCatalog("all", { customCatalogFile: file });
    expect(rows).toHaveLength(BUILTIN_CATALOG.length + 1);
    expect(rows.slice(0, BUILTIN_CATALOG.length).map((r) => r.rel)).toEqual(
      BUILTIN_CATALOG.map((r) => r.rel),
    );
    expect(rows.at(-1)?.rel).toBe(custom.rel);
    expect(rows.findIndex((r) => r.rel === custom.rel)).toBe(BUILTIN_CATALOG.length);
  });

  test("documents and ships the TSV meta column", () => {
    const s = section();
    expect(s).toContain("adds a ninth, tab-separated column of compact JSON");
    expect(s).toContain("curatedMetaFields");
    expect(s).toContain("formatCatalogRow");

    expect(core).toContain("if (Object.keys(picked).length === 0) return line;");
    expect(core).toContain("return `${line}\\t${JSON.stringify(canonical.data)}`;");

    const groupedRows = BUILTIN_CATALOG.filter((row) => row.residencyGroup === "z13-large-gpu");
    expect(groupedRows.length).toBeGreaterThan(0);
    for (const row of groupedRows) {
      const cols = formatCatalogRow(row).split("\t");
      expect(cols, row.id).toHaveLength(9);
      const meta = JSON.parse(cols[8] ?? "") as {
        qualification?: { stage?: unknown };
        residencyGroup?: unknown;
      };
      expect(meta.residencyGroup, row.id).toBe("z13-large-gpu");
      expect(meta.qualification?.stage, row.id).toBe("experimental");
    }

    const row = noMetaRow();
    expect(row).toBeDefined();
    expect(formatCatalogRow(row!).split("\t")).toHaveLength(8);
  });

  test("documents and ships the catalog list JSON shape", () => {
    const s = section();
    expect(s).toContain("top-level fields");
    expect(s).toContain("`installed`");
    expect(s).toContain("catalogList");
    expect(s).toContain("`--node all --json` prints the fan-out results");
    expect(s).toContain("`{ node, ok, data }`");
    expect(s).toContain("`{ node, ok, error }`");
    expect(s).not.toContain("`--json`. It prints");
    expect(s).not.toContain("Link [tsv-schemas.md]");

    expect(schemas).toContain(".extend(CuratedMeta.shape)");
    expect(router).toContain("installed: existsSync(join(resolved.LLAMA_CPP_MODELS, entry.rel))");
  });

  test("documents catalog list refusals and exit status", () => {
    const s = section();
    for (const needle of [
      "Unknown flag for catalog list: <flag>",
      "Unexpected extra argument: <arg>",
      "Unknown scope: <arg> (expected all | builtin | custom)",
      "catalog list: remote call to '<node>' failed: <message>",
      "[<node>] error: <error>",
      "exits 2",
    ]) {
      expect(s, needle).toContain(needle);
    }

    expect(cli).toContain("Unknown flag for catalog list: ${arg}");
    expect(cli).toContain('Unknown scope: ${arg} (expected ${SCOPES.join(" | ")})');
    expect(cli).toContain("catalog list: remote call to '");

    const fanOutStart = cli.indexOf("async function runListFanOut(");
    expect(fanOutStart, "runListFanOut present").toBeGreaterThanOrEqual(0);
    const fanOutEnd = cli.indexOf("\n}\n", fanOutStart);
    expect(fanOutEnd, "runListFanOut closing brace present").toBeGreaterThan(fanOutStart);
    const fanOut = cli.slice(fanOutStart, fanOutEnd);
    const exit2 = "return results.some((r) => !r.ok) ? 2 : 0;";
    expect(fanOut.split(exit2), "one exit-2 return per output branch").toHaveLength(3);
    const jsonBranch = fanOut.indexOf('if (parsed.format === "json") {');
    expect(jsonBranch, "JSON branch present").toBeGreaterThanOrEqual(0);
    const jsonExit = fanOut.indexOf(exit2, jsonBranch);
    const tsvLoop = fanOut.indexOf("for (const r of results) {");
    expect(jsonExit, "JSON branch exits 2 on a failing node").toBeGreaterThan(jsonBranch);
    expect(tsvLoop, "TSV loop follows the JSON branch return").toBeGreaterThan(jsonExit);
    expect(fanOut.indexOf(exit2, tsvLoop), "TSV branch exits 2 on a failing node").toBeGreaterThan(
      tsvLoop,
    );
  });

  test("documents and preserves invalid custom row handling", () => {
    const s = section();
    for (const needle of [
      "llamactl: skipping invalid catalog row in <file>:<line> rel=<rel> (<error>)",
      "invalid meta JSON",
      "meta must be a JSON object",
      "fewer than seven columns",
      "dropped",
    ]) {
      expect(s, needle).toContain(needle);
    }

    expect(core).toContain(
      "llamactl: skipping invalid catalog row in ${file}:${String(lineNo)} rel=${rel} (${result.error})",
    );

    const row = noMetaRow();
    expect(row).toBeDefined();
    const base = curatedTsvFields.map((field) => row![field]).join("\t");
    expect(base.split("\t")).toHaveLength(8);

    expect(parseCatalogRow(`${base}\t{bad`)).toEqual({ ok: false, error: "invalid meta JSON" });
    expect(parseCatalogRow(`${base}\t[1]`)).toEqual({
      ok: false,
      error: "meta must be a JSON object",
    });

    const parsed = parseCatalogRow(`${base}\t{"bogusKey":1,"license":"x"}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected curated row to parse");
    expect(parsed.entry.license).toBe("x");
    expect("bogusKey" in parsed.entry).toBe(false);
  });

  test("documents the catalog status readout contract", () => {
    const s = section();
    for (const needle of [
      "rel=",
      "installed=yes",
      "catalog=builtin",
      "class_source=",
      "hf_enabled=",
      "no candidate metadata",
      "llamactl qualification status <rel>",
      "Usage: llamactl catalog status <rel> [--json]",
      "local",
    ]) {
      expect(s, needle).toContain(needle);
    }

    expect(cli).toContain('`installed=${report.installed ? "yes" : "no"}`');
    expect(cli).toContain("`class_source=${report.class.source}`");
    expect(cli).toContain("Usage: llamactl catalog status <rel> [--json]");

    const start = cli.indexOf("interface StatusReport {");
    expect(start, "StatusReport interface present").toBeGreaterThanOrEqual(0);
    const end = cli.indexOf("\n}\n", start);
    expect(end, "StatusReport closing brace present").toBeGreaterThan(start);
    const reportInterface = cli.slice(start, end);
    for (const absent of ["availability", "qualification", "residencyGroup"]) {
      expect(reportInterface, absent).not.toContain(absent);
    }
  });
});
