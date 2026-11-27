// RED tests for frozename/llamactl#522. They pin the operator doc
// docs/dynamic-fleet-models.md against the live source-of-truth exports
// (catalog meta fields, qualification stages, promotion metrics and
// thresholds, override fields, exclusive-group catalog rows and workload
// templates). Repo files only — no network, no processes, no live state —
// so a missing or stale doc fails by assertion, never by throw.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { qualificationOverrideFields } from "../../src/qualification/overrides.js";
import { PROMOTION_METRICS, PromotionThresholdsSchema } from "../../src/qualification/promotion.js";
import { PROMOTION_LADDER } from "../../src/qualification/stages.js";
import {
  isOccupyingResidencyState,
  RESIDENCY_GROUPS,
  RESIDENCY_STATES,
  RESIDENCY_TRANSITIONS,
} from "../../src/residency/lifecycle.js";
import { existsSync } from "../../src/safe-fs.js";
import { curatedMetaFields, QUALIFICATION_STAGES } from "../../src/schemas.js";
import {
  ALL_REFUSALS_LISTED,
  DOC,
  doc,
  enclosingBody,
  exclusiveRows,
  flat,
  glmArmIds,
  readOrEmpty,
  REFUSAL_REASONS,
  REPO,
  residencyTemplates,
  type RunbookRow,
  runbookRows,
  RUNTIME_ARM,
  sectionBody,
  TEMPLATE_PORT,
  TRANSITION_REFUSALS,
  WORKLOAD_NAME,
} from "./dynamic-fleet-models/helpers.js";

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
      "On a claimed pass for a stale legacy pending switch, it sweeps every interrupted row.",
      "A nonterminal `committed` switch retains its reservation and lifecycle rows across agent restarts because its replacement process may still be live. Boot reports a `dispatchUnverified` count for these operations.",
      "When the store holds no nonterminal operation row, it also sweeps lifecycle rows interrupted outside a switch, such as a direct start whose agent died in `loading`, once they have made no progress for 30 minutes and their workload is proven down, under its own claim of the apply-profile fence.",
      "A workload that is not proven down, for example an engine that outlived its agent, keeps its row.",
      "Any nonterminal operation row keeps this sweep off. When no profile-switch row is nonterminal, boot recovery first finishes `evict:` rows that have made no progress for 30 minutes as `unknown`, so a crashed eviction no longer disables the outside-a-switch sweep; a younger or malformed `evict:` row still keeps it off, and until then an operator stop or `llamactl residency force-unload` clears a stuck interrupted row, and an `evict:` row does not block either.",
      "`failInterruptedLifecycleRows`",
      "#517",
    ]) {
      expect(s, n).toContain(n);
    }
    expect(s).not.toContain("rows have no boot recovery yet");
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
