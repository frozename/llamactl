// The default effects behind `llamactl update` that guard the install: a
// command run in its own process group is killed whole on timeout or abort,
// and the heavy-job lock is held by a child that lets go on release. These run
// real short-lived processes (sh, sleep, flock) on a temp lock file only.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultUpdateDeps, EXIT_ABORTED, EXIT_TIMED_OUT } from "../src/commands/update/deps.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const deps = defaultUpdateDeps();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    if (!alive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

// `sh` prints the pid of a background child, then waits: the child is what a
// killed parent would leave behind (like flock leaving its command running).
const LEAKY = ["sh", "-c", "sleep 30 & echo $!; wait"];

describe("exec in a process group", () => {
  test("a timeout kills the command and everything it started", async () => {
    const r = await deps.exec(LEAKY, { timeoutMs: 300, processGroup: true });
    expect(r.code).toBe(EXIT_TIMED_OUT);
    expect(r.stderr).toContain("timed out; killed");
    const child = Number.parseInt(r.stdout.trim(), 10);
    expect(child).toBeGreaterThan(1);
    expect(await gone(child)).toBe(true);
  });

  test("an abort kills the whole group too", async () => {
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 200);
    const r = await deps.exec(LEAKY, { processGroup: true, signal: ac.signal });
    expect(r.code).toBe(EXIT_ABORTED);
    expect(await gone(Number.parseInt(r.stdout.trim(), 10))).toBe(true);
  });

  test("a command that finishes keeps its exit code and output", async () => {
    const r = await deps.exec(["sh", "-c", "echo out; echo err >&2; exit 3"], {
      timeoutMs: 5000,
      processGroup: true,
    });
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });
});

describe("sleep", () => {
  test("an abort cuts it short", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => {
      ac.abort();
    }, 50);
    await deps.sleep(10_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe.skipIf(Bun.which("flock") === null)("heavy-job lock (flock)", () => {
  test("held until released; a second taker times out, then gets it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-update-lock-"));
    const path = join(dir, "sub", ".heavy.lock");
    try {
      const first = await deps.acquireLock(path, 5);
      expect(first).not.toBeNull();
      const t0 = Date.now();
      expect(await deps.acquireLock(path, 1)).toBeNull();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
      first?.release();
      first?.release();
      const second = await deps.acquireLock(path, 5);
      expect(second).not.toBeNull();
      second?.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an abort ends the wait without the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-update-lock-"));
    const path = join(dir, ".heavy.lock");
    try {
      const holder = await deps.acquireLock(path, 5);
      const ac = new AbortController();
      setTimeout(() => {
        ac.abort();
      }, 200);
      const t0 = Date.now();
      expect(await deps.acquireLock(path, 30, ac.signal)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(5000);
      holder?.release();
      const again = await deps.acquireLock(path, 5);
      expect(again).not.toBeNull();
      again?.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
