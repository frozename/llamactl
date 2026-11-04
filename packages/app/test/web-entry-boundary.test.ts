// packages/app/test/web-entry-boundary.test.ts
// Issue #410, P1 RED 1 — transport-neutral client boundary. Each case runs
// in a fresh Bun subprocess because the in-process electronTRPC stub is
// order-dependent (plan §0.2): whether the global exists when a module is
// evaluated depends on which test file imported test/setup.ts first, and a
// cached module never re-evaluates. A clean process is the only way to prove
// the renderer entry modules no longer touch the Electron bridge at module
// scope.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const APP_DIR = join(import.meta.dir, "..");

interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runAppModule(script: string): Promise<SubprocessResult> {
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: APP_DIR,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

interface ModuleShape {
  createAppClient?: string;
  trpc?: string;
  hasTrpcClient?: boolean;
}

function parseLastJsonLine(stdout: string): ModuleShape | null {
  const lastLine =
    stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .at(-1) ?? "";
  try {
    return JSON.parse(lastLine) as ModuleShape;
  } catch {
    return null;
  }
}

describe("web entry boundary (#410 P1)", () => {
  test("src/lib/trpc.ts loads without electronTRPC and exports createAppClient, not a bound client", async () => {
    const script = [
      'const m = await import("./src/lib/trpc.ts");',
      "console.log(JSON.stringify({",
      "  createAppClient: typeof m.createAppClient,",
      "  trpc: typeof m.trpc,",
      '  hasTrpcClient: "trpcClient" in m,',
      "}));",
    ].join(" ");
    const { exitCode, stdout, stderr } = await runAppModule(script);

    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/electronTRPC|getBridge/);

    const parsed = parseLastJsonLine(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed?.createAppClient).toBe("function");
    expect(["object", "function"]).toContain(parsed?.trpc ?? "missing");
    expect(parsed?.hasTrpcClient).toBe(false);
  });

  test("src/lib/transport/ipc.ts ipcLink() builds a client with no electronTRPC global", async () => {
    const script = [
      'const m = await import("./src/lib/transport/ipc.ts");',
      'const { createTRPCClient } = await import("@trpc/client");',
      "createTRPCClient({ links: [m.ipcLink()] });",
      'console.log("ok");',
    ].join(" ");
    const { exitCode, stdout } = await runAppModule(script);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("ok");
  });
});
