import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

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
      "[--kind suite --suite <perf-quick|perf-full> [--engine <llamacpp|omlx|gufo|kapitsa>] [--slots <n>] [--quant <label>] [--ctx <n>] [--flags=<args>] [--hf-revision <rev>]]";
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
