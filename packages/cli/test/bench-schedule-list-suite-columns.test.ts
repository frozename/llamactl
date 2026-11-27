import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as benchCmd from "../src/commands/bench.js";
import { EMPTY_GLOBALS, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { captureProcessStreams } from "./helpers.js";

// Part of #521: `bench schedule list` and `bench schedule status` must show
// whether a row is a preset or a suite, plus the suite fields the operator
// declared because the gateway cannot discover them. At base the table has no
// KIND or DECLARED columns, so L1-L7 fail by assertion while G1 passes.

interface ScheduleShape {
  id: string;
  node: string;
  rel: string;
  mode: string;
  intervalSeconds: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  kind?: "preset" | "suite";
  suite?: string;
  engine?: string;
  slots?: number;
  quant?: string;
  ctx?: number;
  flags?: string[];
  hfRevision?: string;
}

interface LoopStatusShape {
  running: boolean;
  tickIntervalMs: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  inflight: boolean;
  recent: unknown[];
}

interface BenchScheduleCaller {
  benchScheduleList: () => Promise<ScheduleShape[]>;
  benchScheduleAdd: (input: unknown) => Promise<ScheduleShape[]>;
  benchScheduleRemove: (input: unknown) => Promise<ScheduleShape[]>;
  benchScheduleToggle: (input: unknown) => Promise<ScheduleShape[]>;
  benchSchedulerStatus: () => Promise<LoopStatusShape>;
  benchSchedulerStart: (input?: unknown) => Promise<LoopStatusShape>;
  benchSchedulerStop: () => Promise<LoopStatusShape>;
  benchSchedulerKick: () => Promise<LoopStatusShape>;
}

type SeamOptions = Parameters<typeof benchCmd.__setBenchScheduleTestSeams>[0];
type SeamCaller = NonNullable<SeamOptions["caller"]>;

const LOOP_STATUS: LoopStatusShape = {
  running: false,
  tickIntervalMs: 60_000,
  lastTickAt: null,
  nextTickAt: null,
  inflight: false,
  recent: [],
};

function installFakeCaller(schedules: ScheduleShape[]): { caller: BenchScheduleCaller } {
  const rejected = (): Promise<never> => Promise.reject(new Error("unexpected procedure"));
  return {
    caller: {
      benchScheduleList: () => Promise.resolve(schedules),
      benchScheduleAdd: () => rejected(),
      benchScheduleRemove: () => rejected(),
      benchScheduleToggle: () => rejected(),
      benchSchedulerStatus: () => Promise.resolve(LOOP_STATUS),
      benchSchedulerStart: () => rejected(),
      benchSchedulerStop: () => rejected(),
      benchSchedulerKick: () => rejected(),
    },
  };
}

function installSchedules(schedules: ScheduleShape[]): void {
  const { caller } = installFakeCaller(schedules);
  benchCmd.__setBenchScheduleTestSeams({ caller: caller as unknown as SeamCaller });
}

const P0: ScheduleShape = {
  id: "p0",
  node: "gpu1",
  rel: "r/p0.gguf",
  mode: "auto",
  intervalSeconds: 3600,
  enabled: true,
  lastRunAt: null,
  lastError: null,
};

const P1: ScheduleShape = {
  id: "p1",
  node: "gpu1",
  rel: "r/p1.gguf",
  mode: "auto",
  intervalSeconds: 3600,
  enabled: true,
  lastRunAt: null,
  lastError: null,
  kind: "preset",
};

const S0: ScheduleShape = {
  id: "s0",
  node: "gpu1",
  rel: "r/s0.gguf",
  mode: "auto",
  intervalSeconds: 3600,
  enabled: true,
  lastRunAt: null,
  lastError: null,
  kind: "suite",
  suite: "perf-quick",
};

const SA: ScheduleShape = {
  id: "sa",
  node: "gpu1",
  rel: "r/sa.gguf",
  mode: "auto",
  intervalSeconds: 3600,
  enabled: true,
  lastRunAt: null,
  lastError: null,
  kind: "suite",
  suite: "perf-quick",
  engine: "gufo",
  slots: 4,
  quant: "Q4_K_M",
  ctx: 32_768,
  flags: ["-ngl", "99", "--no-mmap"],
  hfRevision: "0123456789abcdef0123456789abcdef01234567",
};

const SP: ScheduleShape = {
  id: "sp",
  node: "gpu1",
  rel: "r/sp.gguf",
  mode: "auto",
  intervalSeconds: 3600,
  enabled: true,
  lastRunAt: null,
  lastError: null,
  kind: "suite",
  suite: "perf-full",
  ctx: 8192,
  slots: 2,
};

const EXPECTED_HEADER = [
  "ID",
  "NODE",
  "REL",
  "MODE",
  "KIND",
  "DECLARED",
  "EVERY",
  "STATE",
  "LAST_RUN",
  "LAST_ERROR",
];

const SA_DECLARED =
  "engine=gufo,slots=4,quant=Q4_K_M,ctx=32768,flags=3," +
  "hfRevision=0123456789abcdef0123456789abcdef01234567";

function cells(line: string): string[] {
  return line.trim().split(/ {2,}/);
}

async function runSchedule(
  args: string[],
  schedules: ScheduleShape[],
): Promise<{ result: number; stdout: string; stderr: string; lines: string[] }> {
  installSchedules(schedules);
  const captured = await captureProcessStreams(() => benchCmd.runBench(args));
  return { ...captured, lines: captured.stdout.trimEnd().split("\n") };
}

function presetRow(id: string, rel: string): string[] {
  return [id, "gpu1", rel, "auto", "preset", "-", "3600", "enabled", "-", "-"];
}

describe("llamactl bench schedule list suite columns", () => {
  beforeEach(() => {
    setGlobals({ ...EMPTY_GLOBALS });
  });

  afterEach(() => {
    benchCmd.__resetBenchScheduleTestSeams();
    resetGlobals();
  });

  // Kills: ROW_HEADERS without KIND/DECLARED, or the columns in the wrong place.
  test("L1 list header includes KIND and DECLARED in column order", async () => {
    const { result, lines } = await runSchedule(["schedule", "list"], [P0]);
    expect(result).toBe(0);
    expect(cells(lines[0] ?? "")).toEqual(EXPECTED_HEADER);
  });

  // Kills: a missing kind rendered as anything other than preset; an explicit
  // preset rendered differently; DECLARED not `-` for a preset.
  test("L2 list renders missing and explicit preset kinds identically", async () => {
    const { result, lines } = await runSchedule(["schedule", "list"], [P0, P1]);
    expect(result).toBe(0);
    expect(cells(lines[1] ?? "")).toEqual(presetRow("p0", "r/p0.gguf"));
    expect(cells(lines[2] ?? "")).toEqual(presetRow("p1", "r/p1.gguf"));
  });

  // Kills: KIND without the suite id; a dropped field; flags rendered as
  // tokens instead of a count; a truncated hfRevision.
  test("L3 list renders every declared suite field", async () => {
    const { result, lines } = await runSchedule(["schedule", "list"], [SA]);
    expect(result).toBe(0);
    expect(cells(lines[1] ?? "")).toEqual([
      "sa",
      "gpu1",
      "r/sa.gguf",
      "auto",
      "suite:perf-quick",
      SA_DECLARED,
      "3600",
      "enabled",
      "-",
      "-",
    ]);
  });

  // Kills: object-key order instead of the fixed engine, slots, quant, ctx,
  // flags, hfRevision order.
  test("L4 list renders declared fields in fixed order", async () => {
    const { result, lines } = await runSchedule(["schedule", "list"], [SP]);
    expect(result).toBe(0);
    const row = cells(lines[1] ?? "");
    expect(row[4]).toBe("suite:perf-full");
    expect(row[5]).toBe("slots=2,ctx=8192");
  });

  // Kills: an empty string, or engine=llamacpp invented for an undeclared engine.
  test("L5 list renders a bare suite id with DECLARED dash", async () => {
    const { result, lines } = await runSchedule(["schedule", "list"], [S0]);
    expect(result).toBe(0);
    const row = cells(lines[1] ?? "");
    expect(row[4]).toBe("suite:perf-quick");
    expect(row[5]).toBe("-");
  });

  // Kills: status using a different row formatter.
  test("L6 status reuses the list columns before the loop line", async () => {
    const { result, lines } = await runSchedule(["schedule", "status"], [SA, P0]);
    expect(result).toBe(0);
    expect(cells(lines[0] ?? "")).toEqual(EXPECTED_HEADER);
    expect(cells(lines[1] ?? "")[5]).toBe(SA_DECLARED);
    expect(lines[lines.length - 1] ?? "").toMatch(/^loop: not running in this process/);
  });

  // Kills: USAGE not updated.
  test("L7 list help names kind and declared suite fields", async () => {
    const { result, stdout } = await runSchedule(["schedule", "list", "--help"], [P0]);
    expect(result).toBe(0);
    expect(stdout.replaceAll(/\s+/g, " ")).toContain(
      "Print every schedule (id, node, rel, mode, kind, declared suite fields, every, state, last run, last error). --json emits the raw array.",
    );
  });

  // Guard: passes on base and head; --json remains the raw array.
  test("G1 list --json emits the raw schedule array", async () => {
    const { result, stdout } = await runSchedule(["schedule", "list", "--json"], [SA]);
    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toEqual([SA]);
  });
});
