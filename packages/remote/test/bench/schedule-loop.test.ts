import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addSchedule,
  benchRunLockPath,
  type BenchSchedule,
  loadSchedules,
  removeSchedule,
  saveSchedules,
  updateSchedule,
} from "../../src/bench/schedule.js";
import {
  type BenchClient,
  type BenchLoopStatus,
  benchSchedulerStatus,
  kickBenchScheduler,
  startBenchScheduler,
  stopBenchScheduler,
} from "../../src/bench/scheduleLoop.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

/**
 * Loop-level coverage for the in-process bench scheduler: dueness
 * gating, failure recording, the inflight guard, status, the
 * cross-process run lock and the reload-before-stamp write path.
 * Fake clients settle synchronously or on a manual `held` release;
 * the only sleeps anywhere are bounded polls for a held release.
 */

async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

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

  test("a removal from another process during a running bench is not reverted", async () => {
    saveSchedules([dueSchedule("race-13"), notDueSchedule("keep-13")], schedulePath);
    const { getClient, held } = fakeClient(
      new Map([["org/repo/race-13.gguf", { complete: false }]]),
    );

    const first = kickBenchScheduler(getClient);
    expect(benchSchedulerStatus().inflight).toBe(true);
    // Concurrent `bench schedule rm race-13` from another process.
    saveSchedules(removeSchedule(loadSchedules(schedulePath), "race-13"), schedulePath);
    held[0]!.onComplete();
    await first;

    expect(loadSchedules(schedulePath).map((s) => s.id)).toEqual(["keep-13"]);
  });

  test("concurrent adds and disables survive a bench; the disabled id is not stamped", async () => {
    saveSchedules([dueSchedule("race-14")], schedulePath);
    const { getClient, held } = fakeClient(
      new Map([["org/repo/race-14.gguf", { complete: false }]]),
    );

    const first = kickBenchScheduler(getClient);
    saveSchedules(
      updateSchedule(
        addSchedule(loadSchedules(schedulePath), {
          id: "added-14",
          node: "fake-node",
          rel: "org/repo/added-14.gguf",
          mode: "auto",
          intervalSeconds: 3_600,
          enabled: true,
        }),
        "race-14",
        { enabled: false },
      ),
      schedulePath,
    );
    held[0]!.onComplete();
    await first;

    const rows = loadSchedules(schedulePath);
    expect(rows.map((s) => s.id).sort()).toEqual(["added-14", "race-14"]);
    expect(rows.find((s) => s.id === "race-14")!.lastRunAt).toBe("2000-01-01T00:00:00.000Z");
  });

  test("kick is refused while another live process holds the run lock", async () => {
    writeFileSync(
      benchRunLockPath(),
      JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    saveSchedules([dueSchedule("lock-15")], schedulePath);

    try {
      await kickBenchScheduler(autoCompleting().getClient);
      expect.unreachable("kick should have been refused while pid 1 holds the lock");
    } catch (err) {
      expect((err as Error).message).toContain(
        "a bench scheduler run already holds the run lock (pid 1,",
      );
    }
    expect(getClientCalls).toBe(0);
    const entry = loadSchedules(schedulePath).find((s) => s.id === "lock-15")!;
    expect(entry.lastRunAt).toBe("2000-01-01T00:00:00.000Z");
  });

  test("a stale lock from a dead pid is reclaimed by the next kick", async () => {
    const child = Bun.spawn(["sleep", "0"]);
    await child.exited;
    writeFileSync(
      benchRunLockPath(),
      JSON.stringify({ pid: child.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    saveSchedules([dueSchedule("lock-16")], schedulePath);

    await kickBenchScheduler(autoCompleting().getClient);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "lock-16")!;
    expect(entry.lastRunAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(existsSync(benchRunLockPath())).toBe(false);
  }, 10_000);

  test("a lockfile naming this pid is reclaimed as stale", async () => {
    writeFileSync(
      benchRunLockPath(),
      JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    saveSchedules([dueSchedule("lock-20")], schedulePath);

    await kickBenchScheduler(autoCompleting().getClient);

    const entry = loadSchedules(schedulePath).find((s) => s.id === "lock-20")!;
    expect(entry.lastRunAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(Number.isNaN(Date.parse(entry.lastRunAt!))).toBe(false);
    expect(existsSync(benchRunLockPath())).toBe(false);
  });

  test("release leaves a lockfile that now names a foreign pid", async () => {
    saveSchedules([dueSchedule("lock-21")], schedulePath);
    const { getClient, held } = fakeClient(
      new Map([["org/repo/lock-21.gguf", { complete: false }]]),
    );

    const kick = kickBenchScheduler(getClient);
    expect(benchSchedulerStatus().inflight).toBe(true);
    expect(held).toHaveLength(1);

    // Another process replaced the lockfile while this bench ran.
    writeFileSync(
      benchRunLockPath(),
      JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    held[0]!.onComplete();
    await kick;

    const holder = JSON.parse(readFileSync(benchRunLockPath(), "utf8")) as { pid: number };
    expect(holder.pid).toBe(1);
  });

  test("stop after the first due schedule fires no further benches in the tick", async () => {
    saveSchedules(
      [dueSchedule("stop-17a"), dueSchedule("stop-17b"), dueSchedule("stop-17c")],
      schedulePath,
    );
    const { getClient, held, subscribeInputs } = fakeClient(
      new Map([["org/repo/stop-17a.gguf", { complete: false }]]),
    );

    startBenchScheduler({ getClient, tickIntervalMs: 3_600_000 });
    expect(held).toHaveLength(1);
    stopBenchScheduler();
    // The draining bench still holds the lock, so other processes stay out
    // until it exits.
    expect(existsSync(benchRunLockPath())).toBe(true);
    held[0]!.onComplete();
    await waitUntil(() => !benchSchedulerStatus().inflight);
    expect(existsSync(benchRunLockPath())).toBe(false);

    expect(subscribeInputs.map((input) => input.target)).toEqual(["org/repo/stop-17a.gguf"]);
    const rows = loadSchedules(schedulePath);
    expect(rows.find((s) => s.id === "stop-17a")!.lastRunAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(rows.find((s) => s.id === "stop-17b")!.lastRunAt).toBe("2000-01-01T00:00:00.000Z");
    expect(rows.find((s) => s.id === "stop-17c")!.lastRunAt).toBe("2000-01-01T00:00:00.000Z");
    expect(existsSync(benchRunLockPath())).toBe(false);
  }, 10_000);

  test("a kick bench that outlives stop still releases the run lock", async () => {
    const { getClient, held } = fakeClient(
      new Map([["org/repo/drain-18.gguf", { complete: false }]]),
    );

    startBenchScheduler({ getClient, tickIntervalMs: 3_600_000 });
    // The loop's opening tick finds an empty store and finishes, leaving
    // the loop running with the lock held and nothing in flight.
    saveSchedules([dueSchedule("drain-18")], schedulePath);
    const kick = kickBenchScheduler(getClient);
    expect(benchSchedulerStatus().inflight).toBe(true);
    expect(held).toHaveLength(1);

    stopBenchScheduler();
    held[0]!.onComplete();
    await kick;

    expect(benchSchedulerStatus().running).toBe(false);
    expect(benchSchedulerStatus().inflight).toBe(false);
    // A fresh process only consults the lockfile; it must be gone.
    expect(existsSync(benchRunLockPath())).toBe(false);

    saveSchedules([dueSchedule("after-18")], schedulePath);
    await kickBenchScheduler(autoCompleting().getClient);
    const entry = loadSchedules(schedulePath).find((s) => s.id === "after-18")!;
    expect(entry.lastRunAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(existsSync(benchRunLockPath())).toBe(false);
  }, 10_000);

  test("a kick in flight when the loop starts keeps the run lock held", async () => {
    saveSchedules([dueSchedule("overlap-19")], schedulePath);
    const { getClient, held } = fakeClient(
      new Map([["org/repo/overlap-19.gguf", { complete: false }]]),
    );

    const kick = kickBenchScheduler(getClient);
    expect(benchSchedulerStatus().inflight).toBe(true);
    expect(held).toHaveLength(1);

    // start adopts the kick's lock and skips the in-flight tick; when the
    // kick drains, the still-running loop must keep the lockfile.
    startBenchScheduler({ getClient, tickIntervalMs: 3_600_000 });
    held[0]!.onComplete();
    await kick;

    try {
      expect(benchSchedulerStatus().running).toBe(true);
      expect(benchSchedulerStatus().inflight).toBe(false);
      expect(existsSync(benchRunLockPath())).toBe(true);
      const holder = JSON.parse(readFileSync(benchRunLockPath(), "utf8")) as { pid: number };
      expect(holder.pid).toBe(process.pid);
    } finally {
      stopBenchScheduler();
    }
    expect(existsSync(benchRunLockPath())).toBe(false);
  }, 10_000);

  test("start is refused by a live foreign lock and writes its own pid", () => {
    writeFileSync(
      benchRunLockPath(),
      JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const { getClient } = autoCompleting();

    expect(() => {
      startBenchScheduler({ getClient, tickIntervalMs: 3_600_000 });
    }).toThrow(/already holds the run lock/);
    expect(benchSchedulerStatus().running).toBe(false);
    expect(getClientCalls).toBe(0);

    rmSync(benchRunLockPath(), { force: true });
    startBenchScheduler({ getClient, tickIntervalMs: 3_600_000 });
    try {
      const holder = JSON.parse(readFileSync(benchRunLockPath(), "utf8")) as { pid: number };
      expect(holder.pid).toBe(process.pid);
      expect(benchSchedulerStatus().running).toBe(true);
    } finally {
      stopBenchScheduler();
    }
    expect(existsSync(benchRunLockPath())).toBe(false);
  });

  test("schedules removed or disabled mid-tick never fire their own bench", async () => {
    saveSchedules(
      [dueSchedule("stale-a"), dueSchedule("stale-b"), dueSchedule("stale-c")],
      schedulePath,
    );
    const { getClient, held, subscribeInputs } = fakeClient(
      new Map([["org/repo/stale-a.gguf", { complete: false }]]),
    );

    const kick = kickBenchScheduler(getClient);
    expect(held).toHaveLength(1);
    // Another process removes stale-b and disables stale-c while stale-a runs.
    saveSchedules(
      updateSchedule(removeSchedule(loadSchedules(schedulePath), "stale-b"), "stale-c", {
        enabled: false,
      }),
      schedulePath,
    );
    held[0]!.onComplete();
    await kick;

    expect(subscribeInputs.map((input) => input.target)).toEqual(["org/repo/stale-a.gguf"]);
    expect(getClientCalls).toBe(1);
    const rows = loadSchedules(schedulePath);
    expect(rows.map((s) => s.id).sort()).toEqual(["stale-a", "stale-c"]);
    expect(rows.find((s) => s.id === "stale-c")!.lastRunAt).toBe("2000-01-01T00:00:00.000Z");
  });
});
