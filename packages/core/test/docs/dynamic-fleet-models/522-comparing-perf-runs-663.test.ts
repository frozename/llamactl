import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

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
      "{ baseline: meta.base, candidate: meta.cand, diffs, provenance: meta.provenance }",
    );
    for (const needle of [
      "`baseline: <run_id> (<model>, <engine>)`",
      "`candidate: <run_id> (<model>, <engine>)`",
      "`--format json` prints `baseline`, `candidate`, `diffs` and `provenance` (`renderPerfDiffJson`)",
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
