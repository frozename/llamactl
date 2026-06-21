import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdirSync, rmSync } from "../safe-fs.js";

describe("no-cross-package-relative lint", () => {
  const SCRIPT = join(import.meta.dir, "no-cross-package-relative.ts");
  const fixtureRoot = join(tmpdir(), `no-cross-package-relative-${crypto.randomUUID()}`);

  function run(paths: string): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, "--paths", paths],
      env: { ...process.env, LLAMACTL_LINT_NO_CROSS_PACKAGE_RELATIVE_ROOT: fixtureRoot },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
    };
  }

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  async function writeFixture(rel: string, body: string): Promise<void> {
    const dir = join(fixtureRoot, rel.split("/").slice(0, -1).join("/"));
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(fixtureRoot, rel), body);
  }

  test("flags static cross-package relative imports", async () => {
    await writeFixture(
      "packages/remote/src/server.ts",
      'import { listPeers } from "../../../core/src/config/peers.js";\n',
    );
    const result = run("packages/*/src/**/*.ts");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/remote/src/server.ts:1");
    expect(result.stderr).toContain("../../../core/src/config/peers.js");
  });

  test("flags dynamic import() escapes", async () => {
    await writeFixture(
      "packages/cli/src/pricing.ts",
      'const mod = await import("../../../core/src/probe.js");\n',
    );
    const result = run("packages/*/src/**/*.ts");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("../../../core/src/probe.js");
  });

  test("flags require()/createRequire escapes", async () => {
    await writeFixture(
      "packages/mcp/src/snapshot.ts",
      'const { x } = createRequire(import.meta.url)("../../../core/src/index.js");\n',
    );
    const result = run("packages/*/src/**/*.ts");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("../../../core/src/index.js");
  });

  test("flags import.meta.dir/__dirname path-climb into a sibling package", async () => {
    await writeFixture(
      "packages/cli/src/boot.ts",
      [
        "const DEFAULT_ENTRY = pathResolve(",
        "  import.meta.dir,",
        '  "..",',
        '  "..",',
        '  "..",',
        '  "core",',
        '  "bin",',
        '  "worker.ts",',
        ");",
        "",
      ].join("\n"),
    );
    const result = run("packages/*/src/**/*.ts");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/cli/src/boot.ts");
  });

  test("passes when there are no cross-package relative imports", async () => {
    await writeFixture(
      "packages/remote/src/clean.ts",
      'import { listPeers } from "@llamactl/core/config/peers";\nimport { local } from "./local.js";\n',
    );
    const result = run("packages/*/src/**/*.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no cross-package relative imports found");
  });
});
