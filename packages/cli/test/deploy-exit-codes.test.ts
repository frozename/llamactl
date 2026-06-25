import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runDeployNode } from "../src/commands/deploy.js";

/**
 * `llamactl deploy-node` exit-code contract:
 *
 *   - No args (missing required <name>) MUST exit non-zero — scripts
 *     that pipe a bootstrap token out of this command rely on the
 *     exit code to decide whether to proceed with the install. Today
 *     the no-arg path prints USAGE and returns 0, which fools CI.
 *   - `--help` / `-h` MUST exit 0 — that's the user explicitly asking
 *     for the usage banner.
 */

function captureStreams<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve existing CLI/test semantics while clearing strict lint debt.
  const origOut = process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve existing CLI/test semantics while clearing strict lint debt.
  const origErr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = (chunk: unknown): true => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  process.stderr.write = (chunk: unknown): true => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    });
}

const originalEnv = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

describe("deploy-node — exit codes", () => {
  test("no arguments → exit non-zero (missing required <name>)", async () => {
    const { result, stderr } = await captureStreams(() => runDeployNode([]));
    expect(result).not.toBe(0);
    // The error must be reported on stderr so CI can grep it.
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("--help → exit 0 with USAGE on stdout", async () => {
    const { result, stdout } = await captureStreams(() => runDeployNode(["--help"]));
    expect(result).toBe(0);
    expect(stdout).toContain("llamactl deploy-node");
  });

  test("-h → exit 0 with USAGE on stdout", async () => {
    const { result, stdout } = await captureStreams(() => runDeployNode(["-h"]));
    expect(result).toBe(0);
    expect(stdout).toContain("llamactl deploy-node");
  });
});
