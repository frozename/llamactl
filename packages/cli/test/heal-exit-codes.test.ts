import { describe, expect, test } from "bun:test";

import { runHeal } from "../src/commands/heal.js";

/**
 * `llamactl heal` exit-code contract:
 *
 *   - An unknown / typo'd flag MUST exit non-zero so CI catches the
 *     misconfiguration instead of believing the heal loop started.
 *   - `--help` / `-h` MUST exit 0 — explicit usage request.
 *
 * Both branches print before touching any subsystem (no tool client
 * boot, no journal write), so the tests can run without any setup.
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

describe("heal — exit codes", () => {
  test("unknown flag → exit non-zero", async () => {
    const { result, stderr } = await captureStreams(() => runHeal(["--this-flag-does-not-exist"]));
    expect(result).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("unknown key=value flag → exit non-zero", async () => {
    const { result, stderr } = await captureStreams(() => runHeal(["--bogus=42"]));
    expect(result).not.toBe(0);
    expect(stderr).toContain("--bogus");
  });

  test("--help → exit 0 with USAGE", async () => {
    const { result, stdout } = await captureStreams(() => runHeal(["--help"]));
    expect(result).toBe(0);
    expect(stdout).toContain("llamactl heal");
  });

  test("-h → exit 0 with USAGE", async () => {
    const { result, stdout } = await captureStreams(() => runHeal(["-h"]));
    expect(result).toBe(0);
    expect(stdout).toContain("llamactl heal");
  });
});
