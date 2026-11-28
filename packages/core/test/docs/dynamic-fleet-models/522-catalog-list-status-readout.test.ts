// Part of #522: reading candidate rows with catalog list and catalog status

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { CuratedModel } from "../../../src/schemas.js";

import { BUILTIN_CATALOG, formatCatalogRow, parseCatalogRow } from "../../../src/catalog.js";
import { curatedMetaFields, curatedTsvFields } from "../../../src/schemas.js";
import { doc, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

const S = sectionBody(/^### Reading candidate rows with `catalog list` and `catalog status`/);

const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/catalog.ts"));
const core = readOrEmpty(join(REPO, "packages/core/src/catalog.ts"));
const schemas = readOrEmpty(join(REPO, "packages/core/src/schemas.ts"));
const router = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));

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

  test("documents and ships the TSV meta column", () => {
    const s = section();
    expect(s).toContain("ninth");
    expect(s).toContain("compact JSON");
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
    expect(cli).toContain("results.some((r) => !r.ok) ? 2 : 0");
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
