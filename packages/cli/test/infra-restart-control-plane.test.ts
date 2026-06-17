import { afterEach, beforeEach, expect, test } from "bun:test";

import { runInfra } from "../src/commands/infra.js";

// runInfra has no injection seam for the SubprocessRunner — it calls
// infraServices.restartControlPlane({ dryRun }) with the real runner.
// So we ONLY exercise the safe --dry-run path here: dry-run runs
// `launchctl list` (read-only) and NEVER kickstarts, on any host. The
// non-dry-run logic (kickstart per label, no-abort-on-failure, the
// non-darwin no-op) is covered against the stubbed runner at the
// remote layer in packages/remote/test/restart-control-plane.test.ts.

let writes: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  writes = [];
  process.stdout.write = (chunk: Uint8Array | string): boolean => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

test("restart-control-plane --dry-run never restarts and returns 0", async () => {
  const code = await runInfra(["restart-control-plane", "--dry-run"]);
  expect(code).toBe(0);

  const out = writes.join("");
  // Dry-run must never emit a "restarted <label>" or "FAILED" line —
  // those only appear on the real kickstart path.
  expect(out).not.toContain("restarted ");
  expect(out).not.toContain("FAILED ");

  // On darwin, dry-run prints `would restart <label>` lines (or the
  // "no control-plane services found" line if none are running). On a
  // non-darwin host it prints the skippedReason. Any of these is a
  // success with exit 0 and no actual restart.
  const acceptable =
    out.includes("would restart ") ||
    out.includes("no control-plane services found") ||
    out.includes("darwin-only");
  expect(acceptable).toBe(true);
});
