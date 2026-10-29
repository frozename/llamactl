import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { existsSync, readdirSync, readFileSync } from "../src/safe-fs.js";

/**
 * Pins the llamactl tier of .github/workflows/cross-repo-smoke.yml (#334).
 * bun reads bunfig.toml, and with it the storage-sandbox test preload, only
 * from the directory it runs in. The tier must therefore run each package
 * from its own directory, as check.yml does, and never a bare `bun test`
 * from the repo root. Pure file reads: no clock, process or network.
 */

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  "working-directory"?: string;
}

interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

const REPO_ROOT = join(import.meta.dir, "../../..");
const TIER_SETUP_STEP = "Setup Bun for the llamactl tier";
const ROOT_RUN = "llamactl :: bun test ./packages/policy ./scripts ./tests ./tools";

function loadSteps(file: string, job: string): WorkflowStep[] {
  const text = readFileSync(join(REPO_ROOT, ".github/workflows", file), "utf8");
  const workflow = parseYaml(text) as Workflow;
  const steps = workflow.jobs[job]?.steps;
  if (steps === undefined) {
    throw new Error(`${file} has no jobs.${job}.steps`);
  }
  return steps;
}

function tierSteps(): WorkflowStep[] {
  const steps = loadSteps("cross-repo-smoke.yml", "smoke");
  const setup = steps.findIndex((step) => step.name === TIER_SETUP_STEP);
  if (setup < 0) {
    throw new Error(`cross-repo-smoke.yml has no "${TIER_SETUP_STEP}" step`);
  }
  return steps.slice(setup + 1);
}

// One "<working-directory> :: <command>" entry per non-empty run line.
function commands(steps: WorkflowStep[]): string[] {
  return steps.flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => `${step["working-directory"] ?? ""} :: ${line}`),
  );
}

function isBareRootRun(command: string): boolean {
  if (!command.startsWith("llamactl :: bun test")) {
    return false;
  }
  const paths = command.slice("llamactl :: bun test".length).trim().split(/\s+/);
  return (
    paths[0] === "" ||
    paths.some((p) => !p.startsWith("./") || /^\.\/packages\/(?:cli|remote)(?:\/|$)/.test(p))
  );
}

describe("cross-repo-smoke llamactl tier", () => {
  test("runs no bare bun test from the llamactl root", () => {
    const tier = commands(tierSteps());
    expect(tier.length).toBeGreaterThan(0);
    expect(tier.filter((command) => isBareRootRun(command))).toEqual([]);
  });

  test("runs every package test command check.yml runs", () => {
    const tier = commands(tierSteps());
    const check = commands(
      loadSteps("check.yml", "check").filter(
        (step) => step.name?.startsWith("Test packages/") === true,
      ),
    );
    expect(check.length).toBeGreaterThanOrEqual(8);
    expect(check.filter((command) => !tier.includes(command))).toEqual([]);
  });

  test("runs each package that has a bunfig.toml from its own directory", () => {
    const tier = commands(tierSteps());
    const withBunfig = readdirSync(join(REPO_ROOT, "packages"))
      .filter((name) => existsSync(join(REPO_ROOT, "packages", name, "bunfig.toml")))
      .sort();
    expect(withBunfig).toContain("cli");
    expect(withBunfig).toContain("remote");
    const missing = withBunfig.filter(
      (name) => !tier.includes(`llamactl :: bun run --cwd packages/${name} test`),
    );
    expect(missing).toEqual([]);
  });

  test("keeps the tests outside the packages in one explicit-path root run", () => {
    expect(commands(tierSteps())).toContain(ROOT_RUN);
  });

  test("keeps LLAMACTL_SKIP_MDNS_TESTS=1 on every tier test step", () => {
    const testSteps = tierSteps().filter((step) => step.run !== undefined);
    expect(testSteps.length).toBeGreaterThan(0);
    const unset = testSteps
      .filter((step) => step.env?.["LLAMACTL_SKIP_MDNS_TESTS"] !== "1")
      .map((step) => step.name);
    expect(unset).toEqual([]);
  });
});
