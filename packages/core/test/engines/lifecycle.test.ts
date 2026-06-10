import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gracefulShutdown } from "../../src/engines/lifecycle.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

// Spawn `bash` that backgrounds a long-lived grandchild (models an oMLX worker
// subprocess) and waits so the parent stays alive. detached:true makes the
// parent its own process-group leader; detached:false leaves it in THIS test
// runner's group.
async function spawnParentWithGrandchild(detached: boolean, gpidFile: string) {
  const proc = spawn("bash", ["-c", `sleep 600 & echo $! > "${gpidFile}"; wait`], {
    stdio: "ignore",
    detached,
  });
  const ok = await waitUntil(
    () => existsSync(gpidFile) && readFileSync(gpidFile, "utf8").trim() !== "",
    5000,
  );
  if (!ok) throw new Error("grandchild pid file was not written");
  const grandchildPid = Number.parseInt(readFileSync(gpidFile, "utf8").trim(), 10);
  return { proc, grandchildPid };
}

describe("gracefulShutdown process-group reaping", () => {
  test("group-leader (detached) proc: signalling reaps the forked grandchild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-gshut-grp-"));
    const gpidFile = join(dir, "gc.pid");
    const { proc, grandchildPid } = await spawnParentWithGrandchild(true, gpidFile);
    try {
      expect(isAlive(grandchildPid)).toBe(true);
      await gracefulShutdown(proc.pid!, 3000);
      // proc is its own group leader → the whole group is signalled, so the
      // forked grandchild is reaped too (not orphaned).
      expect(await waitUntil(() => !isAlive(grandchildPid), 4000)).toBe(true);
      expect(isAlive(proc.pid!)).toBe(false);
    } finally {
      if (proc.pid) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {}
      }
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-leader proc (shares another group): only the direct child is signalled", async () => {
    // A non-detached child shares THIS test runner's process group. The pgid
    // gate must fall back to a direct kill — a group-wide signal here would take
    // down the runner. Proof of safety: the sibling grandchild (also in the
    // runner's group) survives, and this test keeps executing.
    const dir = mkdtempSync(join(tmpdir(), "llamactl-gshut-direct-"));
    const gpidFile = join(dir, "gc.pid");
    const { proc, grandchildPid } = await spawnParentWithGrandchild(false, gpidFile);
    try {
      expect(isAlive(grandchildPid)).toBe(true);
      await gracefulShutdown(proc.pid!, 3000);
      // The direct child is killed...
      expect(await waitUntil(() => !isAlive(proc.pid!), 4000)).toBe(true);
      // ...but the sibling grandchild (same group as the runner) is untouched.
      expect(isAlive(grandchildPid)).toBe(true);
    } finally {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {}
      if (proc.pid) {
        try {
          process.kill(proc.pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
