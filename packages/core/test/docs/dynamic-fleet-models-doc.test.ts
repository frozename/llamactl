// RED tests for frozename/llamactl#522. They pin the operator doc
// docs/dynamic-fleet-models.md against the live source-of-truth exports
// (catalog meta fields, qualification stages, promotion metrics and
// thresholds, override fields, exclusive-group catalog rows and workload
// templates). Repo files only — no network, no processes, no live state —
// so a missing or stale doc fails by assertion, never by throw.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { BUILTIN_CATALOG } from "../../src/catalog.js";
import { qualificationOverrideFields } from "../../src/qualification/overrides.js";
import {
  PROMOTION_METRICS,
  type PromotionDecision,
  PromotionThresholdsSchema,
} from "../../src/qualification/promotion.js";
import { PROMOTION_LADDER } from "../../src/qualification/stages.js";
import { existsSync, readdirSync, readFileSync } from "../../src/safe-fs.js";
import { curatedMetaFields, QUALIFICATION_STAGES } from "../../src/schemas.js";

const REPO = resolve(import.meta.dir, "../../../..");
const DOC = join(REPO, "docs/dynamic-fleet-models.md");
const RESIDENCY_GROUP = "z13-large-gpu";

const REFUSAL_REASONS = [
  "frozen",
  "pinned",
  "degraded",
  "terminal-stage",
  "no-thresholds",
  "insufficient-evidence",
  "below-threshold",
] as const satisfies readonly Extract<PromotionDecision, { kind: "none" }>["reason"][];

function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const doc = readOrEmpty(DOC);

interface WorkloadTemplate {
  file: string;
  text: string;
}

function loadWorkloadTemplates(): WorkloadTemplate[] {
  const dir = join(REPO, "templates/workloads");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }))
    .filter((t) => t.text.includes(`llamactl.io/residency-group: ${RESIDENCY_GROUP}`));
}

const residencyTemplates = loadWorkloadTemplates();
const exclusiveRows = BUILTIN_CATALOG.filter((row) => row.residencyGroup === RESIDENCY_GROUP);

const GLM53_FAMILY = /^\s+family:\s*glm53\s*$/m;
const RUNTIME_ARM = /^\s+(?:arm|llamactl\.io\/runtime-arm):\s*(\S+)\s*$/m;
const WORKLOAD_NAME = /^metadata:\n\s+name:\s*(\S+)/m;
const TEMPLATE_PORT = /^\s+port:\s*(\d+)\s*$/m;
const RUNBOOK_ROW = /^\|\s*`([^`]+)`\s*\|([^|]+)\|\s*(\d+)\s*\|/;

interface RunbookRow {
  arm: string;
  port: string;
}

function sectionBody(heading: RegExp): string | undefined {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^#{1,6} /.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
}

function runbookRows(section: string): Map<string, RunbookRow> {
  const rows = new Map<string, RunbookRow>();
  for (const line of section.split("\n")) {
    const match = RUNBOOK_ROW.exec(line);
    const name = match?.[1];
    const arm = match?.[2]?.trim();
    const port = match?.[3];
    if (name !== undefined && arm !== undefined && port !== undefined) {
      rows.set(name, { arm, port });
    }
  }
  return rows;
}

const glmArmIds = residencyTemplates
  .filter((t) => GLM53_FAMILY.test(t.text))
  .map((t) => RUNTIME_ARM.exec(t.text)?.[1])
  .filter((arm): arm is string => arm !== undefined);

describe("docs/dynamic-fleet-models.md (#522)", () => {
  test("case 1: doc exists", () => {
    expect(existsSync(DOC)).toBe(true);
  });

  test("case 2: catalog meta fields and tsv-schemas link", () => {
    for (const key of curatedMetaFields) {
      expect(doc).toContain(`\`${key}\``);
    }
    expect(doc).toContain("tsv-schemas.md");
  });

  test("case 3: qualification stages and promotion ladder", () => {
    for (const stage of QUALIFICATION_STAGES) {
      expect(doc).toContain(`\`${stage}\``);
    }
    expect(doc).toContain(PROMOTION_LADDER.map((s) => `\`${s}\``).join(" → "));
  });

  test("case 4: promotion metrics, thresholds, autoApply and refusals", () => {
    for (const metric of PROMOTION_METRICS) {
      expect(doc).toContain(`\`${metric}\``);
    }
    for (const key of Object.keys(PromotionThresholdsSchema.shape)) {
      expect(doc).toContain(`\`${key}\``);
    }
    expect(doc).toContain("`autoApply`");
    for (const reason of REFUSAL_REASONS) {
      expect(doc).toContain(`\`${reason}\``);
    }
    expect(doc).toContain("#284");
  });

  test("case 5: qualification overrides", () => {
    expect(doc).toContain("`pin`");
    expect(doc).toContain("`freeze`");
    expect(doc).toContain("`LOCAL_AI_QUALIFICATION_OVERRIDES_FILE`");
    expect(doc).toContain("`qualification-overrides.tsv`");
    for (const field of qualificationOverrideFields) {
      expect(doc).toContain(`\`${field}\``);
    }
    expect(doc.toLowerCase()).toContain("library-only");
  });

  test("case 6: exclusive-group catalog rows", () => {
    expect(exclusiveRows.length).toBeGreaterThan(0);
    for (const row of exclusiveRows) {
      expect(doc, `catalog row ${row.id}`).toContain(`\`${row.id}\``);
      const reason = row.availability?.reason;
      if (reason !== undefined) {
        expect(doc, `catalog row ${row.id}`).toContain(reason);
      } else if (row.availability === undefined) {
        expect(doc, `catalog row ${row.id}`).toContain("availability not declared");
      }
    }
  });

  test("case 7: exclusive-window runbook templates", () => {
    expect(residencyTemplates.length).toBeGreaterThan(0);
    const runbook = sectionBody(/^#{2,} .*exclusive-window runbook/i);
    expect(runbook, "exclusive-window runbook section missing").toBeDefined();
    const rows = runbook === undefined ? new Map<string, RunbookRow>() : runbookRows(runbook);
    for (const t of residencyTemplates) {
      const name = WORKLOAD_NAME.exec(t.text)?.[1];
      expect(name, `metadata.name missing in ${t.file}`).toBeDefined();
      if (name === undefined) continue;
      expect(doc, `template ${t.file}`).toContain(`\`${name}\``);
      const port = TEMPLATE_PORT.exec(t.text)?.[1];
      expect(port, `port missing in ${t.file}`).toBeDefined();
      const arm = RUNTIME_ARM.exec(t.text)?.[1];
      const row = rows.get(name);
      expect(row, `runbook table row for ${name} missing`).toBeDefined();
      if (row === undefined || port === undefined) continue;
      expect(row.port, `runbook port for ${name}`).toBe(port);
      expect(row.arm, `runbook runtime arm for ${name}`).toBe(
        arm === undefined ? "none" : `\`${arm}\``,
      );
    }
    expect(doc).toMatch(/^##+ .*exclusive-window runbook/im);
    expect(doc).toContain("`llamactl disable");
    expect(doc).toContain("`llamactl enable");
    expect(doc).toContain("`llamactl apply -f");
    expect(doc).toContain("`llamactl get workloads");
  });

  test("case 8: residency guard pinned to modelhost source", () => {
    const src = readOrEmpty(join(REPO, "packages/remote/src/server/modelhost.ts"));
    const label = /export const RESIDENCY_GROUP_LABEL = "([^"]+)"/.exec(src)?.[1];
    expect(label).toBeDefined();
    if (label === undefined) {
      throw new Error("RESIDENCY_GROUP_LABEL export missing from modelhost.ts");
    }
    expect(doc).toContain(`\`${label}\``);
    expect(doc).toContain("already has");
    expect(doc).toContain("`residencyConflict`");
    expect(doc).toContain("#276");
    for (const state of ["Running", "Starting", "Unknown"]) {
      expect(doc).toContain(state);
    }
  });

  test("case 9: GLM-5.3-Flash eval record", () => {
    expect(glmArmIds.length).toBeGreaterThan(0);

    // Step 9 uses workload <name>, not runtime arm id.
    expect(doc).toMatch(/llamactl disable <name>/);

    // Eval-record section: one row per GLM arm with `unavailable` cells.
    const evalSection = doc
      .split(/^##+/m)
      .find((section) => /GLM-5\.3-Flash.*eval record/.test(section));
    expect(evalSection).toBeDefined();
    if (evalSection === undefined) {
      throw new Error("GLM-5.3-Flash eval record section missing from doc");
    }
    // Extract arm ids from the eval-record table first column.
    const evalArms = [...evalSection.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
    expect(evalArms.length).toBeGreaterThan(0);
    // Every GLM arm id from templates must appear in the eval-record table.
    for (const arm of glmArmIds) {
      expect(evalArms).toContain(arm);
    }
    // The eval-record table carries an arm row with an `unavailable` cell.
    expect(evalSection).toMatch(/^\| `[^`]+` \|[^|]+\| `unavailable`/im);

    // Every GLM arm row has an `unavailable` cell in every
    // PROMOTION_METRICS column, located via the header row.
    const evalLines = evalSection.split("\n");
    const header = evalLines.find((line) => /^\|\s*arm\s*\|/.test(line));
    expect(header, "eval-record table header row missing").toBeDefined();
    const headerCells = (header ?? "").split("|").map((cell) => cell.trim());
    const metricColumns = new Map<string, number>();
    for (const metric of PROMOTION_METRICS) {
      const col = headerCells.indexOf(`\`${metric}\``);
      expect(col, `metric column ${metric} missing from eval-record header`).toBeGreaterThan(0);
      if (col > 0) metricColumns.set(metric, col);
    }
    for (const arm of glmArmIds) {
      const row = evalLines.find((line) => line.startsWith(`| \`${arm}\``));
      expect(row, `eval-record row for arm ${arm} missing`).toBeDefined();
      if (row === undefined) continue;
      const cells = row.split("|").map((cell) => cell.trim());
      for (const [metric, col] of metricColumns) {
        expect(cells[col], `eval arm ${arm} metric ${metric}`).toBe("`unavailable`");
      }
    }
  });

  test("case 10: model download flags", () => {
    expect(doc).toContain("`--no-tune`");
    expect(doc).toContain("`llamactl pull file");
  });

  test("case 11: relative links resolve", () => {
    expect(existsSync(DOC)).toBe(true);
    const linkPattern = /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;
    for (const match of doc.matchAll(linkPattern)) {
      const target = (match[1] ?? "").split("#")[0] ?? "";
      const resolved = resolve(join(REPO, "docs"), target);
      expect(existsSync(resolved), `relative link target missing: ${target}`).toBe(true);
    }
  });

  test("case 12: cross-links from README and tsv-schemas", () => {
    expect(readOrEmpty(join(REPO, "README.md"))).toContain("docs/dynamic-fleet-models.md");
    const tsvSchemas = readOrEmpty(join(REPO, "docs/tsv-schemas.md"));
    expect(tsvSchemas).toContain("## `qualification-overrides.tsv`");
    for (const field of qualificationOverrideFields) {
      expect(tsvSchemas).toContain(`\`${field}\``);
    }
  });
});
