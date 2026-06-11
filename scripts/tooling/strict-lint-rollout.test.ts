import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

function readPackageJson(path: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as { scripts?: Record<string, string> };
}

describe("strict lint rollout baselines", () => {
  // Cold bunx resolution on a fresh CI runner takes >5s on its own, which
  // trips bun:test's default per-test timeout before eslint even runs
  // (seen in cross-repo-smoke, where no warm cache exists) — hence the
  // explicit generous timeout.
  const eslintBaselineTimeoutMs = 120_000;
  test(
    "bunx eslint on this test file exits cleanly or with lint violations only",
    () => {
      const proc = spawnSync("bunx", ["eslint", "scripts/tooling/strict-lint-rollout.test.ts"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(proc.status).not.toBe(2);
      expect(proc.status === 0 || proc.status === 1).toBe(true);
    },
    eslintBaselineTimeoutMs,
  );

  test("root typecheck covers every TypeScript package", () => {
    const pkg = readPackageJson("package.json");
    const typecheck = pkg.scripts?.typecheck ?? "";
    const packages = ["core", "cli", "app", "remote", "eval", "agents", "fleet-supervisor", "mcp"];

    for (const name of packages) {
      expect(typecheck).toContain(`packages/${name}`);
    }
  });

  test("app typecheck checks referenced projects instead of the solution shell", () => {
    const pkg = readPackageJson("packages/app/package.json");
    const typecheck = pkg.scripts?.typecheck ?? "";

    expect(typecheck.trim()).not.toBe("tsc --noEmit");
    expect(typecheck).toContain("tsconfig.main.json");
    expect(typecheck).toContain("tsconfig.node.json");
    expect(typecheck).toContain("tsconfig.web.json");
  });

  test("root package.json exposes the strict lint and format scripts", () => {
    const pkg = readPackageJson("package.json");

    expect(pkg.scripts?.lint).toBe("eslint .");
    expect(pkg.scripts?.["lint:fix"]).toBe("eslint . --fix");
    expect(pkg.scripts?.prepare).toBe("husky");
    expect(pkg.scripts?.format).toBe("prettier . --write");
    expect(pkg.scripts?.["format:check"]).toBe("prettier . --check");
  });

  test("pre-commit hook stays fast; pre-push carries the full lint", () => {
    const preCommit = readFileSync(join(root, ".husky/pre-commit"), "utf8");
    const prePush = readFileSync(join(root, ".husky/pre-push"), "utf8");

    expect(preCommit).toContain("bunx lint-staged");
    expect(preCommit).not.toContain("bun run lint");
    expect(preCommit).not.toContain("tsc");
    expect(prePush).toContain("bun run lint");
  });

  test("tsconfig.eslint.json exists but is not referenced by build typecheck configs", () => {
    expect(existsSync(join(root, "tsconfig.eslint.json"))).toBe(true);

    const rootTsconfig = existsSync(join(root, "tsconfig.json"))
      ? readFileSync(join(root, "tsconfig.json"), "utf8")
      : "";
    const baseTsconfig = readFileSync(join(root, "tsconfig.base.json"), "utf8");

    expect(rootTsconfig).not.toContain("tsconfig.eslint.json");
    expect(baseTsconfig).not.toContain("tsconfig.eslint.json");
  });
});
