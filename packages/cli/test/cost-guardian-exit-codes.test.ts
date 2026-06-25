import { describe, expect, test } from "bun:test";

import { runCostGuardian } from "../src/commands/cost-guardian.js";

/**
 * `llamactl cost-guardian` exit-code contract:
 *
 *   - `tick` with an unknown / typo'd flag MUST exit non-zero so CI
 *     catches the misconfiguration instead of assuming the tick ran.
 *   - `--help` / `-h` (top-level OR on `tick`) MUST exit 0.
 *
 * The unknown-flag path returns before booting the in-proc MCP client
 * or touching the journal, so the tests run without any setup.
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

describe("cost-guardian — exit codes", () => {
  test("tick with unknown flag → exit non-zero", async () => {
    const { result, stderr } = await captureStreams(() =>
      runCostGuardian(["tick", "--this-flag-does-not-exist"]),
    );
    expect(result).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("tick with unknown key=value flag → exit non-zero", async () => {
    const { result, stderr } = await captureStreams(() => runCostGuardian(["tick", "--bogus=42"]));
    expect(result).not.toBe(0);
    expect(stderr).toContain("--bogus");
  });

  test("tick --help → exit 0 with USAGE", async () => {
    const { result, stdout } = await captureStreams(() => runCostGuardian(["tick", "--help"]));
    expect(result).toBe(0);
    expect(stdout).toContain("llamactl cost-guardian");
  });

  test("tick -h → exit 0 with USAGE", async () => {
    const { result, stdout } = await captureStreams(() => runCostGuardian(["tick", "-h"]));
    expect(result).toBe(0);
    expect(stdout).toContain("llamactl cost-guardian");
  });

  test("top-level --help → exit 0 with USAGE", async () => {
    const { result, stdout } = await captureStreams(() => runCostGuardian(["--help"]));
    expect(result).toBe(0);
    expect(stdout).toContain("llamactl cost-guardian");
  });
});
