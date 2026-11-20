// packages/cli/test/composite-destroy-stop-refusal.test.ts
//
// Part of #520: `llamactl composite destroy` must not print the
// unconditional 'destroyed composite/<name>' header when the destroy
// result carries manifestPreserved — a node stop-fence refusal means
// the composite manifest was kept for retry. printDestroyResult is
// exercised in-process through a stdout/stderr capture; no dispatcher,
// no network.
import { describe, expect, test } from "bun:test";

import * as compositeCli from "../src/commands/composite.js";

/**
 * Capture stdout + stderr writes during `fn`. Mirrors the trick
 * composite.test.ts uses — in-process, no subprocess needed for a
 * pure print helper.
 */
async function capture(fn: () => number | Promise<number>): Promise<{
  code: number;
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
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// printDestroyResult is not exported on the base — the fix exports it.
// Read it through a cast so this file typechecks against both.
function exportedPrintDestroyResult(): (result: unknown, name: string) => number {
  const fn = (compositeCli as unknown as Record<string, unknown>)["printDestroyResult"];
  expect(typeof fn).toBe("function");
  return fn as (result: unknown, name: string) => number;
}

describe("composite destroy — stop-fence refusal reporting (#520)", () => {
  test("C1: manifestPreserved result prints the not-destroyed header, lists the refusal, exits 1", async () => {
    // Kills: keeping the unconditional 'destroyed composite/<name>'
    // header — a preserved manifest must print the not-destroyed line
    // instead, and the refusal must still surface as an error row.
    const printDestroyResult = exportedPrintDestroyResult();

    const { code, stdout } = await capture(() =>
      printDestroyResult(
        {
          dryRun: false,
          ok: false,
          removed: [{ kind: "service", name: "chroma-1" }],
          errors: [
            {
              ref: { kind: "workload", name: "local" },
              message:
                "serverStop on local refused (SessionsActive: s1); composite manifest preserved",
            },
          ],
          manifestPreserved: true,
        },
        "kb-stack",
      ),
    );

    expect(code).toBe(1);
    expect(stdout).toContain(
      "composite/kb-stack not destroyed: a workload stop was refused; manifest preserved",
    );
    expect(stdout).not.toContain("destroyed composite/kb-stack");
    expect(stdout).toContain(
      "✗ workload/local — serverStop on local refused (SessionsActive: s1); composite manifest preserved",
    );
  });

  test("C2 guard: a clean destroy still prints the destroyed header and exits 0", async () => {
    // Guard: on the base this fails only at the shared export assertion
    // in exportedPrintDestroyResult (printDestroyResult is not exported
    // yet); once exported, the rest passes unchanged — a result without
    // manifestPreserved must keep the existing output.
    const printDestroyResult = exportedPrintDestroyResult();

    const { code, stdout } = await capture(() =>
      printDestroyResult(
        {
          dryRun: false,
          ok: true,
          removed: [{ kind: "workload", name: "local" }],
          errors: [],
        },
        "kb-stack",
      ),
    );

    expect(code).toBe(0);
    expect(stdout).toContain("destroyed composite/kb-stack");
  });
});
