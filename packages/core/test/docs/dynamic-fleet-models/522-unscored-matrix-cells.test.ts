import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #522: unscored matrix cells slice.
describe("#522 unscored matrix cells", () => {
  const runner = readOrEmpty(join(REPO, "packages/eval/src/matrix/runner.ts"));
  const report = readOrEmpty(join(REPO, "packages/eval/src/matrix/report.ts"));
  const diff = readOrEmpty(join(REPO, "packages/eval/src/matrix/diff.ts"));
  const evidence = readOrEmpty(join(REPO, "packages/eval/src/qualification/evidence.ts"));
  const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/qualification.ts"));

  const S = flat(sectionBody(/^### Unscored matrix cells for an arm/) ?? "");
  const Q = flat(sectionBody(/^## Qualification and promotion/) ?? "");

  // Kills: recordBootError storing a nonzero n_rows or primary_metric_value,
  // or dropping errors: 1; the corpus-failure marker changing; the boot-error
  // call or warning being removed.
  test("which cells are unscored and what the runner stores", () => {
    for (const needle of [
      "A matrix cell is unscored when its `n_rows` is 0 or less",
      "`recordBootError`",
      '`n_rows` 0, `primary_metric_value` 0, `errors` 1 and `per_class_metrics_json` `{"error":"<reason>"}`',
      '`primary_metric_value` -1 and `per_class_metrics_json` `{"error":"corpus_load_failed"}`',
      "only the first line of the boot error is stored",
    ]) {
      expect(S, needle).toContain(needle);
    }

    const bootBody = enclosingBody(runner, "function recordBootError(");
    expect(bootBody.length).toBeGreaterThan(0);
    for (const needle of [
      "n_rows: 0,",
      "primary_metric_value: 0,",
      "per_class_metrics_json: JSON.stringify({ error }),",
      "errors: 1,",
    ]) {
      expect(bootBody, needle).toContain(needle);
    }

    const workloadBody = enclosingBody(runner, "async function runWorkloadCell(");
    expect(workloadBody.length).toBeGreaterThan(0);
    expect(workloadBody).toContain("primary_metric_value: -1,");
    expect(workloadBody).toContain(
      'per_class_metrics_json: JSON.stringify({ error: "corpus_load_failed" }),',
    );

    const modelCellsBody = enclosingBody(runner, "async function runModelCells(");
    expect(modelCellsBody.length).toBeGreaterThan(0);
    expect(modelCellsBody).toContain('const reason = bootErrorReason("model boot failed", err);');
    expect(modelCellsBody).toContain(
      "recordBootError(model, opts.workloads, runId, opts.db, reason)",
    );
    expect(modelCellsBody).toContain("[matrix] failed to boot ${model.name}");
  });

  // Kills: changing the reason text; treating n_rows 0 as scored.
  test("report reason strings", () => {
    for (const needle of [
      "`cellUnavailableReason`",
      "`no rows scored`, or `no rows scored (<error>)`",
      "a boot error cell reads `no rows scored (model boot failed: <first line of the boot error>)` and a corpus failure reads `no rows scored (corpus_load_failed)`",
    ]) {
      expect(S, needle).toContain(needle);
    }

    const reasonBody = enclosingBody(report, "export function cellUnavailableReason(");
    expect(reasonBody.length).toBeGreaterThan(0);
    for (const needle of [
      "if (cell.n_rows > 0) return null;",
      "return `no rows scored (${error})`",
      'return "no rows scored";',
      'typeof error === "string" && error !== ""',
    ]) {
      expect(reasonBody, needle).toContain(needle);
    }
  });

  // Kills: dropping the winner skip; moving or removing the Unavailable
  // section; rendering errors as unavailable; adding an n_rows filter to the
  // all-runs latest selection.
  test("report pivots, Unavailable cells section and winner", () => {
    for (const needle of [
      "renders `unavailable` for an unscored cell's primary metric, latency and throughput",
      "keeps its errors count",
      "`## Unavailable cells` section, between `## Errors` and `## Per-workload winner`",
      "`- <model> / <workload>: <reason>`",
      "omits the section when every cell scored",
      "`- <workload>: unavailable (no cell scored any rows)`",
      "`--report-all-runs`",
      "a later unscored cell replaces an earlier scored one",
    ]) {
      expect(S, needle).toContain(needle);
    }

    const pivotBody = enclosingBody(report, "function pivotValue(");
    expect(pivotBody.length).toBeGreaterThan(0);
    expect(pivotBody).toContain('section === "errors" ? String(cell.errors) : "unavailable"');

    const unavailableBody = enclosingBody(report, "function renderUnavailableList(");
    expect(unavailableBody.length).toBeGreaterThan(0);
    expect(unavailableBody).toContain('["## Unavailable cells", "", ...lines, ""] : []');

    const winnerBody = enclosingBody(report, "function renderWinnerList(");
    expect(winnerBody.length).toBeGreaterThan(0);
    expect(winnerBody).toContain("if (cellUnavailableReason(cell) !== null) continue;");
    expect(winnerBody).toContain("unavailable (no cell scored any rows)");

    const markdownBody = enclosingBody(report, "export function renderMarkdownReport(");
    expect(markdownBody.length).toBeGreaterThan(0);
    const errorsAt = markdownBody.indexOf("`## Errors`");
    const unavailableAt = markdownBody.indexOf("...renderUnavailableList(lookup),");
    const winnerAt = markdownBody.indexOf("renderWinnerList(workloads, lookup)");
    expect(errorsAt).toBeGreaterThanOrEqual(0);
    expect(unavailableAt).toBeGreaterThanOrEqual(0);
    expect(winnerAt).toBeGreaterThanOrEqual(0);
    expect(errorsAt).toBeLessThan(unavailableAt);
    expect(unavailableAt).toBeLessThan(winnerAt);

    const latestBody = enclosingBody(report, "function latestCellByModelWorkload(");
    expect(latestBody.length).toBeGreaterThan(0);
    expect(latestBody).toContain("existing.finished_at < cell.finished_at");
    expect(latestBody).not.toContain("n_rows");

    const csvBody = enclosingBody(report, "export function renderCsvReport(");
    expect(csvBody.length).toBeGreaterThan(0);
    expect(csvBody).toContain('? "unavailable"');
    expect(csvBody).toContain('["errors", (cell): string => (cell ? String(cell.errors) : "")]');
  });

  // Kills: removing the scored-first sort or the unavailable rendering;
  // changing the latest-selection order key; adding an n_rows skip to the
  // latest-per-key loop.
  test("matrix diff", () => {
    for (const needle of [
      "`bun packages/eval/src/matrix/diff.ts`",
      "renders `unavailable` for the value, tps and p50_ms of an unscored cell",
      "in markdown, sorts it after the scored cells of its workload",
      "`--format json` keeps the raw numeric fields",
      "Without `--all-runs` the diff keeps the latest cell per model and workload by `started_at`, scored or not",
    ]) {
      expect(S, needle).toContain(needle);
    }

    const mdBody = enclosingBody(diff, "export function renderMd(cells: Cell[]): string {");
    expect(mdBody.length).toBeGreaterThan(0);
    expect(mdBody).toContain("if (aScored !== bScored) return aScored ? -1 : 1;");
    expect(mdBody).toContain('isUnscored ? "unavailable" : fmt(c.latency_p50_ms, 0)');

    const csvBody = enclosingBody(diff, "export function renderCsv(cells: Cell[]): string {");
    expect(csvBody.length).toBeGreaterThan(0);
    expect(csvBody).toContain('isUnscored ? "unavailable" : fmt(c.primary_metric_value, 4)');

    const jsonBody = enclosingBody(diff, "export function renderJson(");
    expect(jsonBody.length).toBeGreaterThan(0);
    expect(jsonBody).toContain("JSON.stringify(cells, null, 2)");

    const loadBody = enclosingBody(diff, "export function loadCells(");
    expect(loadBody.length).toBeGreaterThan(0);
    expect(loadBody).toContain("ORDER BY started_at DESC");
    expect(loadBody).toContain("if (args.allRuns) return all;");
    const allRunsAt = loadBody.indexOf("if (args.allRuns) return all;");
    expect(allRunsAt).toBeGreaterThanOrEqual(0);
    const tail = loadBody.slice(allRunsAt);
    expect(tail).toContain("seen.has(key)");
    expect(tail).not.toContain("n_rows");
  });

  // Kills: changing `<= 0` to `< 0` in the candidate or baseline missing
  // checks; adding an n_rows skip to candidate selection (Step 2); changing
  // the CLI missing-cell message or exit code.
  test("qualification evidence treats an unscored selected cell as missing", () => {
    for (const needle of [
      "A selected cell with `n_rows` of 0 or less counts as missing",
      "latest-cell selection does not skip unscored cells",
      "even if an earlier run scored it; `--run-id <id>` picks the scored run",
      "A selected baseline cell with `n_rows` of 0 or less is likewise a missing baseline cell, for a workload that has a candidate cell",
    ]) {
      expect(Q, needle).toContain(needle);
    }
    expect(S, "These cells never count as promotion evidence").toContain(
      "These cells never count as promotion evidence",
    );

    const evidenceBody = enclosingBody(evidence, "export function qualificationEvidenceFromCells(");
    expect(evidenceBody.length).toBeGreaterThan(0);
    for (const needle of [
      "if (selected === undefined || selected.n_rows <= 0) {",
      "if (baselineCell === undefined || baselineCell.n_rows <= 0) {",
      "if (!candidateByWorkload.has(w)) continue;",
      "c.finished_at > existing.finished_at",
    ]) {
      expect(evidenceBody, needle).toContain(needle);
    }
    const step2At = evidenceBody.indexOf("// Step 2");
    const step3At = evidenceBody.indexOf("// Step 3");
    expect(step2At).toBeGreaterThanOrEqual(0);
    expect(step3At).toBeGreaterThanOrEqual(0);
    const step2 = evidenceBody.slice(step2At, step3At);
    expect(step2).toContain("c.finished_at > existing.finished_at");
    expect(step2).not.toContain("n_rows");

    const cliBody = enclosingBody(cli, "function evidenceCommand(rest: string[]): number {");
    expect(cliBody.length).toBeGreaterThan(0);
    expect(cliBody).toContain(
      "qualification evidence: no matrix cell for model ${model} workload ${entry.workload} (metric ${entry.metric})",
    );
    expect(cliBody).toContain("return 1;");
  });

  // Kills: writing line-number citations that go stale; citing a moved or
  // misspelled source path.
  test("no file:line citations; cited paths exist", () => {
    expect(S.length).toBeGreaterThan(0);
    expect(/\.ts:\d/.test(S), "no file:line citation in S").toBe(false);
    expect(/\.ts:\d/.test(Q), "no file:line citation in Q").toBe(false);

    const citedInS = [...S.matchAll(/`(packages\/[^`\s]+\.ts)`/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    const citedInQ = [...Q.matchAll(/`(packages\/[^`\s]+\.ts)`/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(citedInS.length).toBeGreaterThanOrEqual(3);
    for (const path of [...citedInS, ...citedInQ]) {
      expect(existsSync(join(REPO, path)), path).toBe(true);
    }
  });
});
