import { describe, expect, test } from "bun:test";

import { runInfra } from "../src/commands/infra.js";

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

describe("infra uninstall flag validation", () => {
  test("typo'd flag exits non-zero before any uninstall mutation", async () => {
    const { result, stderr } = await captureStreams(() =>
      runInfra(["uninstall", "pkg", "--verison=1"]),
    );
    expect(result).not.toBe(0);
    expect(stderr).toContain("unknown flag --verison");
  });

  test("missing --version and --all exits non-zero with a clear message", async () => {
    const { result, stderr } = await captureStreams(() => runInfra(["uninstall", "pkg"]));
    expect(result).not.toBe(0);
    expect(stderr).toContain("specify --version=<v> or --all");
  });

  test("--version selects version mode", async () => {
    const { result, stdout } = await captureStreams(() =>
      runInfra(["uninstall", "pkg", "--version=b4500"]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain(`"mode":"version"`);
  });

  test("--all selects package mode", async () => {
    const { result, stdout } = await captureStreams(() => runInfra(["uninstall", "pkg", "--all"]));
    expect(result).toBe(0);
    expect(stdout).toContain(`"mode":"package"`);
  });
});

describe("infra install flag validation", () => {
  test("typo'd flag exits non-zero", async () => {
    const { result, stderr } = await captureStreams(() =>
      runInfra(["install", "pkg", "--verison=1"]),
    );
    expect(result).not.toBe(0);
    expect(stderr).toContain("unknown flag --verison");
  });
});
