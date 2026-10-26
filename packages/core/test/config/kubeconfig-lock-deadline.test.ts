import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  lockTiming,
  mutateConfig,
  saveConfig,
  upsertNode,
} from "../../src/config/kubeconfig.js";
import { freshConfig } from "../../src/config/schema.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

/**
 * #270: the kubeconfig lock wait is bounded by a deadline, not by an
 * attempt count. A fake clock that only advances when the retry loop
 * sleeps stands in for a slow CI runner whose sleeps overshoot, so
 * these pins do not depend on real timing or scheduling.
 */

let tmp = "";
let cfgPath = "";
const realTiming = { ...lockTiming };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-kcfg-deadline-"));
  cfgPath = join(tmp, "config");
  saveConfig(freshConfig(), cfgPath);
});
afterEach(() => {
  Object.assign(lockTiming, realTiming);
  rmSync(tmp, { recursive: true, force: true });
});

interface FakeClockRun {
  message: string;
  pid: number;
  sleeps: number[];
}

/**
 * Hold the lock with a live child's pid, then run mutateConfig on a fake
 * clock. `advance(ms)` is how far the clock moves for a requested sleep.
 */
async function runOnFakeClock(advance: (ms: number) => number): Promise<FakeClockRun> {
  const holder = Bun.spawn({
    cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    writeFileSync(`${cfgPath}.lock`, String(holder.pid));
    let t = 1_000_000;
    const sleeps: number[] = [];
    lockTiming.now = (): number => t;
    lockTiming.sleep = (ms: number): void => {
      sleeps.push(ms);
      t += advance(ms);
    };
    let message = "";
    try {
      mutateConfig(cfgPath, (cfg) =>
        upsertNode(cfg, "home", { name: "shouldnotpersist", endpoint: "https://x:9" }),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    return { message, pid: holder.pid, sleeps };
  } finally {
    Object.assign(lockTiming, realTiming);
    holder.kill();
    await holder.exited;
  }
}

describe("acquireConfigLock — deadline-bounded wait (fake clock)", () => {
  test("slow sleeps end the wait at the deadline, not after 40 attempts", async () => {
    // Each 50ms sleep costs 300ms, like an overloaded macOS runner.
    const run = await runOnFakeClock(() => 300);
    expect(run.sleeps).toHaveLength(7);
    expect(run.sleeps.every((ms) => ms === 50)).toBe(true);
    expect(run.message).toBe(
      `kubeconfig lock at ${cfgPath}.lock still held after 2100ms (limit 2000ms) (held by pid=${String(run.pid)})`,
    );
    expect(loadConfig(cfgPath).clusters[0]!.nodes.some((n) => n.name === "shouldnotpersist")).toBe(
      false,
    );
  });

  test("the last sleep is clipped to the time left before the deadline", async () => {
    // Each sleep overshoots by 20ms: after 28 sleeps of 50ms, 40ms are left.
    const run = await runOnFakeClock((ms) => ms + 20);
    expect(run.sleeps).toHaveLength(29);
    expect(run.sleeps.slice(0, -1).every((ms) => ms === 50)).toBe(true);
    expect(run.sleeps.at(-1)).toBe(40);
    expect(run.message).toContain("still held after 2020ms (limit 2000ms)");
  });
});
