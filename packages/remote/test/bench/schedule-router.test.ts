import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BenchSchedule, loadSchedules, saveSchedules } from "../../src/bench/schedule.js";
import {
  type BenchSuiteRequest,
  type BenchSuiteRunner,
  stopBenchScheduler,
} from "../../src/bench/scheduleLoop.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

/**
 * RED pins for #521 (F-3 follow-up): the bench scheduler router
 * procedures must forward `ctx.benchSuiteRunner` into the loop's
 * `runSuite` seam so kind:"suite" schedules dispatch instead of
 * recording "no suite runner configured". At base the procedures
 * ignore the context entirely, so every dispatch assertion fails.
 */

type RouterContext = Parameters<typeof router.createCaller>[0];

const SUITE_SCHEDULE: BenchSchedule = {
  id: "router-suite",
  node: "fake-node",
  rel: "org/repo/m.gguf",
  mode: "auto",
  intervalSeconds: 86_400,
  enabled: true,
  lastRunAt: "2000-01-01T00:00:00.000Z",
  lastError: null,
  kind: "suite",
  suite: "perf-quick",
};

const EXPECTED_REQUEST: BenchSuiteRequest = {
  scheduleId: "router-suite",
  suite: "perf-quick",
  node: "fake-node",
  rel: "org/repo/m.gguf",
};

function suiteRunnerFake(): { runner: BenchSuiteRunner; calls: BenchSuiteRequest[] } {
  const calls: BenchSuiteRequest[] = [];
  const runner: BenchSuiteRunner = (req) => {
    calls.push(req);
    return Promise.resolve();
  };
  return { runner, calls };
}

function suiteEntry(): BenchSchedule | undefined {
  return loadSchedules().find((s) => s.id === "router-suite");
}

let tmp = "";
let schedulePath = "";
let previousSchedulesEnv: string | undefined;
let previousConfigEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-bench-router-"));
  schedulePath = join(tmp, "schedules.yaml");
  previousSchedulesEnv = process.env["LLAMACTL_BENCH_SCHEDULES"];
  previousConfigEnv = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_BENCH_SCHEDULES"] = schedulePath;
  // Nonexistent path: loadConfig falls back to freshConfig.
  process.env["LLAMACTL_CONFIG"] = join(tmp, "config");
  saveSchedules([SUITE_SCHEDULE], schedulePath);
});

afterEach(() => {
  stopBenchScheduler();
  if (previousSchedulesEnv === undefined) delete process.env["LLAMACTL_BENCH_SCHEDULES"];
  else process.env["LLAMACTL_BENCH_SCHEDULES"] = previousSchedulesEnv;
  if (previousConfigEnv === undefined) delete process.env["LLAMACTL_CONFIG"];
  else process.env["LLAMACTL_CONFIG"] = previousConfigEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("bench scheduler router suite dispatch", () => {
  test("benchSchedulerKick forwards ctx.benchSuiteRunner to the loop", async () => {
    const { runner, calls } = suiteRunnerFake();
    const ctx = { benchSuiteRunner: runner } as RouterContext;

    await router.createCaller(ctx).benchSchedulerKick();

    expect(calls).toEqual([EXPECTED_REQUEST]);
    expect(suiteEntry()?.lastError).toBeNull();
  });

  test("benchSchedulerStart forwards ctx.benchSuiteRunner to timer ticks", async () => {
    const { runner, calls } = suiteRunnerFake();
    const ctx = { benchSuiteRunner: runner } as RouterContext;
    const caller = router.createCaller(ctx);

    await caller.benchSchedulerStart({ tickIntervalSeconds: 3600 });
    try {
      const deadline = Date.now() + 2_000;
      while (calls.length === 0 && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(calls).toEqual([EXPECTED_REQUEST]);
      expect(suiteEntry()?.lastError).toBeNull();
    } finally {
      await caller.benchSchedulerStop();
      const drainDeadline = Date.now() + 2_000;
      while ((await caller.benchSchedulerStatus()).inflight && Date.now() < drainDeadline) {
        await Bun.sleep(5);
      }
    }
    expect((await caller.benchSchedulerStatus()).inflight).toBe(false);
  });

  test("guard: kick without a suite runner still records the no-runner error", async () => {
    await router.createCaller({}).benchSchedulerKick();

    expect(suiteEntry()?.lastError).toBe("no suite runner configured for suite 'perf-quick'");
  });
});
