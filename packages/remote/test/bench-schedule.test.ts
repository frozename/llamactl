import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addSchedule,
  type BenchSchedule,
  isDue,
  loadSchedules,
  removeSchedule,
  saveSchedules,
  updateSchedule,
} from "../src/bench/schedule.js";
import { router } from "../src/router.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

/**
 * Round-trip + dueness checks for the bench scheduler store. The
 * scheduler loop itself is covered indirectly via the router e2e
 * suite once a schedule fires; this test stays at the unit level.
 */

let tmp = "";
function makeScheduleFile(): string {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-benchsched-"));
  return join(tmp, "schedules.yaml");
}

beforeEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("bench schedule store", () => {
  test("round-trips through YAML save + load", () => {
    const path = makeScheduleFile();
    const entry = {
      id: "s1",
      node: "local",
      rel: "org/repo/model-Q4.gguf",
      mode: "auto" as const,
      intervalSeconds: 86_400,
      enabled: true,
    };
    saveSchedules(addSchedule([], entry), path);
    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("s1");
    expect(loaded[0]!.node).toBe("local");
    expect(loaded[0]!.intervalSeconds).toBe(86_400);
    expect(loaded[0]!.lastRunAt).toBeNull();
  });

  test("duplicate id is rejected", () => {
    const entry = {
      id: "dup",
      node: "local",
      rel: "x/y.gguf",
      mode: "auto" as const,
      intervalSeconds: 3600,
      enabled: true,
    };
    const once = addSchedule([], entry);
    expect(() => addSchedule(once, entry)).toThrow(/already exists/);
  });

  test("removeSchedule + updateSchedule behave as expected", () => {
    const a: BenchSchedule = {
      id: "a",
      node: "local",
      rel: "a/a.gguf",
      mode: "auto",
      intervalSeconds: 3600,
      enabled: true,
      lastRunAt: null,
      lastError: null,
    };
    const b: BenchSchedule = { ...a, id: "b", rel: "b/b.gguf" };
    const seeded = [a, b];
    expect(removeSchedule(seeded, "a")).toHaveLength(1);
    expect(updateSchedule(seeded, "a", { enabled: false })[0]!.enabled).toBe(false);
    // `id` cannot be mutated through updateSchedule.
    expect(updateSchedule(seeded, "a", { id: "nope" })[0]!.id).toBe("a");
  });

  test("isDue returns true for fresh schedules and elapsed intervals", () => {
    const now = 2_000_000_000_000;
    const fresh: BenchSchedule = {
      id: "f",
      node: "local",
      rel: "f/f.gguf",
      mode: "auto",
      intervalSeconds: 60,
      enabled: true,
      lastRunAt: null,
      lastError: null,
    };
    expect(isDue(fresh, now)).toBe(true);

    const recent = { ...fresh, lastRunAt: new Date(now - 30 * 1000).toISOString() };
    expect(isDue(recent, now)).toBe(false);

    const elapsed = { ...fresh, lastRunAt: new Date(now - 120 * 1000).toISOString() };
    expect(isDue(elapsed, now)).toBe(true);

    const disabled = { ...fresh, enabled: false };
    expect(isDue(disabled, now)).toBe(false);
  });

  test("a suite schedule round-trips through YAML with kind and suite", () => {
    const path = makeScheduleFile();
    const entry = {
      id: "suite-s1",
      node: "local",
      rel: "org/repo/model-Q4.gguf",
      mode: "auto" as const,
      intervalSeconds: 86_400,
      enabled: true,
      kind: "suite" as const,
      suite: "my-perf-suite",
    };
    saveSchedules(addSchedule([], entry), path);
    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("suite-s1");
    expect(loaded[0]!.kind).toBe("suite");
    expect(loaded[0]!.suite).toBe("my-perf-suite");
  });

  test("kind 'suite' without suite id is rejected", () => {
    const entry = {
      id: "suite-bad",
      node: "local",
      rel: "x/y.gguf",
      mode: "auto" as const,
      intervalSeconds: 3600,
      enabled: true,
      kind: "suite" as const,
    } as BenchSchedule;
    expect(() => addSchedule([], entry)).toThrow(/suite id is required/);
  });

  test("kind 'preset' with a suite id is rejected", () => {
    const entry: BenchSchedule = {
      id: "preset-bad",
      node: "local",
      rel: "x/y.gguf",
      mode: "auto",
      intervalSeconds: 3600,
      enabled: true,
      kind: "preset" as const,
      suite: "some-suite",
      lastRunAt: null,
      lastError: null,
    };
    expect(() => addSchedule([], entry)).toThrow(/suite is only valid/);
  });

  test("benchScheduleAdd accepts kind and suite", async () => {
    const path = makeScheduleFile();
    const previous = process.env["LLAMACTL_BENCH_SCHEDULES"];
    process.env["LLAMACTL_BENCH_SCHEDULES"] = path;
    try {
      const caller = router.createCaller({});
      const result = await caller.benchScheduleAdd({
        id: "router-suite",
        node: "local",
        rel: "org/repo/model.gguf",
        intervalSeconds: 3600,
        kind: "suite",
        suite: "perf-regression",
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("router-suite");
      expect(result[0]!.kind).toBe("suite");
      expect(result[0]!.suite).toBe("perf-regression");
    } finally {
      if (previous === undefined) delete process.env["LLAMACTL_BENCH_SCHEDULES"];
      else process.env["LLAMACTL_BENCH_SCHEDULES"] = previous;
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("benchScheduleAdd rejects kind 'suite' without suite id", async () => {
    const path = makeScheduleFile();
    const previous = process.env["LLAMACTL_BENCH_SCHEDULES"];
    process.env["LLAMACTL_BENCH_SCHEDULES"] = path;
    try {
      const caller = router.createCaller({});
      try {
        await caller.benchScheduleAdd({
          id: "suite-no-id",
          node: "local",
          rel: "x/y.gguf",
          intervalSeconds: 3600,
          kind: "suite",
        });
        expect.unreachable("should have rejected");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("suite id is required");
      }
    } finally {
      if (previous === undefined) delete process.env["LLAMACTL_BENCH_SCHEDULES"];
      else process.env["LLAMACTL_BENCH_SCHEDULES"] = previous;
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });
});
