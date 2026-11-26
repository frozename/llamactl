// Part of #522: qualification command output slice.
import { expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { QUALIFICATION_STAGES } from "../../../src/schemas.js";
import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/qualification.ts"));
const S = flat(sectionBody(/^### Reading `llamactl qualification` output/) ?? "");

function expectDocNeedles(needles: readonly string[]): void {
  for (const needle of needles) {
    expect(S, needle).toContain(needle);
  }
}

function expectNeedles(body: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(body, needle).toContain(needle);
  }
}

// Kills: the refusal text drifting; the isLocalDispatch guard being removed; the unknown-subcommand text changing.
test("node-local refusal, unknown subcommand and output channels", () => {
  expectDocNeedles([
    "`qualification: overrides are node-local; run this command on the target node (selected node '<node>' is not local)`",
    "`Unknown qualification subcommand: <subcommand>`",
    "plain text on stdout",
    "`--json`",
    "stderr and exits 1",
  ]);

  const body = enclosingBody(cli, "function dispatchQualification(");
  expect(body.length).toBeGreaterThan(0);
  expectNeedles(body, [
    "if (!isLocalDispatch()) {",
    "overrides are node-local; run this command on the target node (selected node '${node}' is not local)",
    "Unknown qualification subcommand: ${subcommand}",
  ]);
});

// Kills: the success-line wording changing; the second `overrides:` line being dropped; the missing-rel, stage, reason or removal refusal wording drifting; the stage order drifting; the default author changing.
test("pin/freeze/unpin/unfreeze/unapply lines and refusals", () => {
  expectDocNeedles([
    "`pinned <rel> at <stage>`",
    "`froze <rel>`",
    "`unpinned <rel>`",
    "`unfroze <rel>`",
    "`unapplied <rel>`",
    "`overrides: <file>`",
    "`qualification <verb>: <rel> is required`",
    "`qualification pin: <stage> is required`",
    "`qualification pin: unknown stage '<stage>' (expected experimental | candidate | validated | production | degraded)`",
    "`qualification <verb>: --reason is required`",
    "`qualification unpin: no pin override for '<rel>'`",
    "`qualification unfreeze: no freeze override for '<rel>'`",
    "`qualification unapply: no applied stage for '<rel>'`",
    "the OS user name, else `operator`",
  ]);

  const mutationBody = enclosingBody(cli, "function mutationCommand(");
  expect(mutationBody.length).toBeGreaterThan(0);
  expectNeedles(mutationBody, [
    "qualification ${action}: <rel> is required",
    "`pinned ${rel} at ${built.row.stage}` : `froze ${rel}`",
    'qualification ${action}: ${messages.join("; ")}',
    "overrides: ${ctx.file}",
  ]);

  const buildBody = enclosingBody(cli, "function buildOverrideRow(");
  expect(buildBody.length).toBeGreaterThan(0);
  expectNeedles(buildBody, [
    'return { error: "<stage> is required" };',
    "error: `unknown stage '${declared}' (expected ${schemas.QUALIFICATION_STAGES.join(\" | \")})`,",
    'return { error: "--reason is required" };',
  ]);

  const removalBody = enclosingBody(cli, "function removalCommand(");
  expect(removalBody.length).toBeGreaterThan(0);
  expectNeedles(removalBody, [
    "qualification ${verb}: <rel> is required",
    "no applied stage for '${rel}'",
    "no ${action} override for '${rel}'",
    "`unpinned ${rel}`",
    "`unfroze ${rel}`",
    "`unapplied ${rel}`",
    "overrides: ${ctx.file}",
  ]);

  const authorBody = enclosingBody(cli, "function defaultAuthor(");
  expect(authorBody.length).toBeGreaterThan(0);
  expectNeedles(authorBody, ['return userInfo().username || "operator";']);
  expect(QUALIFICATION_STAGES.join(" | ")).toBe(
    "experimental | candidate | validated | production | degraded",
  );
});

// Kills: a dropped or reordered column; the "-" or "unstaged" placeholders changing; the sort being removed; the status missing-rel text changing.
test("status and list text layout", () => {
  expectDocNeedles([
    "five tab-separated lines",
    "`<rel> <effective stage>`",
    "`catalog <stage>`",
    "`pin <stage> (<author>): <reason>`",
    "`freeze <author>: <reason>`",
    "`applied <stage> (<author>): <reason>`",
    "`-` for an absent value",
    "`unstaged`",
    "`qualification status: <rel> is required`",
    "`<rel> <catalog stage> <pin stage> <frozen> <effective stage>`",
    "`frozen` or `-`",
    "sorted",
    "no header line",
  ]);

  const statusBody = enclosingBody(cli, "function statusCommand(");
  expect(statusBody.length).toBeGreaterThan(0);
  expectNeedles(statusBody, [
    "qualification status: <rel> is required",
    '`${rel}\\t${status.effective?.stage ?? "unstaged"}\\n`',
    '`catalog\\t${status.catalogStage ?? "-"}\\n`',
    "`pin\\t${pin}\\n`",
    "`freeze\\t${freeze}\\n`",
    "`applied\\t${applied}\\n`",
  ]);

  const listBody = enclosingBody(cli, "function listCommand(");
  expect(listBody.length).toBeGreaterThan(0);
  expectNeedles(listBody, [
    "[...rels].sort()",
    'status.freeze === null ? "-" : "frozen"',
    '`${status.rel}\\t${status.catalogStage ?? "-"}\\t${pin}\\t${frozen}\\t${effective}\\n`',
  ]);
});

// Kills: the line wording drifting; the failed or breached suffix being dropped; the JSON view keys changing.
test("propose and apply decision and apply lines", () => {
  expectDocNeedles([
    "`proposal <rel> <from> -> <to>`",
    "`demotion <rel> <from> -> <to> (breached: <metrics>)`",
    "`none <rel>: <reason>`",
    "` (failed: <metrics>)`",
    "`below-threshold`",
    "`apply: <status> (nothing written; autoApply has no writer here)`",
    "`apply: applied <rel> <from> -> <to>`",
    "`apply: proposed (nothing written; policy autoApply is off)`",
    "`apply: skipped (nothing written)`",
    "`rel`, `declared`, `overridesFile`, `decision` and `apply`",
  ]);

  const decisionBody = enclosingBody(cli, "function decisionLine(");
  expect(decisionBody.length).toBeGreaterThan(0);
  expectNeedles(decisionBody, [
    "`proposal ${rel} ${decision.proposal.from} -> ${decision.proposal.to}`",
    '`demotion ${rel} ${decision.proposal.from} -> ${decision.proposal.to} (breached: ${decision.proposal.breached.join(", ")})`',
    "`none ${rel}: ${decision.reason}`",
    'decision.reason === "below-threshold"',
    '`${base} (failed: ${decision.failed.join(", ")})`',
  ]);

  const applyBody = enclosingBody(cli, "function applyResultLine(");
  expect(applyBody.length).toBeGreaterThan(0);
  expectNeedles(applyBody, [
    "`apply: ${apply.status} (nothing written; autoApply has no writer here)\\n`",
    "`apply: applied ${rel} ${decision.proposal.from} -> ${decision.proposal.to}\\noverrides: ${file}\\n`",
    '"apply: proposed (nothing written; policy autoApply is off)\\n"',
    '"apply: skipped (nothing written)\\n"',
  ]);

  const proposalBody = enclosingBody(cli, "function proposalCommand(");
  expect(proposalBody.length).toBeGreaterThan(0);
  expectNeedles(proposalBody, [
    "const view = { rel, declared, overridesFile: ctx.file, decision, apply };",
  ]);
});

// Kills: the refusal texts drifting; the path-prefixed zod issues or the `invalid policy:` re-parse refusal being lost; the unstaged-rel refusal being removed.
test("propose and apply input refusals", () => {
  expectDocNeedles([
    "`qualification <verb>: `",
    "`--evidence is required`",
    "`--policy is required`",
    "`cannot read evidence file '<path>'`",
    "`invalid JSON in evidence file '<path>'`",
    "`invalid evidence file '<path>': <issues>`",
    "its key path",
    "`invalid policy: <issues>`",
    "`'<rel>' has no qualification stage`",
    "`cannot record applied stage: <detail>`",
  ]);

  const requiredBody = enclosingBody(cli, "function requiredFlag(");
  expect(requiredBody.length).toBeGreaterThan(0);
  expectNeedles(requiredBody, ["qualification ${verb}: ${name} is required\\n"]);

  const readBody = enclosingBody(cli, "function readJsonFile(");
  expect(readBody.length).toBeGreaterThan(0);
  expectNeedles(readBody, [
    "cannot read ${label} file '${path}'",
    "invalid JSON in ${label} file '${path}'",
  ]);

  const parseBody = enclosingBody(cli, "function parseProposeFile<T>(");
  expect(parseBody.length).toBeGreaterThan(0);
  expectNeedles(parseBody, ["`invalid ${label} file '${path}': ${messages.join(\"; \")}`"]);

  const evaluateBody = enclosingBody(cli, "function evaluateProposal(");
  expect(evaluateBody.length).toBeGreaterThan(0);
  expectNeedles(evaluateBody, ['invalid policy: ${messages.join("; ")}']);

  const proposalBody = enclosingBody(cli, "function proposalCommand(");
  expect(proposalBody.length).toBeGreaterThan(0);
  expectNeedles(proposalBody, [
    "qualification ${verb}: <rel> is required",
    "has no qualification stage",
    'cannot record applied stage: ${recordFailure.join("; ")}',
  ]);

  const runBody = enclosingBody(cli, "function runEvaluation(");
  expect(runBody.length).toBeGreaterThan(0);
  expectNeedles(runBody, ["cannot record applied stage: ${writeFailureDetail(err)}"]);
});

// Kills: the blanket "fields are tab-separated" sentence returning; a space-separated line form gaining a tab, or a status/list line losing one, without the doc following.
test("says exactly which output lines are tab-separated", () => {
  expect(S).not.toContain("the real output separates the fields with tabs");
  expectDocNeedles([
    "only two of them use tabs in the real output",
    "Each `status` line puts one tab between its label (the rel, on the first line) and its value; the value keeps its own spaces.",
    "Each `list` row puts a tab between each of its five fields.",
    "Every other line is space-separated exactly as written: the `pin`, `freeze`, `unpin`, `unfreeze` and `unapply` success lines, the `overrides: <file>` line, the `proposal`, `demotion` and `none` decision lines, and every `apply: ...` line.",
    "`pin`, `freeze` and `apply` take `--author`",
  ]);
  const refusals = S.slice(
    S.indexOf("The write refusals are:"),
    S.indexOf("`status <rel>` prints"),
  );
  expect(refusals.length).toBeGreaterThan(0);
  expect(refusals).not.toContain("--author");

  // The tab-carrying forms: status writes label\tvalue; list writes four tabs per row.
  const statusBody = enclosingBody(cli, "function statusCommand(");
  expect(statusBody.match(/process\.stdout\.write\(`[^`]*\\t/g)?.length).toBe(5);
  const listBody = enclosingBody(cli, "function listCommand(");
  const row =
    /process\.stdout\.write\(\s*`([^`]*)`/.exec(
      listBody.slice(listBody.lastIndexOf("process.stdout.write(")),
    )?.[1] ?? "";
  expect(row.split("\\t").length).toBe(5);

  // Every other text line is written without a tab.
  for (const sig of [
    "function mutationCommand(",
    "function removalCommand(",
    "function decisionLine(",
    "function applyResultLine(",
  ]) {
    const body = enclosingBody(cli, sig);
    expect(body.length, sig).toBeGreaterThan(0);
    expect(body, sig).not.toContain("\\t");
  }
});

// Kills: the source citation being dropped; a file:line citation being added; the cited path being renamed.
test("cites the CLI source by path only", () => {
  expect(S).toContain("`packages/cli/src/commands/qualification.ts`");
  expect(S).not.toMatch(/\.ts:\d+/);
  for (const match of S.matchAll(/`([^`]+)`/g)) {
    const token = match[1];
    if (token !== undefined && /^packages\/[\w./-]+\.ts$/.test(token)) {
      expect(existsSync(join(REPO, token)), token).toBe(true);
    }
  }
});
