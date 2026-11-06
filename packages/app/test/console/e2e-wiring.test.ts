// packages/app/test/console/e2e-wiring.test.ts
// Issue frozename/llamactl#410 (plan P5b part 2a) — RED wiring contract
// for the Playwright console e2e suite. Pure file reads only: no
// process, no network, no clock. Every case fails by assertion at the
// base commit — never by import or ENOENT — through the
// existsSync-then-readFileSync pattern. The suite pins the
// chromium-only playwright.config.ts, the serve.ts dist preflight,
// the fixtures/test.ts control fixture, the four console specs'
// import contract, the advisory console-e2e workflow and the ignore
// entries that keep Playwright artifacts out of the lint, format and
// test sweeps.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { existsSync, readdirSync, readFileSync } from "../../src/safe-fs.js";

const APP = join(import.meta.dir, "..", "..");
const ROOT = join(APP, "..", "..");

const PLAYWRIGHT_CONFIG = join(APP, "playwright.config.ts");
const E2E_DIR = join(APP, "e2e");
const HARNESS_SERVE = join(E2E_DIR, "harness", "serve.ts");
const CONTROL_FIXTURE = join(E2E_DIR, "harness", "fixtures", "test.ts");
const APP_PACKAGE_JSON = join(APP, "package.json");
const APP_TSCONFIG_E2E = join(APP, "tsconfig.e2e.json");
const ROOT_TSCONFIG_ESLINT = join(ROOT, "tsconfig.eslint.json");
const E2E_WORKFLOW = join(ROOT, ".github", "workflows", "console-e2e.yml");
const CHECK_WORKFLOW = join(ROOT, ".github", "workflows", "check.yml");
const PRETTIER_IGNORE = join(ROOT, ".prettierignore");
const ESLINT_CONFIG = join(ROOT, "eslint.config.mjs");
const APP_GITIGNORE = join(APP, ".gitignore");
const BUN_TEST_DIR = join(APP, "test");

const SPEC_NAMES = ["fleet", "workloads", "nodes", "session"] as const;

const pwImport = "from " + JSON.stringify("@playwright/" + "test");

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(?<!\S)\/\/[^\n]*/g, "");
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseYamlSafe(text: string): unknown {
  try {
    return parseYaml(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  const out: string[] = [];
  for (const item of asUnknownArray(value)) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

function asStringList(value: unknown): string[] {
  return typeof value === "string" ? [value] : asStringArray(value);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const item of asUnknownArray(value)) {
    const record = asRecord(item);
    if (record !== null) out.push(record);
  }
  return out;
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function firstIgnoresBlock(text: string): string {
  const marker = text.indexOf("ignores: [");
  if (marker < 0) return "";
  const close = text.indexOf("]", marker);
  return close < 0 ? "" : text.slice(marker, close + 1);
}

describe("e2e wiring contract (#410 P5b part 2a)", () => {
  test("R1 playwright.config.ts pins a single-worker chromium run", () => {
    expect(existsSync(PLAYWRIGHT_CONFIG)).toBe(true);
    const text = readText(PLAYWRIGHT_CONFIG);
    for (const needle of [
      "workers: 1",
      "fullyParallel: false",
      "retries: 0",
      "forbidOnly",
      '"retain-on-failure"',
      "webServer",
      "127.0.0.1",
      "testDir",
    ]) {
      expect(text).toContain(needle);
    }
    expect(text).toContain("chromium");
    expect(text).not.toContain("firefox");
    expect(text).not.toContain("webkit");
    expect(text).not.toMatch(/process\.env\.[A-Za-z_]/);
  });

  test("R2 the config is import-safe: no fs probes, exits or throws", () => {
    expect(existsSync(PLAYWRIGHT_CONFIG)).toBe(true);
    const code = stripComments(readText(PLAYWRIGHT_CONFIG));
    expect(code).not.toMatch(/\b(?:existsSync|statSync|accessSync|readFileSync|readdirSync)\s*\(/);
    expect(code).not.toContain("process.exit(");
    expect(code).not.toMatch(/^\s*throw\s/m);
  });

  test("R3 serve.ts main block preflights the dist and names the build:web hint", () => {
    const text = readText(HARNESS_SERVE);
    const marker = text.indexOf("if (import.meta.main)");
    const mainBlock = marker < 0 ? "" : text.slice(marker);
    expect(mainBlock).toContain("existsSync(");
    expect(mainBlock).toContain("index.html");
    expect(mainBlock).toContain("build:web");
  });

  test("R4 package.json pins the runner dep and the e2e/build:web scripts", () => {
    const pkg = asRecord(parseJsonSafe(readText(APP_PACKAGE_JSON)));
    const devDeps = asRecord(pkg?.["devDependencies"]);
    const scripts = asRecord(pkg?.["scripts"]);
    expect(asString(devDeps?.["@playwright/test"])).toBe("1.59.1");
    expect(asString(scripts?.["e2e"])).toBe("playwright test");
    expect(asString(scripts?.["build:web"])).toBe("vite build -c vite.web.config.ts");
    expect(asString(scripts?.["typecheck"])).toContain("tsconfig.e2e.json");
  });

  test("R5 tsconfig.e2e.json and the eslint project cover the new surfaces", () => {
    const e2eConfig = asRecord(parseJsonSafe(readText(APP_TSCONFIG_E2E)));
    const include = asStringArray(e2eConfig?.["include"]);
    expect(include).toContain("e2e/**/*.ts");
    expect(include).toContain("playwright.config.ts");
    const eslintTsconfig = asRecord(parseJsonSafe(readText(ROOT_TSCONFIG_ESLINT)));
    const eslintInclude = asStringArray(eslintTsconfig?.["include"]);
    expect(eslintInclude).toContain("packages/app/playwright.config.ts");
  });

  test("R6 fixtures/test.ts extends the runner with auto sentinel/reset hooks", () => {
    expect(existsSync(CONTROL_FIXTURE)).toBe(true);
    const code = stripComments(readText(CONTROL_FIXTURE));
    expect(code).toMatch(/\bauto:\s*true\b/);
    expect(code).toMatch(/["'`]\/reset["'`]/);
    expect(code).toMatch(/\bE2E_SENTINEL_VALUES\b/);
    expect(code).toMatch(/page\.content\(\)/);
    expect(code).toMatch(/\b(?:base|test)\.extend\s*</);
    expect(code).not.toMatch(/process\.env\.[A-Za-z_]/);
  });

  test("R7 specs ride the control fixture and no Bun test re-imports the runner", () => {
    const specImport = /from\s*["']\.\/harness\/fixtures\/test(?:\.js|\.ts)?["']/;
    const directRunnerImport = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/;
    for (const name of SPEC_NAMES) {
      const specPath = join(E2E_DIR, `${name}.spec.ts`);
      expect(existsSync(specPath)).toBe(true);
      const text = readText(specPath);
      expect(text).toMatch(specImport);
      expect(text).not.toMatch(directRunnerImport);
    }
    const offenders: string[] = [];
    for (const file of walkFiles(BUN_TEST_DIR)) {
      if (file === import.meta.path) continue;
      if (readText(file).includes(pwImport)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("R8 nodes/session specs pin reachability, reload and guard assertions", () => {
    const nodes = stripComments(readText(join(E2E_DIR, "nodes.spec.ts")));
    expect(nodes).toContain("setReachable");
    expect(nodes).toContain("page.reload(");
    expect(nodes).not.toContain("test.fixme");

    const session = stripComments(readText(join(E2E_DIR, "session.spec.ts")));
    expect(session).toContain("clearCookies");
    expect(session).toMatch(/sec-fetch-site/i);
    for (const needle of ["same-origin", "cross-site", "workloadApply", "procedure_not_exposed"]) {
      expect(session).toContain(needle);
    }
    expect(session).toMatch(/getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*["']Describe["']/);
    expect(session).toMatch(/getByRole\(\s*["']alert["']\s*\)/);
  });

  test("R9 console-e2e.yml is advisory and check.yml stays playwright-free", () => {
    expect(existsSync(E2E_WORKFLOW)).toBe(true);
    const doc = asRecord(parseYamlSafe(readText(E2E_WORKFLOW)));
    const jobs = asRecord(doc?.["jobs"]);
    const jobList = jobs === null ? [] : asRecordArray(Object.values(jobs));
    const ubuntuJobs = jobList.filter((job) =>
      asStringList(job["runs-on"]).includes("ubuntu-latest"),
    );
    expect(ubuntuJobs.length).toBeGreaterThan(0);
    const ubuntuSteps = ubuntuJobs.flatMap((job) => asRecordArray(job["steps"]));
    const usesList = ubuntuSteps.map((step) => asString(step["uses"]));
    expect(usesList.some((uses) => uses.startsWith("actions/setup-node"))).toBe(true);
    const allSteps = jobList.flatMap((job) => asRecordArray(job["steps"]));
    const runLines = allSteps.map((step) => asString(step["run"])).filter((run) => run !== "");
    expect(runLines.some((run) => run.includes("bun run --cwd packages/app build:web"))).toBe(true);
    expect(
      runLines.some((run) => run.includes("playwright install") && run.includes("chromium")),
    ).toBe(true);
    const wdRun = allSteps.some((step) => {
      const wd = asString(step["working-directory"]);
      const run = asString(step["run"]);
      return wd.endsWith("packages/app") && run.includes("npx playwright test");
    });
    const cwdRun = runLines.some((run) => run.includes("bun run --cwd packages/app e2e"));
    expect(wdRun || cwdRun).toBe(true);
    expect(runLines.some((run) => /playwright test.*(?:\s-c\s|--config)/.test(run))).toBe(false);
    expect(readText(CHECK_WORKFLOW)).not.toContain("playwright");
    // The workflow header's advisory contract: failures must reach the
    // PR status unmasked — continue-on-error would silently swallow them.
    for (const job of jobList) {
      expect(Boolean(job["continue-on-error"])).toBe(false);
    }
    for (const step of allSteps) {
      expect(Boolean(step["continue-on-error"])).toBe(false);
    }
  });

  test("R10 ignores cover the Playwright output artifacts", () => {
    const prettierLines = readText(PRETTIER_IGNORE).split("\n");
    expect(prettierLines).toContain("packages/app/test-results/**");
    expect(prettierLines).toContain("packages/app/playwright-report/**");
    const ignores = firstIgnoresBlock(readText(ESLINT_CONFIG));
    expect(ignores).toContain("packages/app/test-results/**");
    expect(ignores).toContain("packages/app/playwright-report/**");
    const gitignore = readText(APP_GITIGNORE);
    expect(gitignore).toContain("test-results/");
    expect(gitignore).toContain("playwright-report/");
  });
});
