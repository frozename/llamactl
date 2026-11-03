import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BenchSchedule, loadSchedules, saveSchedules } from "../src/bench/schedule.js";
import {
  type BenchClient,
  type BenchLoopStatus,
  benchSchedulerStatus,
  kickBenchScheduler,
  startBenchScheduler,
  stopBenchScheduler,
} from "../src/bench/scheduleLoop.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

/**
 * Loop-level coverage for the in-process bench scheduler: dueness
 * gating, failure recording, the inflight guard and status. Fake
 * clients settle synchronously, so no sleeps and no timers are
 * awaited anywhere.
 */

type ScriptStep = {
  events?: unknown[];
  error?: unknown;
  complete?: boolean;
};

let tmp = "";
let previousEnv: string | undefined;
let schedulePath = "";
let getClientCalls = 0;

function scheduleFor(id: string, overrides: Partial<BenchSchedule> = {}): BenchSchedule {
  return {
    id,
    node: "fake-node",
    rel: `org/repo/${id}.gguf`,
    mode: "auto",
    intervalSeconds: 86_400,
    enabled: true,
    lastRunAt: "2000-01-01T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function dueSchedule(id: string, overrides: Partial<BenchSchedule> = {}): BenchSchedule {
  return scheduleFor(id, overrides);
}

function notDueSchedule(id: string, overrides: Partial<BenchSchedule> = {}): BenchSchedule {
  return scheduleFor(id, { lastRunAt: new Date().toISOString(), ...overrides });
}

type FakeClient = {
  getClient: (nodeName: string) => BenchClient;
  subscribeInputs: { target: string; mode?: "auto" | "text" | "vision" }[];
  held: { onComplete: () => void }[];
};

function fakeClient(script: Map<string, ScriptStep>): FakeClient {
  const subscribeInputs: { target: string; mode?: "auto" | "text" | "vision" }[] = [];
  const held: { onComplete: () => void }[] = [];
  let subscribeCalls = 0;
  const getClient = (_node: string): BenchClient => {
    getClientCalls++;
    return {
      benchPresetRun: {
        subscribe(input, callbacks): { unsubscribe?: () => void } {
          subscribeInputs.push(input);
          subscribeCalls++;
          const step = script.get(input.target);
          if (!step) {
            callbacks.onComplete();
            return {};
          }
          for (const event of step.events ?? []) callbacks.onData(event);
          if (step.error !== undefined) {
            callbacks.onError(step.error);
          } else if (step.complete === false && subscribeCalls === 1) {
            held.push({ onComplete: callbacks.onComplete });
          } else {
            callbacks.onComplete();
          }
          return {};
        },
      },
    };
  };
  return { getClient, subscribeInputs, held };
}

function autoCompleting(): FakeClient {
  return fakeClient(new Map());
}

function recentFor(id: string): BenchLoopStatus["recent"][number] | undefined {
  return benchSchedulerStatus().recent.find((entry) => entry.id === id);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-benchloop-"));
  schedulePath = join(tmp, "schedules.yaml");
  previousEnv = process.env["LLAMACTL_BENCH_SCHEDULES"];
  process.env["LLAMACTL_BENCH_SCHEDULES"] = schedulePath;
  getClientCalls = 0;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env["LLAMACTL_BENCH_SCHEDULES"];
  else process.env["LLAMACTL_BENCH_SCHEDULES"] = previousEnv;
  stopBenchScheduler();
  rmSync(tmp, { recursive: true, force: true });
});

describe("bench scheduler loop", () => {
  test("clean completion stamps lastRunAt and clears lastError", async () => {
    saveSchedules([dueSchedule("clean-1", { lastError: "previous failure" })], schedulePath);
    await kickBenchScheduler(autoCompleting().getClient);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "clean-1")!;
    expect(entry.lastRunAt).not.toBeNull();
    expect(entry.lastRunAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(Number.isNaN(Date.parse(entry.lastRunAt!))).toBe(false);
    expect(entry.lastError).toBeNull();

    const recent = recentFor("clean-1");
    expect(recent?.ok).toBe(true);
    expect(recent?.id).toBe("clean-1");
    expect(recent?.rel).toBe("org/repo/clean-1.gguf");
    expect(recent?.node).toBe("fake-node");
  });

  test("subscribe receives exactly target and mode", async () => {
    saveSchedules([dueSchedule("input-2", { mode: "vision" })], schedulePath);
    const { getClient, subscribeInputs } = autoCompleting();
    await kickBenchScheduler(getClient);

    expect(subscribeInputs).toEqual([{ target: "org/repo/input-2.gguf", mode: "vision" }]);
  });

  test("disabled schedules are never fetched and never stamped", async () => {
    saveSchedules([dueSchedule("dis-3", { enabled: false })], schedulePath);
    const { getClient } = autoCompleting();
    await kickBenchScheduler(getClient);

    expect(getClientCalls).toBe(0);
    const entry = loadSchedules(schedulePath).find((s) => s.id === "dis-3")!;
    expect(entry.lastRunAt).toBe("2000-01-01T00:00:00.000Z");
  });

  test("not-due schedules are never fetched", async () => {
    saveSchedules([notDueSchedule("fresh-4")], schedulePath);
    await kickBenchScheduler(autoCompleting().getClient);
    expect(getClientCalls).toBe(0);
  });

  test("done-preset with result.error records a failed run", async () => {
    saveSchedules([dueSchedule("err-5")], schedulePath);
    const { getClient } = fakeClient(
      new Map([
        [
          "org/repo/err-5.gguf",
          {
            events: [{ type: "done-preset", result: { error: "boom" } }],
            complete: true,
          },
        ],
      ]),
    );
    await kickBenchScheduler(getClient);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "err-5")!;
    expect(entry.lastError).toBe("boom");
    const recent = recentFor("err-5");
    expect(recent?.ok).toBe(false);
    expect(recent?.message).toBe("boom");
  });

  test("clean done-preset followed by onComplete is a success", async () => {
    saveSchedules([dueSchedule("ok-6")], schedulePath);
    const { getClient } = fakeClient(
      new Map([["org/repo/ok-6.gguf", { events: [{ type: "done-preset", result: {} }] }]]),
    );
    await kickBenchScheduler(getClient);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "ok-6")!;
    expect(entry.lastError).toBeNull();
    expect(recentFor("ok-6")?.ok).toBe(true);
  });

  test("onError with an Error records its message", async () => {
    saveSchedules([dueSchedule("onerr-7")], schedulePath);
    const { getClient } = fakeClient(
      new Map([["org/repo/onerr-7.gguf", { error: new Error("x") }]]),
    );
    await kickBenchScheduler(getClient);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "onerr-7")!;
    expect(entry.lastError).toBe("x");
  });

  test("onError with a non-Error records String(err)", async () => {
    saveSchedules([dueSchedule("onerr-8")], schedulePath);
    const { getClient } = fakeClient(new Map([["org/repo/onerr-8.gguf", { error: "plain" }]]));
    await kickBenchScheduler(getClient);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "onerr-8")!;
    expect(entry.lastError).toBe("plain");
  });

  test("a throwing getClient fails only that schedule; the loop continues", async () => {
    saveSchedules([dueSchedule("a-9", { node: "thrower" }), dueSchedule("b-9")], schedulePath);
    const { getClient } = autoCompleting();
    const throwingGetClient = (node: string): BenchClient => {
      getClientCalls++;
      if (node === "thrower") throw new Error("client exploded");
      return getClient(node);
    };
    await kickBenchScheduler(throwingGetClient);

    const failed = loadSchedules(schedulePath).find((s) => s.id === "a-9")!;
    expect(failed.lastError).toBe("client exploded");
    expect(recentFor("a-9")?.ok).toBe(false);

    const succeeded = loadSchedules(schedulePath).find((s) => s.id === "b-9")!;
    expect(succeeded.lastError).toBeNull();
    expect(succeeded.lastRunAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(recentFor("b-9")?.ok).toBe(true);
  });

  test("only due schedules get their file entry updated", async () => {
    const kept = notDueSchedule("keep-10", {
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    saveSchedules([dueSchedule("due-10"), kept], schedulePath);
    await kickBenchScheduler(autoCompleting().getClient);

    const entries = loadSchedules(schedulePath);
    const due = entries.find((s) => s.id === "due-10")!;
    const unchanged = entries.find((s) => s.id === "keep-10")!;
    expect(getClientCalls).toBe(1);
    expect(due.lastRunAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(unchanged.lastRunAt).toBe(kept.lastRunAt);
    expect(unchanged.lastError).toBeNull();
  });

  test("inflight guard skips concurrent ticks", async () => {
    saveSchedules([dueSchedule("hold-11")], schedulePath);
    const { getClient, held } = fakeClient(
      new Map([["org/repo/hold-11.gguf", { complete: false }]]),
    );

    const first = kickBenchScheduler(getClient);
    try {
      expect(benchSchedulerStatus().inflight).toBe(true);
      await kickBenchScheduler(getClient);
      expect(getClientCalls).toBe(1);
    } finally {
      held[0]!.onComplete();
      await first;
    }
    expect(benchSchedulerStatus().inflight).toBe(false);
  });

  test("status after a kick without start", async () => {
    saveSchedules([dueSchedule("st-12")], schedulePath);
    await kickBenchScheduler(autoCompleting().getClient);

    const status = benchSchedulerStatus();
    expect(status.running).toBe(false);
    expect(status.nextTickAt).toBeNull();
    expect(status.inflight).toBe(false);
    expect(status.lastTickAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(status.lastTickAt!))).toBe(false);
  });

  test("start and stop with an empty schedule file", () => {
    const { getClient } = autoCompleting();
    startBenchScheduler({ getClient, tickIntervalMs: 3_600_000 });

    let status = benchSchedulerStatus();
    expect(status.running).toBe(true);
    expect(status.tickIntervalMs).toBe(3_600_000);
    expect(status.nextTickAt).toBe(
      new Date(Date.parse(status.lastTickAt!) + 3_600_000).toISOString(),
    );

    startBenchScheduler({ getClient, tickIntervalMs: 5_000 });
    status = benchSchedulerStatus();
    expect(status.tickIntervalMs).toBe(3_600_000);

    stopBenchScheduler();
    status = benchSchedulerStatus();
    expect(status.running).toBe(false);
    expect(status.nextTickAt).toBeNull();
  });

  test("recent log is capped at 200 entries", async () => {
    const many = Array.from({ length: 201 }, (_, i) => dueSchedule(`cap-${String(i)}`));
    saveSchedules(many, schedulePath);
    await kickBenchScheduler(autoCompleting().getClient);

    const { recent } = benchSchedulerStatus();
    expect(recent).toHaveLength(200);
    expect(recent[recent.length - 1]!.id).toBe("cap-200");
    expect(recent.some((entry) => entry.id === "cap-0")).toBe(false);
  }, 30_000);
});
