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
import {
  isOccupyingResidencyState,
  RESIDENCY_GROUPS,
  RESIDENCY_STATES,
  RESIDENCY_TRANSITIONS,
  type ResidencyTransitionDecision,
} from "../../src/residency/lifecycle.js";
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

// Part of #522: residency lifecycle states slice
type TransitionRefusal = Extract<ResidencyTransitionDecision, { ok: false }>["reason"];
const TRANSITION_REFUSALS = [
  "UnknownMember",
  "IllegalTransition",
  "UnknownGroup",
  "ExclusiveGroupOccupied",
] as const satisfies readonly TransitionRefusal[];
type MissingRefusal = Exclude<TransitionRefusal, (typeof TRANSITION_REFUSALS)[number]>;
const ALL_REFUSALS_LISTED: [MissingRefusal] extends [never] ? true : false = true;

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

function flat(text: string): string {
  return text.replaceAll(/\s+/g, " ");
}

// The text of the function that `signature` opens, up to its closing brace
// at the signature's indent; "" when the signature is missing or not unique.
function enclosingBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1 || src.includes(signature, start + 1)) return "";
  const lineStart = src.lastIndexOf("\n", start) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart))?.[0] ?? "";
  const closers = new Set([`${indent}}`, `${indent}},`, `${indent}};`]);
  const lines = src.slice(start).split("\n");
  const end = lines.findIndex((line, i) => i > 0 && closers.has(line));
  return lines.slice(0, end === -1 ? lines.length : end + 1).join("\n");
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
    expect(doc).toContain("catalogQualificationStages");
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

  test("case 13: residency lifecycle states section lists all eight states", () => {
    const raw = sectionBody(/^#{2,} .*residency lifecycle states/i);
    expect(raw, "residency lifecycle states section missing").toBeDefined();
    const s = raw ?? "";
    expect(RESIDENCY_STATES.length).toBe(8);
    for (const state of RESIDENCY_STATES) {
      expect(s, `state \`${state}\` missing`).toContain(`\`${state}\``);
    }
  });

  test("case 14: transitions table matches RESIDENCY_TRANSITIONS", () => {
    const s = sectionBody(/^#{2,} .*residency lifecycle states/i) ?? "";
    const rows = new Map<string, { next: string[]; occupying: string }>();
    for (const line of s.split("\n")) {
      const match = /^\|\s*`([a-z]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
      const from = match?.[1];
      const nextCell = match?.[2];
      const occupyingCell = match?.[3];
      if (from === undefined || nextCell === undefined || occupyingCell === undefined) {
        continue;
      }
      const next = [...nextCell.matchAll(/`([a-z]+)`/g)]
        .map((token) => token[1])
        .filter((token): token is string => token !== undefined)
        .sort();
      rows.set(from, { next, occupying: occupyingCell.trim() });
    }
    for (const state of RESIDENCY_STATES) {
      const row = rows.get(state);
      expect(row, `transitions row for ${state} missing`).toBeDefined();
      expect(row?.next ?? [], `next states for ${state}`).toEqual(
        [...RESIDENCY_TRANSITIONS[state]].sort(),
      );
      expect(row?.occupying, `occupying flag for ${state}`).toBe(
        isOccupyingResidencyState(state) ? "yes" : "no",
      );
    }
  });

  test("case 15: exclusive groups and transition refusals", () => {
    const s = sectionBody(/^#{2,} .*residency lifecycle states/i) ?? "";
    expect(s).toContain("occupying");
    for (const group of RESIDENCY_GROUPS.filter((g) => g.exclusive)) {
      expect(s).toContain(`\`${group.name}\``);
      expect(s).toContain("exclusive");
    }
    for (const reason of TRANSITION_REFUSALS) {
      expect(s).toContain(`\`${reason}\``);
    }
    expect(s).toContain("`evaluateResidencyTransition`");
    expect(s).toContain("`findExclusiveGroupViolations`");
    expect(s).toContain("packages/core/src/residency/lifecycle.ts");
    expect(ALL_REFUSALS_LISTED).toBe(true);
  });

  test("case 16: stale not-implemented claim removed", () => {
    expect(doc).not.toContain(
      "The residency state contract (#276) is not implemented at this commit",
    );
    expect(doc).toContain("#517");
  });

  test("case 17: degraded demotion path (#518)", () => {
    // kills: an undocumented demotion path — the doc must name the
    // demotion entry points and the none-reasons they can return.
    for (const needle of [
      "proposeDemotion",
      "evaluateQualification",
      "applyQualification",
      "`demotion`",
      "`already-degraded`",
      "`not-demotable`",
      "`within-tolerance`",
    ]) {
      expect(doc, needle).toContain(needle);
    }
  });

  // Part of #522: post-#725..#729 freshness slice
  // Kills: restoring the "neither has a live caller yet" claim, or
  // unwiring withResidencyLifecycle from profile-transition.ts.
  test("case 18: lifecycle consumers are live (#726)", () => {
    const s = (sectionBody(/^#{2,} .*residency lifecycle states/i) ?? "").replaceAll(/\s+/g, " ");
    expect(s).not.toContain("neither has a live caller");
    for (const needle of [
      "`planProfileSwitch`",
      "packages/remote/src/residency/procedures.ts",
      "`withResidencyLifecycle`",
      "packages/remote/src/residency/lifecycle-steps.ts",
      "#726",
    ]) {
      expect(s, needle).toContain(needle);
    }
    expect(readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"))).toContain(
      "planProfileSwitch(",
    );
    expect(
      readOrEmpty(join(REPO, "packages/remote/src/residency/profile-transition.ts")),
    ).toContain("withResidencyLifecycle(");
  });

  // Kills: rewording the promote-private stderr refusal in embersynth.ts
  // without updating the doc, or dropping the #725 paragraph.
  test("case 19: experimental exclusion surfaces (#725)", () => {
    const embersynthCli = readOrEmpty(join(REPO, "packages/cli/src/commands/embersynth.ts"));
    const phrase = /is experimental \(#518\): ([^\\`\n]+?)\\n/.exec(embersynthCli)?.[1] ?? "";
    expect(phrase.length).toBeGreaterThan(0);
    const q = (sectionBody(/^## Qualification and promotion/) ?? "").replaceAll(/\s+/g, " ");
    for (const needle of [
      phrase,
      "`embersynthQualificationStages`",
      "packages/remote/src/config/embersynth.ts",
      "`llamactl embersynth promote-private",
      "`admissionConflict`",
      "#725",
    ]) {
      expect(q, needle).toContain(needle);
    }
    expect(readOrEmpty(join(REPO, "packages/core/src/routing/catalog.ts"))).toContain(
      "function admissionConflict(",
    );
  });

  // Kills: restoring the stale no-runtime-effect claim that contradicts
  // the Overrides section.
  test("case 20: rollback levers match override routing", () => {
    const flat = doc.replaceAll(/\s+/g, " ");
    expect(flat).not.toContain("Override rows have no runtime effect yet");
    const r = (sectionBody(/^## Download, checksum and rollback/) ?? "").replaceAll(/\s+/g, " ");
    for (const needle of ["`pin`", "`freeze`", "`catalogQualificationStages`"]) {
      expect(r, needle).toContain(needle);
    }
  });

  // Part of #522
  // Kills: restoring 'a status read-out' to the lifecycle still-pending list,
  // or unwiring findExclusiveGroupViolations from residency status.
  test("case 21: lifecycle status read-out no longer pending (#731)", () => {
    const s = (sectionBody(/^#{2,} .*residency lifecycle states/i) ?? "").replaceAll(/\s+/g, " ");
    expect(s).not.toContain("a status read-out");
    for (const n of ["`llamactl residency status`", "#731", "#730"]) {
      expect(s, n).toContain(n);
    }
    expect(readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"))).toContain(
      "findExclusiveGroupViolations(",
    );
    expect(
      readOrEmpty(join(REPO, "packages/remote/src/residency/profile-transition.ts")),
    ).toContain("SessionsActive: ");
  });

  // Part of #522
  // Kills: dropping or rewording the claimed-pass and orphan-sweep scope of
  // the lifecycle-row boot recovery paragraph, or its fail-closed `evict:`
  // consequence and operator remedy.
  test("case 22: lifecycle boot recovery scope (claimed pass and outside a switch)", () => {
    const s = (sectionBody(/^#{2,} .*residency lifecycle states/i) ?? "").replaceAll(/\s+/g, " ");
    for (const n of [
      "On a claimed pass, i.e. when a stale profile-switch row exists, it sweeps every interrupted row. When the store holds no nonterminal operation row, it also sweeps lifecycle rows interrupted outside a switch, such as a direct start whose agent died in `loading`, once they have made no progress for 30 minutes and their workload is proven down, under its own claim of the apply-profile fence.",
      "A workload that is not proven down, for example an engine that outlived its agent, keeps its row.",
      "Any nonterminal operation row keeps this sweep off, and it fails closed: `evict:` rows have no boot recovery yet, so a crashed eviction's nonterminal `evict:` row disables the outside-a-switch sweep on every later boot until that row is terminalized; until then an operator stop or `llamactl residency force-unload` clears a stuck interrupted row, and an `evict:` row does not block either.",
      "`failInterruptedLifecycleRows`",
      "#517",
    ]) {
      expect(s, n).toContain(n);
    }
    expect(s).not.toContain("outside a switch are not swept");
  });

  // Part of #522
  // Kills: unwiring the direct start wrapper or the disable stop call,
  // dropping a step 6 or step 9 qualifier, breaking the dynamic-residency
  // link anchor, or reverting the #517 miscitation.
  test("case 23: exclusive-window runbook names direct-lifecycle start refusals (#741)", () => {
    const r = flat(sectionBody(/^## Exclusive-window runbook/) ?? "");
    // Full phrases, so dropping a qualifier (store exists, never blocked)
    // or breaking the link anchor fails.
    for (const needle of [
      'When the agent\'s residency store exists, the start can also be refused with "residency lifecycle refused <name> …: `ExclusiveGroupOccupied` …" (a same-group row still occupying; inspect with `llamactl residency status --node <name>`), or with "residency lifecycle refused <name>: profile switch in flight on this node; retry after it settles" (#741; see [dynamic-residency.md](dynamic-residency.md#direct-modelhost-start-and-stop)).',
      'A disable is never blocked by this bookkeeping and at worst logs "not recorded" (#741).',
    ]) {
      expect(r, needle).toContain(needle);
    }
    // the anchor resolves to a heading in dynamic-residency.md
    const residencyHeadings = readOrEmpty(join(REPO, "docs/dynamic-residency.md"))
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#+ /, "")
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9 -]/g, "")
          .replaceAll(" ", "-"),
      );
    expect(residencyHeadings).toContain("direct-modelhost-start-and-stop");
    const s = flat(sectionBody(/^#{2,} .*residency lifecycle states/i) ?? "");
    expect(s).not.toContain("Since #517 the direct");
    expect(s).toContain("Since #741 (Part of #517) the direct ModelHost writers");
    expect(s).toContain(
      "Bookkeeping never blocks a stop: a stop whose claim or walk fails still runs and logs `not recorded`.",
    );
    expect(readOrEmpty(join(REPO, "packages/remote/src/router.ts"))).toContain(
      "runDirectResidencyStart<StartModelHostResult>(",
    );
    const applySrc = readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"));
    // enable reaches modelHostStart, disable reaches modelHostStop
    expect(flat(enclosingBody(applySrc, "async function startModelHostProcess("))).toContain(
      "client.modelHostStart.subscribe(",
    );
    expect(flat(enclosingBody(applySrc, "async function applyModelHostManifest("))).toContain(
      "if (!manifest.spec.enabled) { return await disableModelHost(manifest, client, resolved); }",
    );
    expect(flat(enclosingBody(applySrc, "async function disableModelHost("))).toContain(
      "const outcome = await client.modelHostStop.mutate({ workload: manifest.metadata.name });",
    );
  });

  // Part of #518
  // Kills: rewording or dropping the Overrides doc paragraph, leaving the
  // stale "library-only" effectiveStage claim, or unwiring the CLI from
  // the core writer/deleter.
  test("case 24: operator override CLI (#518)", () => {
    const overrides = flat(sectionBody(/^## Overrides/) ?? "");
    for (const needle of [
      "`llamactl qualification pin",
      "`llamactl qualification freeze",
      "`llamactl qualification status",
      "qualificationOverridesFileFor",
    ]) {
      expect(overrides, needle).toContain(needle);
    }
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    expect(q).not.toContain("Effective status at this commit: `effectiveStage`");
    const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/qualification.ts"));
    for (const needle of [
      "writeQualificationOverride(",
      "deleteQualificationOverride(",
      "effectiveStage(",
    ]) {
      expect(cli, needle).toContain(needle);
    }
  });
});

// Part of #522: eval perf evidence capture slice (#764 command surface,
// #757 perf.sqlite store, #738 provenance + host readers). Source pins run
// before doc pins so a source mutant surfaces its own needle; every source
// pin is already true at base, so only the missing doc subsection fails.
describe("#522 eval record evidence capture (#764, #757, #738)", () => {
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const evalSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval.ts"));
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const readersSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/readers.ts"));
  const metricsSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/metrics.ts"));
  const provenanceSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/provenance.ts"));
  const typesSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/types.ts"));
  const lifecycleSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/lifecycle.ts"));

  const sec = flat(sectionBody(/^### Capturing evidence for an arm/) ?? "");

  // The quoted names inside `export const <exportName> = [ ... ] as const`;
  // [] when the opener or its first `] as const` closer is missing.
  const quotedConstNames = (src: string, exportName: string): string[] => {
    const opener = `export const ${exportName} = [`;
    const start = src.indexOf(opener);
    if (start === -1) return [];
    const bodyStart = start + opener.length;
    const end = src.indexOf("] as const", bodyStart);
    if (end === -1) return [];
    const block = src.slice(bodyStart, end);
    return [...block.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
  };

  // Kills: dropping or rewording the paragraph; changing the default engine
  // or suite in source; removing the not-serving refusal.
  test("eval perf command and refusals", () => {
    const resolveBody = enclosingBody(evalPerfSrc, "function resolveRunInput(");
    for (const needle of [
      'values["--engine"] ?? "llamacpp"',
      'values["--suite"] ?? "perf-quick"',
    ]) {
      expect(resolveBody, needle).toContain(needle);
    }
    expect(evalPerfSrc).toContain('"--hf-revision"');
    const runBody = enclosingBody(evalPerfSrc, "export async function runEvalPerf(");
    for (const needle of ["is not serving '", "servedModelIds("]) {
      expect(runBody, needle).toContain(needle);
    }
    expect(evalSrc).toContain(
      "perf --url <http://...> --engine <llamacpp|omlx|gufo|kapitsa> --model <id>",
    );
    // Kills: dropping `[--hf-revision <rev>]` from the eval.ts USAGE line, or
    // the doc synopsis drifting from that line (it claims a verbatim copy).
    const usageOptionalFlags =
      "[--suite perf-quick|perf-full] [--pid <n>] [--binary <path>] [--gguf <path>] [--hf-revision <rev>] [--quant <q>] [--ctx <n>] [--slots <n>] [--flags=<args>] [--db <path>] [--run-id <id>]";
    expect(evalSrc).toContain(`--model <id> ${usageOptionalFlags}\n`);
    expect(sec).toContain(`\`${usageOptionalFlags}\``);
    expect(sec).toContain("copied verbatim from the USAGE text");
    expect(sec).not.toContain("omits it");
    for (const needle of [
      "`llamactl eval perf --url <http://...> --engine <llamacpp|omlx|gufo|kapitsa> --model <id>`",
      "already serving",
      "never starts or stops the engine",
      "`perf-quick`",
      "`perf-full`",
      "`--engine` defaults to `llamacpp`",
      "is not serving '<model>'",
      "`--hf-revision`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: a moved db path; a changed output header; a changed run_id line.
  test("perf.sqlite location, run id and output", () => {
    const dbBody = enclosingBody(benchScheduleSrc, "export function defaultPerfDbPath(");
    for (const needle of ['"perf.sqlite"', '"eval"']) {
      expect(dbBody, needle).toContain(needle);
    }
    const runBody = enclosingBody(evalPerfSrc, "export async function runEvalPerf(");
    expect(runBody, "run_id: ${runId}").toContain("run_id: ${runId}");
    const tableBody = enclosingBody(evalPerfSrc, "function printPerfTable(");
    expect(tableBody).toContain("| metric | status | value | reason |");
    for (const needle of [
      "`perf.sqlite`",
      "`eval/`",
      "`$DEV_STORAGE`",
      "`~/.llamactl`",
      "`--db`",
      "`run_id: <id>`",
      "`| metric | status | value | reason |`",
      "the same `perf.sqlite` as `bench schedule` suites",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: allowing --pid off loopback; dropping the Linux gate; rewording
  // the doc.
  test("host readers: loopback, Linux-only counters, remote reasons", () => {
    const resolveBody = enclosingBody(evalPerfSrc, "function resolveRunInput(");
    for (const needle of [
      "--pid needs a loopback --url (got ",
      "host counters are read on this machine",
    ]) {
      expect(resolveBody, needle).toContain(needle);
    }
    for (const needle of [
      "/proc/${String(pid)}/io",
      "/proc/${String(pid)}/status",
      "is Linux-only",
    ]) {
      expect(readersSrc, needle).toContain(needle);
    }
    const remoteBody = enclosingBody(evalPerfSrc, "function remoteReasons(");
    expect(remoteBody).toContain("is not on this host");
    // Kills: gating the GTT reader on --pid, or dropping the non-Linux GTT
    // reason, while the doc says GTT is read with or without --pid.
    const hostBody = enclosingBody(evalPerfSrc, "function hostReaders(");
    expect(hostBody).toContain('if (platform === "linux") {\n    readers.gtt = linuxGttReader();');
    expect(hostBody).toContain("are Linux-only; no GTT reader on ${platform}");
    expect(sec).toContain(
      "GTT comes from the GTT probe on any loopback Linux run, with or without `--pid`",
    );
    for (const needle of [
      "`--pid` needs a loopback `--url`",
      "host counters are read on this machine",
      "`/proc/<pid>/io`",
      "VmHWM",
      "Linux-only",
      "macOS",
      "`unavailable`",
      "non-loopback",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: a metric added to or renamed in PERF_METRIC_NAMES without a doc
  // update; the doc claiming perf fills the promotion cells.
  test("perf metrics are not promotion metrics", () => {
    const perfMetricNames = quotedConstNames(metricsSrc, "PERF_METRIC_NAMES");
    expect(perfMetricNames.length).toBe(16);
    const promotionNames = new Set<string>(PROMOTION_METRICS);
    expect(perfMetricNames.filter((name) => promotionNames.has(name))).toEqual([]);
    expect(sec).toContain(
      "`eval perf` records perf metrics, not promotion metrics, so it does not fill the table above",
    );
    for (const name of perfMetricNames) {
      expect(sec, `\`${name}\``).toContain(`\`${name}\``);
    }
  });

  // Kills: a renamed or added provenance field; a broken anchor; a dropped
  // manual-shard caveat.
  test("provenance fields and unavailable reasons", () => {
    const fields = quotedConstNames(typesSrc, "PROVENANCE_UNAVAILABLE_FIELDS");
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(sec, `\`${field}\``).toContain(`\`${field}\``);
    }
    expect(provenanceSrc).toContain("HF_SNAPSHOT_RE");
    expect(provenanceSrc).toContain("\\/snapshots\\/");
    expect(provenanceSrc).toContain("gguf path is not under an HF snapshots/<rev>/ directory");
    for (const needle of [
      "`provenance.unavailable`",
      "`snapshots/<rev>/`",
      "`--hf-revision`",
      "`gguf_sha256`",
      "[Download, checksum and rollback](#download-checksum-and-rollback)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
    const anchors = doc
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#+ /, "")
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9 -]/g, "")
          .replaceAll(" ", "-"),
      );
    expect(anchors).toContain("download-checksum-and-rollback");
  });

  // Kills: widening or narrowing the external-only set; doc drift.
  test("external-only engines", () => {
    const engineBody = enclosingBody(typesSrc, "export function isExternalOnlyEngine(");
    expect(engineBody, 'engine === "gufo" || engine === "kapitsa"').toContain(
      'engine === "gufo" || engine === "kapitsa"',
    );
    expect(lifecycleSrc).toContain("run the server externally");
    expect(sec).not.toContain("`gufo-glm53-exp` runs on the `gufo` engine");
    for (const needle of [
      "`gufo` and `kapitsa` are external-only",
      "never boots",
      "run the server externally",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // The flag names inside `const VALUED_FLAGS: ReadonlySet<string> = new Set([ ... ]);`.
  const valuedFlags = (): string[] => {
    const opener = "const VALUED_FLAGS: ReadonlySet<string> = new Set([";
    const start = evalPerfSrc.indexOf(opener);
    if (start === -1) return [];
    const bodyStart = start + opener.length;
    const end = evalPerfSrc.indexOf("]);", bodyStart);
    if (end === -1) return [];
    const block = evalPerfSrc.slice(bodyStart, end);
    return [...block.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
  };
  const usagePerfLine =
    evalSrc.split("\n").find((line) => line.startsWith("  perf --url <http://...>")) ?? "";

  // A flag the doc cites must be parsed (VALUED_FLAGS) and listed in the
  // eval.ts USAGE perf line, so a rename on either side fails.
  const expectFlagInSource = (flag: string): void => {
    expect(valuedFlags(), `VALUED_FLAGS has ${flag}`).toContain(flag);
    const listed = [`${flag} <`, `${flag}=<`, `[${flag} `].some((form) =>
      usagePerfLine.includes(form),
    );
    expect(listed, `USAGE perf line lists ${flag}`).toBe(true);
  };

  // Kills: rewording the default-suite sentence; renaming --suite in
  // VALUED_FLAGS or USAGE; changing the suite choices in USAGE.
  test("default suite claim is pinned as one phrase", () => {
    expectFlagInSource("--suite");
    expect(usagePerfLine).toContain("[--suite perf-quick|perf-full]");
    expect(sec).toContain("`--suite` defaults to `perf-quick`; the other choice is `perf-full`.");
  });

  // Kills: rewording the no-PID sentence; dropping the unknown-PID reason
  // from createPerfHostReaders; renaming --pid.
  test("no --pid records per-process counters unavailable with the unknown-PID reason", () => {
    expectFlagInSource("--pid");
    const readersBody = enclosingBody(readersSrc, "export function createPerfHostReaders(");
    expect(readersBody).toContain("opts.pid === null");
    expect(readersBody).toContain("engine PID unknown");
    expect(sec).toContain(
      "Without `--pid`, those counters are recorded `unavailable` with a reason naming the unknown engine PID",
    );
  });

  // Kills: rewording any provenance sentence; renaming --binary, --gguf,
  // --quant, --ctx or --flags; buildProvenance dropping one of them; moving
  // the snapshots/<rev> reason out of collectHfRevision.
  test("provenance flag sentences", () => {
    for (const flag of ["--binary", "--gguf", "--quant", "--ctx", "--flags", "--hf-revision"]) {
      expectFlagInSource(flag);
    }
    const provBody = enclosingBody(evalPerfSrc, "function buildProvenance(");
    for (const needle of [
      'binary_path: values["--binary"]',
      'gguf_path: values["--gguf"]',
      'quant: values["--quant"]',
      "ctx: input.ctx",
      "flags: input.flags",
      'values["--hf-revision"]',
    ]) {
      expect(provBody, needle).toContain(needle);
    }
    const hfBody = enclosingBody(provenanceSrc, "function collectHfRevision(");
    expect(hfBody).toContain("gguf path is not under an HF snapshots/<rev>/ directory");
    for (const needle of [
      "`--binary` gives the engine version, the engine commit and the `binary_sha256`.",
      "`--gguf` gives `gguf_sha256`.",
      "`--quant`, `--ctx` and `--flags` fill their fields.",
      'For example, "gguf path is not under an HF snapshots/<rev>/ directory" (`collectHfRevision`, `packages/eval/src/perf/provenance.ts`).',
      "`gguf_sha256` hashes only the file passed as `--gguf`.",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: rewording the run-id sentence; renaming --run-id; changing the
  // generated id away from model + timestamp.
  test("--run-id override and generated id", () => {
    expectFlagInSource("--run-id");
    const runBody = enclosingBody(evalPerfSrc, "export async function runEvalPerf(");
    expect(runBody).toContain(
      'values["--run-id"] ?? `perf-${resolved.model}-${new Date().toISOString()}`',
    );
    expect(sec).toContain(
      "`--run-id <id>` overrides the id; otherwise it is generated from the model and the run timestamp.",
    );
  });

  // Kills: rewording the gufo-glm53-exp sentence; the template changing
  // kind or engine.
  test("gufo-glm53-exp is a llamacpp ModelHost", () => {
    const template = readOrEmpty(join(REPO, "templates/workloads/gufo-glm53-exp-z13.yaml"));
    expect(template).toContain("kind: ModelHost\nmetadata:\n  name: gufo-glm53-exp\n");
    expect(template).toContain("\nspec:\n  engine: llamacpp\n");
    expect(sec).toContain(
      "The `gufo-glm53-exp` template is a `ModelHost` with `engine: llamacpp`, not the `gufo` engine.",
    );
  });

  // Kills: rewording or dropping the promotion-cells sentence.
  test("promotion cells stay unavailable", () => {
    expect(sec).toContain(
      "The promotion cells stay `unavailable` until promotion evidence is committed.",
    );
  });

  // Kills: reintroducing a file:line citation; renaming or moving a cited
  // symbol out of the file the doc names; a cited symbol losing the
  // behaviour the doc attributes to it.
  test("source citations name symbols that exist in the cited files", () => {
    expect(/\.ts:\d/.test(sec), "no file:line citation").toBe(false);
    const citations: [symbol: string, path: string, src: string, declaration: string][] = [
      ["USAGE", "packages/cli/src/commands/eval.ts", evalSrc, "const USAGE = `"],
      ["VALUED_FLAGS", "packages/cli/src/commands/eval-perf.ts", evalPerfSrc, "const VALUED_FLAGS"],
      [
        "runEvalPerf",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "export async function runEvalPerf(",
      ],
      [
        "defaultPerfDbPath",
        "packages/cli/src/commands/bench-schedule.ts",
        benchScheduleSrc,
        "export function defaultPerfDbPath(",
      ],
      [
        "printPerfTable",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "function printPerfTable(",
      ],
      [
        "resolveRunInput",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "function resolveRunInput(",
      ],
      [
        "createPerfHostReaders",
        "packages/eval/src/perf/readers.ts",
        readersSrc,
        "export function createPerfHostReaders(",
      ],
      [
        "hostReaders",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "function hostReaders(",
      ],
      [
        "remoteReasons",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "function remoteReasons(",
      ],
      [
        "collectHfRevision",
        "packages/eval/src/perf/provenance.ts",
        provenanceSrc,
        "function collectHfRevision(",
      ],
      [
        "isExternalOnlyEngine",
        "packages/eval/src/matrix/types.ts",
        typesSrc,
        "export function isExternalOnlyEngine(",
      ],
      [
        "buildBootCommandForModelSpec",
        "packages/eval/src/matrix/lifecycle.ts",
        lifecycleSrc,
        "export function buildBootCommandForModelSpec(",
      ],
      [
        "ensureModelServing",
        "packages/eval/src/matrix/lifecycle.ts",
        lifecycleSrc,
        "export async function ensureModelServing(",
      ],
    ];
    for (const [symbol, path, src, declaration] of citations) {
      expect(sec, `cites \`${symbol}\``).toContain(`\`${symbol}\``);
      expect(sec, `cites \`${path}\``).toContain(`\`${path}\``);
      expect(src, `${path} declares ${symbol}`).toContain(declaration);
    }
    // What each cited function is credited with lives in that function.
    const credited: [signature: string, src: string, needle: string][] = [
      ["export function createPerfHostReaders(", readersSrc, "is Linux-only"],
      ["export function buildBootCommandForModelSpec(", lifecycleSrc, "run the server externally"],
      ["export async function ensureModelServing(", lifecycleSrc, "run the server externally"],
      ["function resolveRunInput(", evalPerfSrc, "--pid needs a loopback --url"],
      ["export async function runEvalPerf(", evalPerfSrc, "is not serving '"],
    ];
    for (const [signature, src, needle] of credited) {
      expect(enclosingBody(src, signature), `${signature} ${needle}`).toContain(needle);
    }
    for (const needle of [
      "(`USAGE`, `packages/cli/src/commands/eval.ts`)",
      "`VALUED_FLAGS` (`packages/cli/src/commands/eval-perf.ts`)",
      "(`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`)",
      "(`hostReaders`, `packages/cli/src/commands/eval-perf.ts`)",
      "(`buildBootCommandForModelSpec` and `ensureModelServing`, `packages/eval/src/matrix/lifecycle.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Every citation in the subsection, pinned as one phrase: the claim it
  // supports, the cited symbol(s) and the cited path together. Each cited
  // symbol must be declared in the cited file, and where the citation credits
  // a function with a behaviour, that behaviour must live in its body.
  // Kills: moving a citation to another file (e.g. `defaultPerfDbPath` to
  // `packages/eval/src/perf/diff.ts`, which also declares one); swapping two
  // citations between claims (e.g. `hostReaders` <-> `remoteReasons`);
  // renaming or moving a cited symbol out of the cited file; moving the
  // credited behaviour out of the cited function.
  test("every evidence citation pins claim, symbol and path together", () => {
    const sources = new Map<string, string>([
      ["packages/cli/src/commands/eval.ts", evalSrc],
      ["packages/cli/src/commands/eval-perf.ts", evalPerfSrc],
      ["packages/cli/src/commands/bench-schedule.ts", benchScheduleSrc],
      ["packages/eval/src/perf/readers.ts", readersSrc],
      ["packages/eval/src/perf/metrics.ts", metricsSrc],
      ["packages/eval/src/perf/provenance.ts", provenanceSrc],
      ["packages/eval/src/matrix/types.ts", typesSrc],
      ["packages/eval/src/matrix/lifecycle.ts", lifecycleSrc],
    ]);
    type Cited = { symbol: string; path: string; declaration: string; credits?: string[] };
    const rows: { phrase: string; cited: Cited[] }[] = [
      {
        phrase:
          "Both are copied verbatim from the USAGE text (`USAGE`, `packages/cli/src/commands/eval.ts`)",
        cited: [
          {
            symbol: "USAGE",
            path: "packages/cli/src/commands/eval.ts",
            declaration: "const USAGE = `Usage: llamactl eval <subcommand>",
          },
        ],
      },
      {
        phrase:
          "every valued flag in it is in `VALUED_FLAGS` (`packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "VALUED_FLAGS",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "const VALUED_FLAGS: ReadonlySet<string> = new Set([",
          },
        ],
      },
      {
        phrase:
          "exits 1 with `engine at <url> is not serving '<model>' (serving: ...)` (`runEvalPerf`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "runEvalPerf",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "export async function runEvalPerf(",
            credits: ["is not serving '"],
          },
        ],
      },
      {
        phrase:
          "`$DEV_STORAGE` or `~/.llamactl` (`defaultPerfDbPath`, `packages/cli/src/commands/bench-schedule.ts`), or to `--db`.",
        cited: [
          {
            symbol: "defaultPerfDbPath",
            path: "packages/cli/src/commands/bench-schedule.ts",
            declaration: "export function defaultPerfDbPath(",
            credits: ['join(llamactlHome(), "eval")', '"perf.sqlite"'],
          },
        ],
      },
      {
        phrase:
          "`run_id: <id>` and then a `| metric | status | value | reason |` table (`runEvalPerf` and `printPerfTable`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "runEvalPerf",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "export async function runEvalPerf(",
            credits: ["run_id: "],
          },
          {
            symbol: "printPerfTable",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function printPerfTable(",
            credits: ["| metric | status | value | reason |"],
          },
        ],
      },
      {
        phrase:
          "`--pid` needs a loopback `--url` (`resolveRunInput`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "resolveRunInput",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function resolveRunInput(",
            credits: ["--pid needs a loopback --url"],
          },
        ],
      },
      {
        phrase:
          "with a reason naming the unknown engine PID (`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`).",
        cited: [
          {
            symbol: "createPerfHostReaders",
            path: "packages/eval/src/perf/readers.ts",
            declaration: "export function createPerfHostReaders(",
            credits: ["engine PID unknown"],
          },
        ],
      },
      {
        phrase:
          "GTT comes from the GTT probe on any loopback Linux run, with or without `--pid` (`hostReaders`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "hostReaders",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function hostReaders(",
            credits: ["readers.gtt = linuxGttReader();"],
          },
        ],
      },
      {
        phrase:
          "on macOS each is recorded `unavailable` with a named reason (`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`, and `hostReaders`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "createPerfHostReaders",
            path: "packages/eval/src/perf/readers.ts",
            declaration: "export function createPerfHostReaders(",
            credits: ["is Linux-only"],
          },
          {
            symbol: "hostReaders",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function hostReaders(",
            credits: ["are Linux-only"],
          },
        ],
      },
      {
        phrase:
          "every host counter is recorded `unavailable`, with a reason naming the remote engine (`remoteReasons`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "remoteReasons",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function remoteReasons(",
            credits: ["is not on this host; per-process counters need a local engine PID"],
          },
        ],
      },
      {
        phrase: "The 16 `PERF_METRIC_NAMES` (`packages/eval/src/perf/metrics.ts`) are",
        cited: [
          {
            symbol: "PERF_METRIC_NAMES",
            path: "packages/eval/src/perf/metrics.ts",
            declaration: "export const PERF_METRIC_NAMES = [",
          },
        ],
      },
      {
        phrase:
          "Each `PROVENANCE_UNAVAILABLE_FIELDS` field (`packages/eval/src/matrix/types.ts`) —",
        cited: [
          {
            symbol: "PROVENANCE_UNAVAILABLE_FIELDS",
            path: "packages/eval/src/matrix/types.ts",
            declaration: "export const PROVENANCE_UNAVAILABLE_FIELDS = [",
          },
        ],
      },
      {
        phrase:
          'For example, "gguf path is not under an HF snapshots/<rev>/ directory" (`collectHfRevision`, `packages/eval/src/perf/provenance.ts`).',
        cited: [
          {
            symbol: "collectHfRevision",
            path: "packages/eval/src/perf/provenance.ts",
            declaration: "function collectHfRevision(",
            credits: ["gguf path is not under an HF snapshots/<rev>/ directory"],
          },
        ],
      },
      {
        phrase:
          "`gufo` and `kapitsa` are external-only eval engines (`isExternalOnlyEngine`, `packages/eval/src/matrix/types.ts`).",
        cited: [
          {
            symbol: "isExternalOnlyEngine",
            path: "packages/eval/src/matrix/types.ts",
            declaration: "export function isExternalOnlyEngine(",
            credits: ['engine === "gufo" || engine === "kapitsa"'],
          },
        ],
      },
      {
        phrase:
          'the matrix lifecycle refuses with "... run the server externally" (`buildBootCommandForModelSpec` and `ensureModelServing`, `packages/eval/src/matrix/lifecycle.ts`).',
        cited: [
          {
            symbol: "buildBootCommandForModelSpec",
            path: "packages/eval/src/matrix/lifecycle.ts",
            declaration: "export function buildBootCommandForModelSpec(",
            credits: ["run the server externally"],
          },
          {
            symbol: "ensureModelServing",
            path: "packages/eval/src/matrix/lifecycle.ts",
            declaration: "export async function ensureModelServing(",
            credits: ["run the server externally"],
          },
        ],
      },
    ];
    for (const { phrase, cited } of rows) {
      expect(sec, `claim + citation: ${phrase}`).toContain(phrase);
      for (const { symbol, path, declaration, credits } of cited) {
        expect(phrase, `row names \`${symbol}\``).toContain(`\`${symbol}\``);
        expect(phrase, `row names \`${path}\``).toContain(`\`${path}\``);
        expect(declaration, `declaration names ${symbol}`).toContain(symbol);
        const src = sources.get(path) ?? "";
        expect(src, `${path} declares ${symbol}`).toContain(declaration);
        for (const needle of credits ?? []) {
          expect(enclosingBody(src, declaration), `${symbol} in ${path}: ${needle}`).toContain(
            needle,
          );
        }
      }
    }
    // The table covers every parenthesised or inline citation in the section.
    const citedPaths = [...sec.matchAll(/`(packages\/[^`]+\.ts)`/g)].map((m) => m[1]);
    const tabled = rows.flatMap(({ phrase }) =>
      [...phrase.matchAll(/`(packages\/[^`]+\.ts)`/g)].map((m) => m[1]),
    );
    expect(tabled, "every cited path in the section is a pinned row").toEqual(citedPaths);
  });
});

// Part of #518
// Kills: dropping the doc paragraph, leaving the stale "no router, catalog,
// lifecycle or CLI code calls them" claim, unwiring the CLI from
// evaluateQualification, or dropping the strict evidence schema.
describe("#518 qualification propose doc", () => {
  test("demotion section documents the read-only propose CLI", () => {
    const dem = flat(sectionBody(/^### Demotion/) ?? "");
    for (const needle of [
      "`llamactl qualification propose",
      "`PromotionEvidenceSchema`",
      "`parsePromotionEvidence`",
    ]) {
      expect(dem, needle).toContain(needle);
    }
    expect(dem).not.toContain("no router, catalog, lifecycle or CLI code calls them");
    expect(dem.toLowerCase()).toContain("library-only");
  });

  test("propose CLI and evidence schema are wired in source", () => {
    const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/qualification.ts"));
    for (const needle of [
      "parsePromotionEvidence(",
      "evaluateQualification(",
      "applyQualification(",
    ]) {
      expect(cli, needle).toContain(needle);
    }
    const promotion = readOrEmpty(join(REPO, "packages/core/src/qualification/promotion.ts"));
    for (const needle of [
      "export const PromotionEvidenceSchema",
      "export function parsePromotionEvidence",
    ]) {
      expect(promotion, needle).toContain(needle);
    }
  });
});

// Part of #522: scheduled perf suite capture slice (#768 `--engine` on
// `bench schedule add`, the suite runner's provenance nulls, loop engine
// forwarding). Source pins run before doc pins so a source mutant surfaces
// its own needle; every source pin is already true at base, so only the
// missing doc subsection fails.
describe("#522 scheduled perf suite capture (#768)", () => {
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const scheduleSchemaSrc = readOrEmpty(join(REPO, "packages/remote/src/bench/schedule.ts"));
  const scheduleLoopSrc = readOrEmpty(join(REPO, "packages/remote/src/bench/scheduleLoop.ts"));
  const provenanceSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/provenance.ts"));

  const sec = flat(sectionBody(/^### Scheduled perf suites for an arm/) ?? "");
  const runner = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");

  // Kills: deleting or renaming the subsection.
  test("section exists and follows the eval perf subsection", () => {
    expect(sec.length).toBeGreaterThan(0);
    const scheduled = doc.indexOf("### Scheduled perf suites for an arm");
    const evidence = doc.indexOf("### Capturing evidence for an arm");
    expect(scheduled).toBeGreaterThan(evidence);
    expect(scheduled).toBeGreaterThanOrEqual(0);
    expect(evidence).toBeGreaterThanOrEqual(0);
  });

  // Kills: removing `--engine` or `--slots` from USAGE or changing the engine
  // list without a doc update.
  test("add synopsis copied verbatim from USAGE", () => {
    const span =
      "[--kind suite --suite <perf-quick|perf-full> [--engine <llamacpp|omlx|gufo|kapitsa>] [--slots <n>]]";
    expect(benchScheduleSrc).toContain(span);
    expect(sec).toContain(span);
    expect(sec).toContain("`llamactl bench schedule add <id> --node <node> --rel <rel>`");
  });

  // Kills: the doc synopsis dropping `[--mode auto|text|vision]` (or any
  // other part of the add lines), or the USAGE add lines changing without a
  // doc update. The add lines are read from the source USAGE text itself.
  test("add synopsis block is a verbatim copy of the USAGE add lines", () => {
    const usageStart = benchScheduleSrc.indexOf("const USAGE = `");
    const usage =
      usageStart === -1
        ? ""
        : benchScheduleSrc.slice(usageStart, benchScheduleSrc.indexOf("`;", usageStart));
    const usageLines = usage.split("\n");
    const addAt = usageLines.findIndex((line) => line.startsWith("  llamactl bench schedule add "));
    const nextAt = usageLines.findIndex(
      (line, i) => i > addAt && line.startsWith("  llamactl bench schedule "),
    );
    const addLines = addAt === -1 || nextAt === -1 ? [] : usageLines.slice(addAt, nextAt);
    expect(addLines.length).toBe(3);
    expect(addLines.join("\n")).toContain("[--mode auto|text|vision] --every <duration>");
    const block = ["```text", ...addLines, "```"].join("\n");
    const raw = sectionBody(/^### Scheduled perf suites for an arm/) ?? "";
    expect(raw).toContain(block);
    expect(sec).toContain(
      "The `add` synopsis below is copied verbatim from the USAGE text (`packages/cli/src/commands/bench-schedule.ts`):",
    );
  });

  // Kills: planAddArgs no longer requiring --every, or the doc calling
  // `--every <duration>` optional.
  test("--every is required", () => {
    const plan = enclosingBody(benchScheduleSrc, "function planAddArgs(");
    expect(plan).toContain('if (!args.every) return { error: "--every is required" };');
    expect(sec).toContain(
      "`--every <duration>` is required: without it the CLI refuses with `--every is required` (`planAddArgs`,",
    );
    expect(sec).not.toContain("optional flag `--every");
    // Kills: calling --mode required, or planAddArgs dropping its "auto" default.
    expect(plan).toContain('const mode = args.mode ?? "auto";');
    expect(sec).toContain("takes an optional `--mode`, and `--every <duration>` is required");
  });

  // Kills: validateSuiteArgs no longer refusing an unknown engine, or the
  // doc dropping the CLI up-front refusal or the runner-only lastError path.
  test("unknown engine: CLI refuses up front; runner lastError otherwise", () => {
    const validate = enclosingBody(benchScheduleSrc, "function validateSuiteArgs(");
    expect(validate).toContain(
      "if (engine !== undefined && !(EVAL_ENGINES as readonly string[]).includes(engine)) {",
    );
    expect(validate).toContain(
      "return `unknown engine '${engine}' (expected one of ${EVAL_ENGINES.join(\", \")})`;",
    );
    expect(enclosingBody(benchScheduleSrc, "function planAddArgs(")).toContain(
      "const kindError = validateSuiteArgs(kind, args.suite, args.engine);",
    );
    for (const needle of [
      "A CLI `add` refuses an unknown engine id up front with `unknown engine '<id>' (expected one of llamacpp, omlx, gufo, kapitsa)` (`validateSuiteArgs`,",
      "only a schedule saved another way reaches the suite runner, where an unknown engine id is refused before any endpoint work and lands in the schedule's `lastError`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: flipping the default engine, dropping the kind gate in the CLI
  // or schema, or dropping the runner's engine check.
  test("engine gate and default", () => {
    const validate = enclosingBody(benchScheduleSrc, "function validateSuiteArgs(");
    expect(validate).toContain("--engine is only valid when kind is 'suite'");
    expect(validate).toContain("unknown engine '");
    expect(scheduleSchemaSrc).toContain("engine is only valid with kind 'suite'");
    expect(runner).toContain('req.engine ?? "llamacpp"');
    for (const needle of [
      "`--engine` is accepted only with `--kind suite`",
      "`--engine is only valid when kind is 'suite'`",
      "a suite schedule without `--engine`, including one saved before #768, records `llamacpp`",
      "an unknown engine id is refused before any endpoint work and lands in the schedule's `lastError`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: the loop dropping `engine`, or failures no longer landing in
  // lastError.
  test("loop forwards the engine and records failures", () => {
    const loop = enclosingBody(scheduleLoopSrc, "async function runWithOutcome(");
    expect(loop).toContain("schedule.engine !== undefined ? { engine: schedule.engine } : {}");
    expect(loop).toContain("lastError: msg");
    expect(sec).toContain("the tick loop forwards the schedule's engine to the suite runner");
  });

  // Kills: removing either refusal, or the doc claiming a residency or
  // window gate.
  test("HTTP agent node already serving the rel; no window check", () => {
    const endpoint = enclosingBody(benchScheduleSrc, "async function defaultEndpoint(");
    expect(endpoint).toContain("perf suite runs need an HTTP agent endpoint");
    const serves = enclosingBody(benchScheduleSrc, "async function assertServesModel(");
    expect(serves).toContain("is not serving '");
    for (const needle of [
      "`perf suite runs need an HTTP agent endpoint`",
      "`node '<node>' is not serving '<rel>' (serving: ...)`",
      "a schedule never starts or stops the engine",
      "if <rel> is not served when the tick fires, the run fails into `lastError`",
      "for exclusive-group arms, schedule it to fire inside the exclusive window",
    ]) {
      expect(sec, needle).toContain(needle);
    }
    expect(sec).not.toContain("only produces rows inside the exclusive window");
  });

  // Kills: changing the run id format, scheduled runs gaining fabricated
  // provenance, or the host readers being wired without a doc update.
  test("rows, run id and provenance nulls", () => {
    for (const needle of [
      "`${req.scheduleId}-${new Date().toISOString()}`",
      "through the agent gateway; the engine binary path is not known",
      "which exposes no engine process counters",
      "(overrides.openDb ?? defaultOpenDb)()",
    ]) {
      expect(runner, needle).toContain(needle);
    }
    for (const needle of [
      "`<id>-<ISO timestamp>`",
      "`engine_version`, `engine_commit`, `binary_sha256`, `gguf_sha256`, `hf_revision`, `quant` and `ctx` are recorded null",
      "scheduled suites reach <rel> through the agent gateway",
      "SSD I/O, peak RSS and GTT are recorded `unavailable` with a reason naming the node",
      "the same `perf.sqlite` as `llamactl eval perf`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: dropping the opt-in loop caveat.
  test("loop lifecycle", () => {
    expect(benchScheduleSrc).toContain("only runs while");
    expect(benchScheduleSrc).toContain("Run one tick now");
    expect(sec).toContain("schedules fire only while `llamactl bench schedule run` is alive");
    expect(sec).toContain("`llamactl bench schedule kick` runs one tick now");
  });

  // Kills: deleting the section (no longer vacuous), citing a moved or
  // renamed file, or adding a file:line citation.
  test("citations are paths that exist, never file:line", () => {
    expect(sec.length).toBeGreaterThan(0);
    const cited = [...sec.matchAll(/`(packages\/[^`\s]+\.ts)`/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(cited.length).toBeGreaterThan(0);
    expect(cited).toContain("packages/cli/src/commands/bench-schedule.ts");
    for (const p of cited) {
      expect(existsSync(join(REPO, p)), p).toBe(true);
    }
    expect(/\.ts:\d/.test(sec)).toBe(false);
  });

  // Kills: the doc implying that `host` identifies the engine node, or the
  // runner swapping in node-side readers without a doc update.
  test("provenance host is the CLI host, not the node", () => {
    expect(provenanceSrc).toContain("host: readers.hostname()");
    expect(runner).toContain("ev.defaultProvenanceReaders()");
    expect(sec).toContain(
      "provenance `host` is the machine running `llamactl bench schedule run` or `kick`, not <node>",
    );
  });
});

// Part of #522: c2/c4 slot discovery slice (#775). Source pins run before
// doc pins so a source mutant surfaces its own needle; every source pin is
// already true at base, so only the missing doc subsection fails.
describe("#522 c2/c4 slot discovery (#775)", () => {
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const clientSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/client.ts"));
  const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/runner.ts"));
  const metricsSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/metrics.ts"));
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));

  const sec = flat(sectionBody(/^### Concurrency slots for c2 and c4/) ?? "");

  // Kills: deleting or misplacing the subsection.
  test("subsection sits in the eval record after scheduled suites", () => {
    expect(sec.length).toBeGreaterThan(0);
    const lines = doc.split("\n");
    const slotIdx = lines.indexOf("### Concurrency slots for c2 and c4");
    const schedIdx = lines.indexOf("### Scheduled perf suites for an arm");
    expect(slotIdx).toBeGreaterThan(schedIdx);
    expect(lines.slice(schedIdx + 1, slotIdx).some((line) => line.startsWith("## "))).toBe(false);
  });

  // Kills: changing the levels, dropping the slotsReason fallback, or the
  // doc claiming c1 needs slots.
  test("c1 needs no slot count; c2/c4 do", () => {
    expect(metricsSrc).toContain("export const CONCURRENCY_LEVELS = [1, 2, 4] as const;");
    const body = enclosingBody(runnerSrc, "async function runConcurrencyLevel(");
    for (const needle of [
      "level > 1 && slots === null",
      'run.opts.slotsReason ?? "engine slots unknown (slot count not provided)"',
      "engine slots ${String(slots)} < concurrency ${String(level)}",
    ]) {
      expect(body, needle).toContain(needle);
    }
    for (const needle of [
      "`c1_tps` needs no slot count",
      "engine slots <n> < concurrency <level>",
      "(`runConcurrencyLevel`, `packages/eval/src/perf/runner.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: probing non-llamacpp engines, --slots losing priority, the
  // --engine default changing, or a reason-text change.
  test("eval perf resolution order: --slots, then the default llamacpp engine is probed", () => {
    const body = enclosingBody(evalPerfSrc, "async function resolveSlots(");
    for (const needle of [
      "if (input.slots !== null) return { slots: input.slots, slotsReason: undefined };",
      'if (input.engine !== "llamacpp") {',
      "does not advertise a llama-server GET /props slot count; pass --slots <n> to measure c2/c4",
      "`${probe.reason}; pass --slots <n> to measure c2/c4`",
    ]) {
      expect(body, needle).toContain(needle);
    }
    expect(body).not.toContain("timeoutMs");
    expect(enclosingBody(evalPerfSrc, "function resolveRunInput(")).toContain(
      'values["--engine"] ?? "llamacpp"',
    );
    expect(enclosingBody(evalPerfSrc, "export async function runEvalPerf(")).toContain(
      "await resolveSlots(",
    );
    for (const needle of [
      "takes the count from `--slots <n>` when given",
      "only the `llamacpp` engine (the `--engine` default) is probed",
      "`engine '<engine>' does not advertise a llama-server GET /props slot count; pass --slots <n> to measure c2/c4`",
      "(`resolveSlots`, `packages/cli/src/commands/eval-perf.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing the endpoint or timeout, or the doc claiming a probe
  // failure aborts the run.
  test("probeEngineSlots never fails the run", () => {
    const body = enclosingBody(clientSrc, "export async function probeEngineSlots(");
    for (const needle of [
      "`${root}/props`",
      '"total_slots"',
      "opts.timeoutMs ?? 5000",
      "failed: ${message}; engine slot count unknown",
      "returned HTTP ${String(resp.status)}; engine slot count unknown",
      "carried no positive integer total_slots; engine slot count unknown",
    ]) {
      expect(body, needle).toContain(needle);
    }
    for (const needle of [
      "reads `total_slots` from `GET <url>/props` with a 5-second timeout",
      "The probe never fails the run",
      "an HTTP error, a fetch failure or a body without a positive integer `total_slots`",
      "`; pass --slots <n> to measure c2/c4`",
      "(`probeEngineSlots`, `packages/eval/src/perf/client.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: the runner dropping the /props unreachability reason or
  // slotsReason, or the doc claiming scheduled suites set a slot count
  // unconditionally.
  test("scheduled suites set slots only from the schedule", () => {
    const body = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");
    expect(body).toContain("which forwards only /v1/* and not the engine's /props");
    expect(body).toContain("slotsReason");
    for (const needle of [
      "the agent gateway forwards only `/v1/*`",
      "with a reason naming the rel, the node and the gateway",
      "(`createPerfBenchSuiteRunner`, `packages/cli/src/commands/bench-schedule.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: a moved or renamed file, or a line-number citation.
  test("citations exist, never file:line", () => {
    const cited = [...sec.matchAll(/`(packages\/[^`]+\.ts)`/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const p of cited) {
      expect(existsSync(join(REPO, p)), p).toBe(true);
    }
    for (const p of [
      "packages/cli/src/commands/eval-perf.ts",
      "packages/eval/src/perf/client.ts",
      "packages/eval/src/perf/runner.ts",
      "packages/cli/src/commands/bench-schedule.ts",
    ]) {
      expect(cited, p).toContain(p);
    }
    expect(/\.ts:\d/.test(sec)).toBe(false);
  });
});

describe("#522 comparing perf runs (#663)", () => {
  const diffSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/diff.ts"));
  const matrixDiffSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/diff.ts"));
  const metricsSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/metrics.ts"));
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const evalSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval.ts"));

  const sec = flat(sectionBody(/^### Comparing perf runs for an arm/) ?? "");

  // Kills: deleting or misplacing the subsection.
  test("subsection sits in the eval record after c2/c4 slots", () => {
    expect(sec.length).toBeGreaterThan(0);
    const lines = doc.split("\n");
    const cmpIdx = lines.indexOf("### Comparing perf runs for an arm");
    const slotIdx = lines.indexOf("### Concurrency slots for c2 and c4");
    expect(cmpIdx).toBeGreaterThan(slotIdx);
    expect(lines.slice(slotIdx + 1, cmpIdx).some((line) => line.startsWith("## "))).toBe(false);
  });

  // Kills: a flag renamed in the header or in the doc.
  test("synopsis copied verbatim from the script header", () => {
    const srcLines = diffSrc.split("\n");
    const usageIdx = srcLines.indexOf(" * Usage:");
    const rest = usageIdx === -1 ? [] : srcLines.slice(usageIdx + 1);
    const endIdx = rest.findIndex((line) => line === " *");
    const usageLines = endIdx === -1 ? rest : rest.slice(0, endIdx);
    const synopsis = usageLines.map((line) => line.replace(/^ \*/, "").trim()).join(" ");
    const expected =
      "bun packages/eval/src/perf/diff.ts --base <run_id> --candidate <run_id> \\ [--db <path>] [--model <name>] [--format md|json] [--tolerance <fraction>]";
    expect(synopsis).toBe(expected);
    expect(sec).toContain(expected);
  });

  // Kills: an exit-code swap (2 vs 1), a dropped read-only open, a changed
  // message, or a changed regression exit code.
  test("refusals and exit codes", () => {
    const mainBody = flat(enclosingBody(diffSrc, "export function perfDiffMain("));
    for (const needle of [
      "new Database(args.db, { readonly: true })",
      "err(`db not found at ${args.db}`); return 1;",
      "err(`no perf rows for run '${args.base}'`); return 2;",
      "err(`run '${args.base}' holds more than one model; pass --model <name>`); return 1;",
      "filterFor(args.base, args.model)",
      "filterFor(args.candidate, args.model)",
      'return diffs.some((d) => d.verdict === "regressed") ? 3 : 0;',
    ]) {
      expect(mainBody, needle).toContain(needle);
    }
    expect(enclosingBody(diffSrc, "function err(")).toContain("`perf-diff: ${msg}\\n`");
    expect(enclosingBody(diffSrc, "function parsePerfDiffArgs(")).toContain(
      '"--base and --candidate are required"',
    );
    for (const needle of [
      "`perf-diff: --base and --candidate are required`",
      "The store is opened read-only, so a diff never writes to it",
      "a missing file exits 1 with `perf-diff: db not found at <path>`",
      "A run id with no rows exits 2 with `perf-diff: no perf rows for run '<id>'`",
      "exits 1 with `perf-diff: run '<id>' holds more than one model; pass --model <name>`, and `--model` then filters both runs",
      "The script exits 3 when any metric is `regressed` and 0 otherwise",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: flipping any direction on either side, or dropping a metric.
  test("direction table matches PERF_METRIC_HIGHER_IS_BETTER", () => {
    const body = enclosingBody(diffSrc, "export const PERF_METRIC_HIGHER_IS_BETTER");
    const entries = [...body.matchAll(/^\s+(\w+): (true|false),$/gm)];
    expect(entries.length).toBe(16);
    const namesBody = enclosingBody(metricsSrc, "export const PERF_METRIC_NAMES");
    expect((namesBody.match(/"[^"]+"/g) ?? []).length).toBe(16);
    expect(sec).toContain("higher is better for ");
    expect(sec).toContain("; lower is better for ");
    expect(sec).toContain(". A metric with no direction");
    const higherMarker = "higher is better for ";
    const lowerMarker = "; lower is better for ";
    const endMarker = ". A metric with no direction";
    const higher = sec.slice(
      sec.indexOf(higherMarker) + higherMarker.length,
      sec.indexOf(lowerMarker),
    );
    const lower = sec.slice(sec.indexOf(lowerMarker) + lowerMarker.length, sec.indexOf(endMarker));
    for (const entry of entries) {
      const name = entry[1];
      const isHigher = entry[2] === "true";
      if (name === undefined) {
        continue;
      }
      const haystack = isHigher ? higher : lower;
      const other = isHigher ? lower : higher;
      expect(haystack, name).toContain(`\`${name}\``);
      expect(other, name).not.toContain(`\`${name}\``);
    }
    const diffBody = enclosingBody(diffSrc, "export function diffPerfRuns(");
    expect(diffBody).toContain("no direction for metric ${metricName}");
    for (const needle of [
      "`no direction for metric <name>`",
      "The verdicts are `improved`, `regressed`, `unchanged` and `unavailable`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: an absolute tolerance, `<` instead of `<=`, unavailable counted as
  // regressed, or a changed default tolerance.
  test("tolerance is relative; unavailable never regresses", () => {
    const diffBody = enclosingBody(diffSrc, "export function diffPerfRuns(");
    for (const needle of [
      "Math.abs(baseline.value) * tolerance",
      '"missing in baseline"',
      '"missing in candidate"',
      "opts.tolerance ?? 0",
    ]) {
      expect(diffBody, needle).toContain(needle);
    }
    const compareBody = enclosingBody(matrixDiffSrc, "export function compareMetric(");
    for (const needle of [
      'baseline.status === "unavailable" || candidate.status === "unavailable"',
      'verdict: "unavailable"',
      "Math.abs(delta) <= (opts.tolerance ?? 0)",
    ]) {
      expect(compareBody, needle).toContain(needle);
    }
    const toleranceBody = enclosingBody(diffSrc, "function parseTolerance(");
    for (const needle of [
      "if (raw === undefined) return 0;",
      "!Number.isFinite(value) || value < 0",
      "--tolerance must be a finite number >= 0",
    ]) {
      expect(toleranceBody, needle).toContain(needle);
    }
    for (const needle of [
      "`--tolerance <fraction>` defaults to 0 and must be a finite number >= 0",
      "It is a fraction of the baseline value, not an absolute delta",
      "a change no larger than `abs(baseline) * <fraction>` is `unchanged` (`compareMetric`, `packages/eval/src/matrix/diff.ts`)",
      "(`missing in baseline` or `missing in candidate`)",
      "the verdict is `unavailable` with both sides' reasons, never `regressed`",
      "exit 0 does not mean every metric was measured",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: the two default paths diverging, or a moved citation.
  test("default db is the shared perf.sqlite", () => {
    expect(enclosingBody(diffSrc, "export function defaultPerfDbPath(")).toContain(
      'join(llamactlHome(env), "eval", "perf.sqlite")',
    );
    const scheduleBody = enclosingBody(benchScheduleSrc, "export function defaultPerfDbPath(");
    expect(scheduleBody).toContain('join(llamactlHome(), "eval")');
    expect(scheduleBody).toContain('"perf.sqlite"');
    expect(sec).toContain(
      "(`defaultPerfDbPath`, `packages/eval/src/perf/diff.ts`), the same file `eval perf` and `bench schedule` suites write",
    );
  });

  // Kills: changed md header or json keys.
  test("output headers", () => {
    const mdBody = enclosingBody(diffSrc, "export function renderPerfDiffMd(");
    for (const needle of [
      "`baseline: ${meta.base} (${meta.baseModel}, ${meta.baseEngine})`",
      "`candidate: ${meta.cand} (${meta.candModel}, ${meta.candEngine})`",
    ]) {
      expect(mdBody, needle).toContain(needle);
    }
    expect(enclosingBody(diffSrc, "export function renderPerfDiffJson(")).toContain(
      "{ baseline: meta.base, candidate: meta.cand, diffs }",
    );
    for (const needle of [
      "`baseline: <run_id> (<model>, <engine>)`",
      "`candidate: <run_id> (<model>, <engine>)`",
      "`--format json` prints `baseline`, `candidate` and `diffs` (`renderPerfDiffJson`)",
      "the promotion cells in the table above stay `unavailable`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: a moved or renamed file, or a line-number citation.
  test("citations exist, never file:line", () => {
    const cited = [...sec.matchAll(/`(packages\/[^`]+\.ts)`/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const p of cited) {
      expect(existsSync(join(REPO, p)), p).toBe(true);
    }
    for (const p of [
      "packages/eval/src/perf/diff.ts",
      "packages/eval/src/matrix/diff.ts",
      "packages/cli/src/commands/eval.ts",
    ]) {
      expect(sec, p).toContain(p);
      expect(cited, p).toContain(p);
    }
    expect(/\.ts:\d/.test(sec)).toBe(false);
  });
});

// Part of #521: declared suite slots slice (#521 `--slots` on
// `bench schedule add`, the schedule schema's slots field, the loop's
// slots forwarding, the CLI-side runner's slots/slotsReason split).
// Source pins run before doc pins so a source mutant surfaces its own
// needle; the doc subsection does not exist at base, so the doc
// assertions fail.
describe("#521 scheduled suite declared slots", () => {
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));

  const sec = flat(sectionBody(/^### Concurrency slots for c2 and c4/) ?? "");

  // Kills: deleting or misplacing the declared-slots doc text.
  test("doc pins the declared-slots contract", () => {
    for (const needle of [
      "A suite schedule can declare the slot count with `--slots <n>`",
      "`--slots is only valid when kind is 'suite'`",
      "`--slots must be a positive integer`",
      "without `--slots`, scheduled suite runs set no slot count",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: the runner passing req.slots through unvalidated, or
  // planAddArgs skipping the --slots gate.
  test("source pins slots validation in the runner and add planning", () => {
    expect(
      enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner("),
      "runner validates slots",
    ).toContain("invalid slots");
    expect(
      enclosingBody(benchScheduleSrc, "function planAddArgs("),
      "planAddArgs validates --slots",
    ).toContain("validateSlotsArg(");
  });
});

// Part of #518 slice (a): preset promotion refuses experimental rels.
// Kills: the doc paragraph missing, or a guard that does not read
// catalogQualificationStages.
describe("#518 preset promotion refuses experimental rels", () => {
  test("qualification section documents the preset-promotion refusal", () => {
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    for (const needle of [
      "never as a preset default",
      "`writePresetOverride` (`packages/core/src/presets.ts`)",
      "`llamactl catalog promote`",
      "`llamactl.catalog.promote`",
      "`catalogQualificationStages`",
    ]) {
      expect(q, needle).toContain(needle);
    }
    expect(
      readOrEmpty(join(REPO, "packages/core/src/presets.ts")),
      "presets.ts reads catalogQualificationStages",
    ).toContain("catalogQualificationStages");
  });
});

// Part of #521: `llamactl eval perf-diff` wires perfDiffMain into the eval
// dispatcher. Source pins run before doc pins; at base the dispatch case,
// the runEvalPerfDiff wrapper, the USAGE line and the doc text are all
// missing, so every case fails by assertion.
describe("#521 llamactl eval perf-diff (comparing perf runs)", () => {
  const evalSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval.ts"));

  // Kills: removing the `case "perf-diff"` dispatch or the runEvalPerfDiff
  // call, or pointing the wrapper at the wrong entry point.
  test("dispatch routes perf-diff through runEvalPerfDiff to perfDiffMain(argv, process.env)", () => {
    const runBody = enclosingBody(evalSrc, "export async function runEval(");
    for (const needle of ['case "perf-diff":', "runEvalPerfDiff(rest)"]) {
      expect(runBody, needle).toContain(needle);
    }
    for (const needle of ['case "run":', 'case "report":', 'case "leaderboard":', 'case "perf":']) {
      expect(runBody, needle).toContain(needle);
    }
    expect(enclosingBody(evalSrc, "function runEvalPerfDiff(")).toContain(
      "perfDiffMain(argv, process.env)",
    );
  });

  // Kills: the perf-diff USAGE line going missing, or drifting to an
  // interpolated line.
  test("USAGE lists the perf-diff synopsis verbatim", () => {
    const line =
      "  perf-diff --base <run_id> --candidate <run_id> [--db <path>] [--model <name>] [--format md|json] [--tolerance <fraction>]";
    expect(evalSrc.split("\n")).toContain(line);
    expect(evalSrc).not.toMatch(/\n {2}\$\{[A-Z_]+\}\n/);
  });

  // Kills: the doc going stale against the verb, or the verb shipping
  // without a doc update.
  test("comparing perf runs section names the verb and its delegation", () => {
    const s = flat(sectionBody(/^### Comparing perf runs for an arm/) ?? "");
    for (const needle of [
      "`llamactl eval perf-diff`",
      "the `run`, `report`, `leaderboard`, `perf` and `perf-diff` subcommands (`runEval`, `packages/cli/src/commands/eval.ts`)",
      "delegates to `perfDiffMain`",
      "the same exit codes and `perf-diff:` messages",
    ]) {
      expect(s, needle).toContain(needle);
    }
    expect(s).not.toContain("There is no `llamactl` verb for it");
  });
});

// Part of #522: load and prefill metrics slice
// Source pins run before doc pins so a source mutant surfaces its own
// needle; the doc subsection does not exist at base, so the doc
// assertions fail.
describe("#522 load and prefill metrics (#781)", () => {
  const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/runner.ts"));
  const suitesSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/suites.ts"));
  const clientSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/client.ts"));
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const serveSrc = readOrEmpty(join(REPO, "packages/remote/src/server/serve.ts"));
  const openaiSrc = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));

  const buildOptsBody = enclosingBody(evalPerfSrc, "function buildOpts(");
  const benchBody = enclosingBody(benchScheduleSrc, "export function createPerfBenchSuiteRunner(");
  const loadHookBody = enclosingBody(runnerSrc, "async function runLoadHook(");
  const prefillBody = enclosingBody(runnerSrc, "async function runPrefillSize(");

  const sec = flat(sectionBody(/^### Load and prefill metrics for an arm/) ?? "");

  // Kills: deleting or misplacing the subsection.
  test("subsection sits in the eval record after comparing perf runs", () => {
    expect(sec.length).toBeGreaterThan(0);
    const lines = doc.split("\n");
    const loadIdx = lines.indexOf("### Load and prefill metrics for an arm");
    const cmpIdx = lines.indexOf("### Comparing perf runs for an arm");
    expect(loadIdx).toBeGreaterThan(cmpIdx);
    expect(lines.slice(cmpIdx + 1, loadIdx).some((line) => line.startsWith("## "))).toBe(false);
  });

  // Kills: a caller starting to pass `load:` without a doc update, or the
  // doc claiming load is measured.
  test("no shipped caller injects load hooks", () => {
    expect(runnerSrc).toContain("export interface PerfSuiteLoadHooks");
    expect(runnerSrc).toContain("The runner performs no readiness");
    expect(buildOptsBody).not.toMatch(/\bload:/);
    expect(benchBody).not.toMatch(/\bload:/);
    for (const needle of [
      "are measured only when the caller injects load hooks",
      "(`PerfSuiteLoadHooks` and `runLoadHook`, `packages/eval/src/perf/runner.ts`)",
      "it performs no readiness probe of its own",
      "Neither `llamactl eval perf` nor a scheduled suite injects load hooks",
      "the two load metrics are always recorded `unavailable`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing either reason text, dropping the loadReason forwarding,
  // or swapping the two reasons.
  test("per-caller load reasons", () => {
    expect(buildOptsBody).toContain(
      "eval perf runs against an engine already serving '${input.model}' at ${input.url}; it does not launch or reload the engine, so cold/warm model-load time is not measured",
    );
    expect(benchBody).toContain(
      "model load for ${req.rel} happens on node '${req.node}'; scheduled suites reach an already-serving engine through the agent gateway and do not load or reload it, so cold/warm load time is not measured",
    );
    expect(benchBody).toContain("loadReason,");
    for (const needle of [
      "`eval perf runs against an engine already serving '<model>' at <url>; it does not launch or reload the engine, so cold/warm model-load time is not measured`",
      "(`buildOpts`, `packages/cli/src/commands/eval-perf.ts`)",
      "`model load for <rel> happens on node '<node>'; scheduled suites reach an already-serving engine through the agent gateway and do not load or reload it, so cold/warm load time is not measured`",
      "(`createPerfBenchSuiteRunner`, `packages/cli/src/commands/bench-schedule.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing the fallback text, changing the step-failure format,
  // removing the non-finite guard, or deleting its `>= 0` half.
  test("load fallback, hook failure and invalid elapsed time", () => {
    expect(loadHookBody).toContain(
      'run.opts.loadReason ?? "no load hooks injected (engine not managed by the suite)"',
    );
    expect(loadHookBody).toContain("Number.isFinite(elapsed) && elapsed >= 0");
    expect(loadHookBody).toContain('unavailableMetric("non-finite load time")');
    expect(loadHookBody).toContain("await hook();");
    expect(enclosingBody(runnerSrc, "function createPerfSuiteRun(")).toContain(
      "`${name} failed: ${message}`",
    );
    for (const needle of [
      "`no load hooks injected (engine not managed by the suite)`",
      "records `<metric> failed: <message>`",
      "a non-finite or negative elapsed time records `non-finite load time`",
      "the perf diff reports both load metrics `unavailable` for runs from these commands, never `regressed`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: reordering or dropping a ctx source, or changing the
  // unknown-ctx reason.
  test("context resolution order", () => {
    const resolveBody = enclosingBody(runnerSrc, "async function resolveModelCtx(");
    const resolveOrder = [
      "run.opts.ctx ?? null",
      "run.opts.provenance.ctx",
      "ctxFromModelsPayload(await run.client.listModels())",
    ];
    let cursor = -1;
    for (const needle of resolveOrder) {
      const at = resolveBody.indexOf(needle);
      expect(at, needle).toBeGreaterThan(cursor);
      cursor = at;
    }
    const payloadBody = enclosingBody(runnerSrc, "function ctxFromModelsPayload(");
    const payloadOrder = [
      'entry["context_length"]',
      'entry["max_model_len"]',
      'meta?.["n_ctx"]',
      'meta?.["n_ctx_train"]',
    ];
    cursor = -1;
    for (const needle of payloadOrder) {
      const at = payloadBody.indexOf(needle);
      expect(at, needle).toBeGreaterThan(cursor);
      cursor = at;
    }
    const suiteBody = enclosingBody(runnerSrc, "export async function runPerfSuite(");
    const loadAt = suiteBody.indexOf("await runLoadPhase(");
    const ctxAt = suiteBody.indexOf("await resolveModelCtx(");
    const prefillAt = suiteBody.indexOf("await runPrefillPhase(");
    expect(loadAt).toBeLessThan(ctxAt);
    expect(ctxAt).toBeLessThan(prefillAt);
    for (const needle of [
      "Prefill runs after the load phase",
      "the suite's `ctx` option (`--ctx` on `eval perf`), then the provenance `ctx`, then the first `/v1/models` entry's `context_length`, `max_model_len`, `meta.n_ctx` or `meta.n_ctx_train`",
      "(`resolveModelCtx`, `packages/eval/src/perf/runner.ts`)",
      "`model context unknown`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing any prefill reason or the 8-token tolerance, moving
  // the token-exact build after the context guard, or moving the
  // unknown-context check after the build.
  test("prefill refusals", () => {
    for (const needle of [
      '"model context unknown"',
      '"could not build a token-exact prompt"',
      "prefill ${String(tokens)} tokens exceeds model context ${String(ctx)}",
      "engine counted ${String(stream.promptTokens)} prompt tokens for target ${String(tokens)}",
      "> 8",
      "tokens + run.decodeTokens > ctx",
    ]) {
      expect(prefillBody, needle).toContain(needle);
    }
    expect(prefillBody.indexOf('"model context unknown"')).toBeLessThan(
      prefillBody.indexOf("await buildTokenExactPrompt("),
    );
    expect(prefillBody.indexOf("await buildTokenExactPrompt(")).toBeLessThan(
      prefillBody.indexOf("tokens + run.decodeTokens > ctx"),
    );
    expect(runnerSrc).toContain('tokens: 4096, metricName: "prefill_4k_tps"');
    expect(runnerSrc).toContain('tokens: 65536, metricName: "prefill_64k_tps"');
    expect(suitesSrc).toContain('"perf-quick": { decodeTokens: 16');
    expect(suitesSrc).toContain('"perf-full": { decodeTokens: 64');
    for (const needle of [
      "before the context guard",
      "`could not build a token-exact prompt`",
      "(16 for `perf-quick`, 64 for `perf-full`; `PERF_SUITES`, `packages/eval/src/perf/suites.ts`)",
      "`prefill <n> tokens exceeds model context <ctx>`",
      "more than 8 off the target records `engine counted <n> prompt tokens for target <target>`",
      "(`runPrefillSize`, `packages/eval/src/perf/runner.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: changing the tokenize default path or error text; a caller
  // overriding tokenizePath; a scheduled suite starting to set a ctx; the
  // gateway's /v1/models entries gaining a context field; the gateway
  // routing non-/v1 paths; or the doc blaming /tokenize instead of the
  // unknown context.
  test("tokenize endpoint and scheduled-suite prefill", () => {
    expect(clientSrc).toContain('tokenizePath: options.tokenizePath ?? "/tokenize"');
    expect(clientSrc).toContain("tokenize HTTP ${String(resp.status)} at ${ctx.tokenizePath}");
    expect(buildOptsBody).not.toContain("tokenizePath");
    expect(benchBody).not.toContain("tokenizePath");
    expect(enclosingBody(evalPerfSrc, "export async function runEvalPerf(")).not.toContain(
      "tokenizePath",
    );
    expect(benchBody).toContain("ctx: null,");
    const start = benchBody.indexOf("ev.runPerfSuite)(db, {");
    expect(start).toBeGreaterThanOrEqual(0);
    const loadReasonAt = benchBody.indexOf("loadReason,", start);
    expect(loadReasonAt).toBeGreaterThan(start);
    expect(benchBody.slice(start, loadReasonAt)).not.toMatch(/\bctx\b/);
    expect(suitesSrc).not.toMatch(/\bctx\b/);
    const modelsBody = enclosingBody(openaiSrc, "function buildListOpenAIModels(");
    expect(modelsBody).toContain('capabilities: ["chat"]');
    expect(modelsBody).not.toMatch(/context_length|max_model_len|n_ctx|\bmeta\b/);
    expect(enclosingBody(openaiSrc, "export async function listServingOpenAIModels(")).not.toMatch(
      /context_length|max_model_len|n_ctx|\bmeta\b/,
    );
    expect(serveSrc).toContain('url.pathname.startsWith("/v1/") || url.pathname === "/v1"');
    for (const needle of [
      "(the `tokenizePath` default in `createHttpPerfEngineClient`, `packages/eval/src/perf/client.ts`)",
      "records `<metric> failed: tokenize HTTP <status> at /tokenize`",
      "A scheduled suite sets no model context",
      "its provenance `ctx` is null and it passes no `ctx` option",
      "the gateway's `/v1/models` entries carry no `context_length`, `max_model_len` or `meta` (`buildListOpenAIModels`, `packages/core/src/openaiProxy.ts`)",
      "so every prefill size records `model context unknown` and `/tokenize` is never called",
      "routes only `/v1/*` paths, and `/tokenize` is not one of them",
      "run `llamactl eval perf` against the engine's own URL",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: adding `|| url.pathname === "/tokenize"` to the gateway's /v1
  // guard in serve.ts (P9), or a separate /tokenize route in
  // handleOpenAIRoute (P13). Either makes the doc's "/tokenize is not
  // routed by the agent gateway" claim false.
  test("agent gateway routes no /tokenize path", () => {
    expect(serveSrc).toContain('url.pathname.startsWith("/v1/") || url.pathname === "/v1"');
    expect(serveSrc).not.toMatch(/["'`]\/tokenize/);
    expect(serveSrc).not.toContain("tokenize");
    const routeBody = enclosingBody(serveSrc, "async function handleOpenAIRoute(");
    expect(routeBody.length).toBeGreaterThan(0);
    expect(routeBody).not.toContain("tokenize");
  });

  // Kills: a moved or renamed file, or a line-number citation.
  test("citations exist, never file:line", () => {
    const cited = [...sec.matchAll(/`(packages\/[^`]+\.ts)`/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const p of cited) {
      expect(existsSync(join(REPO, p)), p).toBe(true);
    }
    for (const p of [
      "packages/eval/src/perf/runner.ts",
      "packages/eval/src/perf/suites.ts",
      "packages/eval/src/perf/client.ts",
      "packages/cli/src/commands/eval-perf.ts",
      "packages/cli/src/commands/bench-schedule.ts",
      "packages/core/src/openaiProxy.ts",
    ]) {
      expect(cited, p).toContain(p);
    }
    expect(/\.ts:\d/.test(sec)).toBe(false);
  });
});
