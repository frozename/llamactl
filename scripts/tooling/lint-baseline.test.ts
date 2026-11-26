// scripts/tooling/lint-baseline.test.ts
// RED contract for frozename/llamactl#846: the baseline runner must be
// hermetic, pass a heap ceiling to eslint, and surface crash causes.

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import nodeFs, {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../safe-fs.js";

type RuleCounts = {
  errors: number;
  warnings: number;
};

type Baseline = {
  totals: RuleCounts;
  byRule: Record<string, RuleCounts>;
  byFile: Record<string, RuleCounts>;
};

type LintMessage = {
  ruleId: string | null;
  severity: number;
};

type FixtureResult = {
  filePath: string;
  errorCount: number;
  warningCount: number;
  messages: readonly LintMessage[];
};

type RunOpts = {
  root: string;
  eslintBin: string;
  outDir: string;
  now: Date;
  env: Record<string, string | undefined>;
};

type LintBaselineLib = {
  buildBaseline: (results: readonly FixtureResult[], root: string) => Baseline;
  eslintEnv: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Record<string, string | undefined>;
  runLintBaseline: (opts: RunOpts) => string;
};

// A literal specifier would make tsc require the not-yet-existing implementation module.
const lintBaselineLibSpecifier = "./lint-baseline-lib.js";
const tmpRoots: string[] = [];

async function loadLib(): Promise<Partial<LintBaselineLib>> {
  const loaded: unknown = await import(lintBaselineLibSpecifier).catch(() => ({}));
  return loaded as Partial<LintBaselineLib>;
}

function createTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lint-baseline-test-"));
  tmpRoots.push(root);
  return root;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

type FakeEslint = {
  argvPath: string;
  binPath: string;
  cwdPath: string;
  nodeOptionsPath: string;
};

function writeFakeEslint(root: string, body: readonly string[]): FakeEslint {
  const argvPath = join(root, "argv.txt");
  const binPath = join(root, "fake-eslint");
  const cwdPath = join(root, "cwd.txt");
  const nodeOptionsPath = join(root, "node-options.txt");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$#" "$@" > ${shQuote(argvPath)}`,
    `pwd -P > ${shQuote(cwdPath)}`,
    `printf '%s' "\${NODE_OPTIONS-}" > ${shQuote(nodeOptionsPath)}`,
    ...body,
  ].join("\n");
  writeFileSync(binPath, `${script}\n`, "utf8");
  chmodSync(binPath, 0o755);
  return { argvPath, binPath, cwdPath, nodeOptionsPath };
}

function makeRunOpts(root: string, eslintBin: string, outDir: string): RunOpts {
  return {
    root,
    eslintBin,
    outDir,
    now: new Date(2026, 10, 25),
    env: { PATH: process.env["PATH"] },
  };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function directoryEntries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("lint baseline capture", () => {
  test("buildBaseline aggregates fixture results", async () => {
    const lib = await loadLib();
    expect(typeof lib.buildBaseline).toBe("function");
    if (lib.buildBaseline === undefined) {
      throw new Error("unreachable");
    }
    createTmpRoot();

    const baseline = lib.buildBaseline(
      [
        {
          filePath: "/repo/a.ts",
          errorCount: 2,
          warningCount: 1,
          messages: [
            { ruleId: "r1", severity: 2 },
            { ruleId: "r1", severity: 2 },
            { ruleId: "r2", severity: 1 },
          ],
        },
        {
          filePath: "/repo/sub/b.ts",
          errorCount: 1,
          warningCount: 0,
          messages: [{ ruleId: null, severity: 2 }],
        },
      ],
      "/repo",
    );

    expect(baseline).toEqual({
      totals: { errors: 3, warnings: 1 },
      byRule: {
        r1: { errors: 2, warnings: 0 },
        r2: { errors: 0, warnings: 1 },
        "(no-rule-id)": { errors: 1, warnings: 0 },
      },
      byFile: {
        "a.ts": { errors: 2, warnings: 1 },
        "sub/b.ts": { errors: 1, warnings: 0 },
      },
    });
  });

  test("eslintEnv adds a heap limit without clobbering", async () => {
    const lib = await loadLib();
    expect(typeof lib.eslintEnv).toBe("function");
    if (lib.eslintEnv === undefined) {
      throw new Error("unreachable");
    }
    createTmpRoot();

    const pathOnly = { PATH: "/bin" };
    const pathResult = lib.eslintEnv(pathOnly);
    expect(pathResult["NODE_OPTIONS"]).toBe("--max-old-space-size=4096");
    expect(pathResult["PATH"]).toBe("/bin");
    expect(pathOnly).toEqual({ PATH: "/bin" });

    const existingOptions = { NODE_OPTIONS: "--trace-warnings" };
    const merged = lib.eslintEnv(existingOptions);
    expect(merged["NODE_OPTIONS"]).toBe("--trace-warnings --max-old-space-size=4096");
    expect(existingOptions).toEqual({ NODE_OPTIONS: "--trace-warnings" });

    const operatorSet = { NODE_OPTIONS: "--max-old-space-size=8192" };
    expect(lib.eslintEnv(operatorSet)["NODE_OPTIONS"]).toBe("--max-old-space-size=8192");
    expect(operatorSet).toEqual({ NODE_OPTIONS: "--max-old-space-size=8192" });
  });

  test("runLintBaseline writes a dated baseline from eslint JSON", async () => {
    const lib = await loadLib();
    expect(typeof lib.runLintBaseline).toBe("function");
    if (lib.runLintBaseline === undefined) {
      throw new Error("unreachable");
    }
    const runLintBaseline = lib.runLintBaseline;
    const tmpRoot = createTmpRoot();
    const payload = JSON.stringify([
      {
        filePath: join(tmpRoot, "x.ts"),
        errorCount: 1,
        warningCount: 0,
        messages: [{ ruleId: "r1", severity: 2 }],
      },
    ]);
    const fake = writeFakeEslint(tmpRoot, [`printf '%s\\n' ${shQuote(payload)}`, "exit 1"]);
    const outDir = join(tmpRoot, "out");

    const outputPath = runLintBaseline(makeRunOpts(tmpRoot, fake.binPath, outDir));
    const expectedOutputPath = join(outDir, "lint-baseline-2026-11-25.json");

    expect(outputPath).toBe(expectedOutputPath);
    const written = JSON.parse(readFileSync(expectedOutputPath, "utf8")) as Baseline;
    expect(written).toEqual({
      totals: { errors: 1, warnings: 0 },
      byRule: { r1: { errors: 1, warnings: 0 } },
      byFile: { "x.ts": { errors: 1, warnings: 0 } },
    });
    expect(readFileSync(fake.argvPath, "utf8")).toBe("3\n.\n--format\njson\n");
    expect(readFileSync(fake.cwdPath, "utf8").trimEnd()).toBe(nodeFs.realpathSync(tmpRoot));
    expect(readFileSync(fake.nodeOptionsPath, "utf8")).toContain("--max-old-space-size=4096");
  });

  test("runLintBaseline reports an out-of-memory crash", async () => {
    const lib = await loadLib();
    expect(typeof lib.runLintBaseline).toBe("function");
    if (lib.runLintBaseline === undefined) {
      throw new Error("unreachable");
    }
    const runLintBaseline = lib.runLintBaseline;
    const tmpRoot = createTmpRoot();
    const fake = writeFakeEslint(tmpRoot, [
      `printf '%s\\n' ${shQuote(
        "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
      )} >&2`,
      "kill -ABRT $$",
    ]);
    const outDir = join(tmpRoot, "out");

    const thrown = captureError(() => runLintBaseline(makeRunOpts(tmpRoot, fake.binPath, outDir)));

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("unreachable");
    }
    expect(thrown.message).toContain("SIGABRT");
    expect(thrown.message).toContain("JavaScript heap out of memory");
    expect(directoryEntries(outDir)).toEqual([]);
  });

  test("runLintBaseline rejects empty eslint stdout", async () => {
    const lib = await loadLib();
    expect(typeof lib.runLintBaseline).toBe("function");
    if (lib.runLintBaseline === undefined) {
      throw new Error("unreachable");
    }
    const runLintBaseline = lib.runLintBaseline;
    const tmpRoot = createTmpRoot();
    const fake = writeFakeEslint(tmpRoot, ["exit 0"]);
    const outDir = join(tmpRoot, "out");

    const thrown = captureError(() => runLintBaseline(makeRunOpts(tmpRoot, fake.binPath, outDir)));

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("unreachable");
    }
    expect(thrown.message).toContain("did not produce JSON");
  });
});
