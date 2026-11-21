import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  type BenchSchedule,
  BenchScheduleSchema,
  loadSchedules,
  saveSchedules,
} from "../../src/bench/schedule.js";
import {
  type BenchClient,
  benchSchedulerStatus,
  kickBenchScheduler,
  startBenchScheduler,
  stopBenchScheduler,
} from "../../src/bench/scheduleLoop.js";
import { mkdtempSync, readFileSync, rmSync } from "../../src/safe-fs.js";

/**
 * Coverage for #521 (F-3): a schedule carrying `kind: "suite"` +
 * `suite: "<name>"` must dispatch the injected suite runner instead of
 * `benchPresetRun.subscribe`. The schema cases pin the wire contract
 * (suite requires kind, kind=suite requires suite, preset rejects
 * suite), the loop cases pin dispatch/stamping/missing-runner
 * behaviour, and the guard cases keep the legacy preset path and the
 * kindless on-disk shape honest.
 */

async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

type ScheduleExtras = { kind?: string; suite?: string };
type ScheduleFixture = BenchSchedule & ScheduleExtras;

const DUE_LAST_RUN = "2000-01-01T00:00:00.000Z";

function baseSchedule(id: string, overrides: Partial<ScheduleFixture> = {}): ScheduleFixture {
  return {
    id,
    node: "fake-node",
    rel: `org/repo/${id}.gguf`,
    mode: "auto",
    intervalSeconds: 86_400,
    enabled: true,
    lastRunAt: DUE_LAST_RUN,
    lastError: null,
    ...overrides,
  };
}

function suiteSchedule(id: string, overrides: Partial<ScheduleFixture> = {}): ScheduleFixture {
  return baseSchedule(id, { kind: "suite", suite: "perf", ...overrides });
}

type PresetSubscribeInput = { target: string; mode?: "auto" | "text" | "vision" };

interface PresetClientFake {
  getClient: (node: string) => BenchClient;
  subscribeInputs: PresetSubscribeInput[];
  getClientNodes: string[];
}

function presetClient(): PresetClientFake {
  const subscribeInputs: PresetSubscribeInput[] = [];
  const getClientNodes: string[] = [];
  const getClient = (node: string): BenchClient => {
    getClientNodes.push(node);
    return {
      benchPresetRun: {
        subscribe(input, callbacks): { unsubscribe?: () => void } {
          subscribeInputs.push(input);
          callbacks.onComplete();
          return {};
        },
      },
    };
  };
  return { getClient, subscribeInputs, getClientNodes };
}

type SuiteRunRequest = {
  scheduleId: string;
  suite: string;
  node: string;
  rel: string;
};

interface SuiteRunnerFake {
  runSuite: (request: SuiteRunRequest) => Promise<void>;
  calls: SuiteRunRequest[];
}

function suiteRunner(error?: Error): SuiteRunnerFake {
  const calls: SuiteRunRequest[] = [];
  const runSuite = (request: SuiteRunRequest): Promise<void> => {
    calls.push(request);
    if (error !== undefined) return Promise.reject(error);
    return Promise.resolve();
  };
  return { runSuite, calls };
}

let tmp = "";
let previousEnv: string | undefined;
let schedulePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-benchsuite-"));
  schedulePath = join(tmp, "schedules.yaml");
  previousEnv = process.env["LLAMACTL_BENCH_SCHEDULES"];
  process.env["LLAMACTL_BENCH_SCHEDULES"] = schedulePath;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env["LLAMACTL_BENCH_SCHEDULES"];
  else process.env["LLAMACTL_BENCH_SCHEDULES"] = previousEnv;
  stopBenchScheduler();
  rmSync(tmp, { recursive: true, force: true });
});

describe("bench schedule suite dispatch", () => {
  test("suite schedule persists kind and suite through save/load", () => {
    saveSchedules([suiteSchedule("suite-persist")], schedulePath);

    const entry = loadSchedules(schedulePath)[0] as ScheduleFixture;
    expect(entry.kind).toBe("suite");
    expect(entry.suite).toBe("perf");
  });

  test("schema rejects suite without kind, kind=suite without suite, and preset with suite", () => {
    const base = baseSchedule("schema-check");

    expect(BenchScheduleSchema.safeParse({ ...base, kind: "suite" }).success).toBe(false);
    expect(BenchScheduleSchema.safeParse({ ...base, suite: "perf" }).success).toBe(false);
    expect(BenchScheduleSchema.safeParse({ ...base, kind: "preset", suite: "perf" }).success).toBe(
      false,
    );
  });

  test("due suite schedule dispatches runSuite instead of benchPresetRun", async () => {
    saveSchedules([suiteSchedule("suite-dispatch")], schedulePath);
    const { getClient, subscribeInputs, getClientNodes } = presetClient();
    const { runSuite, calls } = suiteRunner();

    await kickBenchScheduler(getClient, { runSuite });

    expect(calls).toEqual([
      {
        scheduleId: "suite-dispatch",
        suite: "perf",
        node: "fake-node",
        rel: "org/repo/suite-dispatch.gguf",
      },
    ]);
    expect(subscribeInputs).toEqual([]);
    expect(getClientNodes).toEqual([]);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "suite-dispatch")!;
    expect(entry.lastRunAt).not.toBe(DUE_LAST_RUN);
    expect(entry.lastError).toBeNull();

    const recent = benchSchedulerStatus().recent.find((r) => r.id === "suite-dispatch");
    expect(recent?.ok).toBe(true);
  });

  test("runSuite rejection stamps lastError and a failed recent entry", async () => {
    saveSchedules([suiteSchedule("suite-fail")], schedulePath);
    const { getClient, subscribeInputs } = presetClient();
    const { runSuite } = suiteRunner(new Error("suite boom"));

    await kickBenchScheduler(getClient, { runSuite });

    const entry = loadSchedules(schedulePath).find((s) => s.id === "suite-fail")!;
    expect(entry.lastError).toBe("suite boom");

    const recent = benchSchedulerStatus().recent.find((r) => r.id === "suite-fail");
    expect(recent?.ok).toBe(false);
    expect(recent?.message).toBe("suite boom");
    expect(subscribeInputs).toEqual([]);
  });

  test("suite schedule without an injected runner records a no-runner error", async () => {
    saveSchedules([suiteSchedule("suite-norunner")], schedulePath);
    const { getClient, subscribeInputs } = presetClient();

    await kickBenchScheduler(getClient);

    expect(subscribeInputs).toEqual([]);
    const entry = loadSchedules(schedulePath).find((s) => s.id === "suite-norunner")!;
    expect(entry.lastError ?? "").toMatch(/no suite runner/);
  });

  test("mixed tick dispatches preset via subscribe and suite via runSuite", async () => {
    saveSchedules([baseSchedule("mix-preset"), suiteSchedule("mix-suite")], schedulePath);
    const { getClient, subscribeInputs } = presetClient();
    const { runSuite, calls } = suiteRunner();

    await kickBenchScheduler(getClient, { runSuite });

    expect(subscribeInputs).toEqual([{ target: "org/repo/mix-preset.gguf", mode: "auto" }]);
    expect(calls).toEqual([
      {
        scheduleId: "mix-suite",
        suite: "perf",
        node: "fake-node",
        rel: "org/repo/mix-suite.gguf",
      },
    ]);

    const rows = loadSchedules(schedulePath);
    for (const id of ["mix-preset", "mix-suite"]) {
      const entry = rows.find((s) => s.id === id)!;
      expect(entry.lastRunAt).not.toBe(DUE_LAST_RUN);
      expect(entry.lastError).toBeNull();
    }
  });

  test("running scheduler dispatches due suite schedules on its tick", async () => {
    saveSchedules([suiteSchedule("suite-loop")], schedulePath);
    const { getClient, subscribeInputs } = presetClient();
    const { runSuite, calls: runSuiteCalls } = suiteRunner();

    startBenchScheduler({ getClient, runSuite, tickIntervalMs: 3_600_000 });
    await waitUntil(() => runSuiteCalls.length === 1 && !benchSchedulerStatus().inflight, 2_000);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "suite-loop")!;
    expect(entry.lastRunAt).not.toBe(DUE_LAST_RUN);
    expect(entry.lastError).toBeNull();
    expect(subscribeInputs).toEqual([]);
  });

  test("legacy schedule without kind/suite round-trips with neither key persisted", () => {
    saveSchedules([baseSchedule("legacy-roundtrip")], schedulePath);

    const entry = loadSchedules(schedulePath)[0] as ScheduleFixture;
    expect(entry.kind).toBeUndefined();
    expect(entry.suite).toBeUndefined();

    const doc = parseYaml(readFileSync(schedulePath, "utf8")) as Record<string, unknown>;
    const list = Object.values(doc).find((value): value is Record<string, unknown>[] =>
      Array.isArray(value),
    );
    const saved: Record<string, unknown> = list?.[0] ?? {};
    expect("kind" in saved).toBe(false);
    expect("suite" in saved).toBe(false);
  });

  test("legacy preset dispatches benchPresetRun and ignores the injected runner", async () => {
    for (const mode of ["auto", "vision"] as const) {
      const id = `legacy-${mode}`;
      saveSchedules([baseSchedule(id, { mode })], schedulePath);
      const { getClient, subscribeInputs, getClientNodes } = presetClient();
      const { runSuite, calls } = suiteRunner();

      await kickBenchScheduler(getClient, { runSuite });

      expect(subscribeInputs).toEqual([{ target: `org/repo/${id}.gguf`, mode }]);
      expect(calls).toEqual([]);
      expect(getClientNodes).toEqual(["fake-node"]);

      const entry = loadSchedules(schedulePath).find((s) => s.id === id)!;
      expect(entry.lastRunAt).not.toBe(DUE_LAST_RUN);
      expect(entry.lastError).toBeNull();
    }
  });
});

type EngineScheduleRow = BenchSchedule & { engine?: string };

describe("#521 scheduled suite engine", () => {
  test("a suite schedule with engine round-trips through save/load", () => {
    // Kills: dropping `engine` from benchScheduleBase (zod strips it).
    const schedule: BenchSchedule & { engine?: string } = {
      ...suiteSchedule("engine-persist"),
      engine: "gufo",
    };
    saveSchedules([schedule], schedulePath);

    const entry = loadSchedules(schedulePath)[0] as EngineScheduleRow;
    expect(entry.engine).toBe("gufo");
  });

  test("schema rejects engine on kind 'preset' and kindless schedules", () => {
    // Kills: removing the engine branch of the kind/suite superRefine.
    const preset = BenchScheduleSchema.safeParse({
      ...baseSchedule("engine-preset"),
      kind: "preset",
      engine: "gufo",
    });
    expect(preset.success).toBe(false);
    if (!preset.success) {
      expect(preset.error.issues.map((issue) => issue.message).join("; ")).toContain(
        "engine is only valid with kind 'suite'",
      );
    }

    const kindless = BenchScheduleSchema.safeParse({
      ...baseSchedule("engine-kindless"),
      engine: "gufo",
    });
    expect(kindless.success).toBe(false);
    if (!kindless.success) {
      expect(kindless.error.issues.map((issue) => issue.message).join("; ")).toContain(
        "engine is only valid with kind 'suite'",
      );
    }
  });

  test("a legacy suite schedule without engine persists no engine key", () => {
    // Back-compat guard: engine stays absent — never written as null or "".
    saveSchedules([suiteSchedule("engine-legacy")], schedulePath);

    const entry = loadSchedules(schedulePath)[0] as EngineScheduleRow;
    expect("engine" in entry).toBe(false);

    const doc = parseYaml(readFileSync(schedulePath, "utf8")) as Record<string, unknown>;
    const list = Object.values(doc).find((value): value is Record<string, unknown>[] =>
      Array.isArray(value),
    );
    const saved: Record<string, unknown> = list?.[0] ?? {};
    expect("engine" in saved).toBe(false);
  });

  test("schema rejects a malformed engine string", () => {
    // Kills: an unvalidated z.string() for engine — it shares suite's slug regex.
    const result = BenchScheduleSchema.safeParse({
      ...baseSchedule("engine-bad"),
      kind: "suite",
      suite: "perf",
      engine: "Bad Engine!",
    });
    expect(result.success).toBe(false);
  });
});

describe("#521 scheduled suite slots", () => {
  test("a suite schedule with slots round-trips through save/load", () => {
    // Kills: dropping `slots` from benchScheduleBase (zod strips it).
    const schedule: BenchSchedule & { slots?: number } = {
      ...suiteSchedule("slots-persist"),
      slots: 4,
    };
    saveSchedules([schedule], schedulePath);

    const entry = loadSchedules(schedulePath)[0] as BenchSchedule & { slots?: number };
    expect(entry.slots).toBe(4);
  });

  test("schema rejects slots unless kind is 'suite'", () => {
    // Kills: the missing superRefine branch for slots.
    for (const fixture of [
      { ...baseSchedule("slots-preset"), kind: "preset" as const, slots: 4 },
      { ...baseSchedule("slots-kindless"), slots: 4 },
    ]) {
      const result = BenchScheduleSchema.safeParse(fixture);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message).join("; ")).toContain(
          "slots is only valid with kind 'suite'",
        );
      }
    }
  });

  test("schema rejects non-positive or non-integer slots on suite schedules", () => {
    // Kills: dropping .int().positive() from the slots field.
    for (const slots of [0, -1, 1.5]) {
      const result = BenchScheduleSchema.safeParse({
        ...suiteSchedule(`slots-bad-${String(slots)}`),
        slots,
      });
      expect(result.success).toBe(false);
    }
  });

  test("guard: a legacy suite schedule persists no slots key", () => {
    // Back-compat guard: slots stays absent — never written as null or 0.
    saveSchedules([suiteSchedule("slots-legacy")], schedulePath);

    const entry = loadSchedules(schedulePath)[0] as BenchSchedule & { slots?: number };
    expect("slots" in entry).toBe(false);

    expect(readFileSync(schedulePath, "utf8")).not.toContain("slots:");
  });
});

type DeclaredSchedule = BenchSchedule & { quant?: string; ctx?: number };

describe("#521 scheduled suite declared provenance", () => {
  test("a suite schedule with quant and ctx round-trips through save/load", () => {
    // Kills: dropping `quant`/`ctx` from benchScheduleBase (zod strips them).
    const schedule: DeclaredSchedule = {
      ...suiteSchedule("provenance-persist"),
      quant: "Q4_K_M",
      ctx: 32768,
    };
    saveSchedules([schedule], schedulePath);

    const entry = loadSchedules(schedulePath)[0] as DeclaredSchedule;
    expect({ quant: entry.quant, ctx: entry.ctx }).toEqual({
      quant: "Q4_K_M",
      ctx: 32768,
    });
  });

  test("schema rejects quant and ctx on preset or kindless schedules", () => {
    // Kills: dropping the quant/ctx branches of the kind/suite superRefine.
    const gated: { fixture: Record<string, unknown>; message: string }[] = [
      {
        fixture: { ...baseSchedule("prov-quant-preset"), kind: "preset", quant: "Q4_K_M" },
        message: "quant is only valid with kind 'suite'",
      },
      {
        fixture: { ...baseSchedule("prov-quant-kindless"), quant: "Q4_K_M" },
        message: "quant is only valid with kind 'suite'",
      },
      {
        fixture: { ...baseSchedule("prov-ctx-preset"), kind: "preset", ctx: 32768 },
        message: "ctx is only valid with kind 'suite'",
      },
      {
        fixture: { ...baseSchedule("prov-ctx-kindless"), ctx: 32768 },
        message: "ctx is only valid with kind 'suite'",
      },
    ];
    for (const { fixture, message } of gated) {
      const result = BenchScheduleSchema.safeParse(fixture);
      expect(result.success, message).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message)).toContain(message);
      }
    }
  });

  test("schema rejects non-positive ctx and blank or whitespace quant", () => {
    // Kills: missing .int().positive() on ctx or a missing label regex on quant.
    for (const ctx of [0, -1, 1.5]) {
      const result = BenchScheduleSchema.safeParse({
        ...suiteSchedule(`prov-ctx-bad-${String(ctx)}`),
        ctx,
      });
      expect(result.success).toBe(false);
    }
    for (const quant of ["", "Q4 K M"]) {
      const result = BenchScheduleSchema.safeParse({
        ...suiteSchedule(`prov-quant-bad-${quant === "" ? "empty" : "space"}`),
        quant,
      });
      expect(result.success).toBe(false);
    }
  });

  test("guard: a legacy suite schedule persists no quant or ctx key", () => {
    // Back-compat guard: declared provenance stays absent — never null or "".
    saveSchedules([suiteSchedule("provenance-legacy")], schedulePath);

    const entry = loadSchedules(schedulePath)[0] as DeclaredSchedule;
    expect("quant" in entry).toBe(false);
    expect("ctx" in entry).toBe(false);

    const raw = readFileSync(schedulePath, "utf8");
    expect(raw).not.toContain("quant:");
    expect(raw).not.toContain("ctx:");
  });
});
