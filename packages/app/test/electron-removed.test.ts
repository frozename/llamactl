// packages/app/test/electron-removed.test.ts
// Issue #410, P7-A RED 1-4 and 7 — pins the Electron removal: the app
// manifest declares no electron*/undici deps, the tsconfig.json program
// reaches src/main.web.tsx without a packages/app/electron/** input, no
// tracked file under packages/app imports the electron bridge, the
// eslint/tsconfig surfaces drop the electron paths, no UI workflow stays
// macOS-only, electron-mcp leaves workflows/scripts/tests/docs, and the
// #410 decision record gains the measured before/after table plus the
// remaining-costs section. Every case fails by assertion at the base
// commit — never by import error.

import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parse } from "yaml";

import { readdirSync, readFileSync } from "../src/safe-fs.js";

const APP = join(import.meta.dir, "..");
const ROOT = join(APP, "..", "..");
const SUBPROCESS_TIMEOUT_MS = 60_000;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const ELECTRON_DEP_NAME = /^electron|electron-|^undici$/;

const ELECTRON_IMPORT_PATTERNS = [
  /from\s+["']electron["']|require\(\s*["']electron["']\s*\)|import\(\s*["']electron["']\s*\)/,
  /["']electron-trpc(?:\/[^"']*)?["']/,
  /ipc-link/,
  /\belectronTRPC\b/,
];

const ELECTRON_SCAN_EXEMPTIONS = [
  {
    path: "packages/app/test/electron-removed.test.ts",
    reason: "this guard names the banned tokens",
  },
  {
    path: "packages/app/test/console/web-graph-electron-free.test.ts",
    reason: "a guard that names the banned tokens in order to ban them",
  },
] as const;

// historical session notes
const ELECTRON_MCP_SESSION_NOTE_EXCLUDES = [":!docs/superpowers", ":!docs/notes"];

const ELECTRON_MCP_GREP_EXCLUDES = [
  {
    pathspec: ":!packages/app/test/electron-removed.test.ts",
    reason: "this guard names the token",
  },
  {
    pathspec: ":!scripts/measure-410.ts",
    reason: "the P6 meter that counts this token",
  },
  {
    pathspec: ":!scripts/measure-410.test.ts",
    reason: "the P6 meter that counts this token",
  },
  {
    pathspec: ":!docs/plans/electron-retirement-and-web-console.md",
    reason: "the #410 retirement records",
  },
  {
    pathspec: ":!docs/decisions/410-ui-runtime.md",
    reason: "the #410 retirement records",
  },
] as const;

const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const UI_WORKFLOW_TEXT = /electron|playwright|xvfb/i;
const MATRIX_OS_RUNS_ON = "${{ matrix.os }}";

const DECISION_RECORD = join(ROOT, "docs", "decisions", "410-ui-runtime.md");
const MEASURED_SECTION = /^## Measured before\/after/m;
const REMAINING_COSTS_SECTION = /^## Remaining costs/m;

function matrixOsValues(matrix: unknown): string[] {
  if (matrix === null || typeof matrix !== "object") {
    return [];
  }
  const shape = matrix as { include?: unknown; os?: unknown };
  const values = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      values.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) {
        if (typeof item === "string") {
          values.add(item);
        }
      }
    }
  };
  collect(shape.os);
  if (Array.isArray(shape.include)) {
    for (const entry of shape.include as unknown[]) {
      if (entry !== null && typeof entry === "object") {
        collect((entry as { os?: unknown }).os);
      }
    }
  }
  return [...values];
}

function runnersForJob(job: unknown): string[] {
  if (job === null || typeof job !== "object") {
    return [];
  }
  const shape = job as { "runs-on"?: unknown; strategy?: { matrix?: unknown } };
  const runsOn = shape["runs-on"];
  if (typeof runsOn !== "string") {
    return [];
  }
  if (runsOn.includes(MATRIX_OS_RUNS_ON)) {
    return matrixOsValues(shape.strategy?.matrix);
  }
  return [runsOn];
}

function uiWorkflowRunnerOffenders(): string[] {
  const offenders: string[] = [];
  for (const name of readdirSync(WORKFLOWS_DIR).sort()) {
    if (!name.endsWith(".yml")) {
      continue;
    }
    const text = readFileSync(join(WORKFLOWS_DIR, name), "utf8");
    if (!name.startsWith("ui-") && !UI_WORKFLOW_TEXT.test(text)) {
      continue;
    }
    const doc = parse(text) as { jobs?: Record<string, unknown> } | null;
    const jobs: Record<string, unknown> = doc?.jobs ?? {};
    const runners = Object.values(jobs).flatMap(runnersForJob);
    if (runners.length > 0 && runners.every((runner) => runner.startsWith("macos"))) {
      offenders.push(name);
    }
  }
  return offenders;
}

function decisionSection(doc: string, heading: RegExp): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return "";
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return lines.slice(start, end === -1 ? lines.length : start + 1 + end).join("\n");
}

describe("Electron removal (#410 P7-A)", () => {
  test("RED 1: app package.json declares no electron or undici dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const names = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
    ].flatMap((deps) => Object.keys(deps ?? {}));
    expect(names.filter((name) => ELECTRON_DEP_NAME.test(name))).toEqual([]);
  });

  test(
    "RED 2a: tsc -p tsconfig.json program includes src/main.web.tsx and no electron dir",
    () => {
      const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
      const proc = Bun.spawnSync({
        cmd: [process.execPath, tsc, "-p", "tsconfig.json", "--listFilesOnly"],
        cwd: APP,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      const files = proc.stdout
        .toString()
        .split("\n")
        .filter((line) => line.length > 0);
      expect(files.some((line) => line.endsWith("packages/app/src/main.web.tsx"))).toBe(true);
      expect(files.filter((line) => line.includes("/packages/app/electron/"))).toEqual([]);
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  test(
    "RED 2b: no tracked packages/app file reaches the electron bridge outside the guards",
    () => {
      expect(ELECTRON_SCAN_EXEMPTIONS).toEqual([
        {
          path: "packages/app/test/electron-removed.test.ts",
          reason: "this guard names the banned tokens",
        },
        {
          path: "packages/app/test/console/web-graph-electron-free.test.ts",
          reason: "a guard that names the banned tokens in order to ban them",
        },
      ]);

      const listed = Bun.spawnSync({
        cmd: ["git", "-C", ROOT, "ls-files", "packages/app"],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(listed.exitCode).toBe(0);
      const paths = listed.stdout
        .toString()
        .split("\n")
        .filter((line) => line.length > 0);
      const exempt = new Set<string>(ELECTRON_SCAN_EXEMPTIONS.map((entry) => entry.path));
      const offenders: string[] = [];
      for (const path of paths) {
        if (exempt.has(path)) {
          continue;
        }
        const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
        for (const [index, line] of lines.entries()) {
          if (ELECTRON_IMPORT_PATTERNS.some((pattern) => pattern.test(line))) {
            offenders.push(`${path}:${String(index + 1)}: ${line.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  test(
    "RED 3a: electron-mcp references are gone outside the named exemptions",
    () => {
      expect(ELECTRON_MCP_GREP_EXCLUDES).toEqual([
        {
          pathspec: ":!packages/app/test/electron-removed.test.ts",
          reason: "this guard names the token",
        },
        {
          pathspec: ":!scripts/measure-410.ts",
          reason: "the P6 meter that counts this token",
        },
        {
          pathspec: ":!scripts/measure-410.test.ts",
          reason: "the P6 meter that counts this token",
        },
        {
          pathspec: ":!docs/plans/electron-retirement-and-web-console.md",
          reason: "the #410 retirement records",
        },
        {
          pathspec: ":!docs/decisions/410-ui-runtime.md",
          reason: "the #410 retirement records",
        },
      ]);
      const proc = Bun.spawnSync({
        cmd: [
          "git",
          "-C",
          ROOT,
          "grep",
          "-n",
          "electron-mcp",
          "--",
          ".github",
          "scripts",
          "tests",
          "package.json",
          "packages",
          "docs",
          ...ELECTRON_MCP_SESSION_NOTE_EXCLUDES,
          ...ELECTRON_MCP_GREP_EXCLUDES.map((entry) => entry.pathspec),
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode === 0 || proc.exitCode === 1).toBe(true);
      const lines = proc.stdout
        .toString()
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines).toEqual([]);
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  test("RED 3b: no UI workflow runs only on macOS runners", () => {
    expect(uiWorkflowRunnerOffenders()).toEqual([]);
  });

  test(
    "RED 4: eslint and tsconfig.eslint carry no electron app paths",
    () => {
      const proc = Bun.spawnSync({
        cmd: [
          "git",
          "-C",
          ROOT,
          "grep",
          "-n",
          "-E",
          "packages/app/electron|electron\\.vite\\.config",
          "--",
          "eslint.config.mjs",
          "tsconfig.eslint.json",
          "package.json",
          ".github",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode === 0 || proc.exitCode === 1).toBe(true);
      const lines = proc.stdout
        .toString()
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines).toEqual([]);
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  test("RED 7: the #410 decision record carries measured before/after and remaining costs", () => {
    const doc = readFileSync(DECISION_RECORD, "utf8");
    expect(doc).toMatch(MEASURED_SECTION);

    const measured = decisionSection(doc, MEASURED_SECTION);
    expect(measured).toMatch(/^\|/m);
    expect(measured).toMatch(/^\|\s*:?-{3,}/m);
    const measuredLower = measured.toLowerCase();
    for (const needle of [
      "dependencies",
      "lockfile",
      "ci minutes",
      "projected",
      "renderer lines",
      "packages/app/electron/**",
      "p6 projection",
    ]) {
      expect(measuredLower).toContain(needle);
    }

    expect(doc).toMatch(REMAINING_COSTS_SECTION);
    const remainingLower = decisionSection(doc, REMAINING_COSTS_SECTION).toLowerCase();
    for (const needle of [
      "transport",
      "reconnect",
      "lifecycle",
      "port",
      "cookie",
      "origin",
      "allowlist",
      "projection",
      "sentinel",
      "playwright",
      "chromium",
      "@llamactl/remote",
      "dispatch",
    ]) {
      expect(remainingLower).toContain(needle);
    }
  });
});
