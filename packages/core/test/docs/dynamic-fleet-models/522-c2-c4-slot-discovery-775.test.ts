import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

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
