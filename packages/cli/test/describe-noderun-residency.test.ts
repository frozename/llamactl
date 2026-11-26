import * as remoteMod from "@llamactl/remote";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as helpersMod from "../src/commands/noderun-helpers.js";
import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runDescribe,
} from "../src/commands/workload.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const formatResidencyKnobs = (helpersMod as Record<string, unknown>)["formatResidencyKnobs"] as
  | ((e: { knobs: readonly { name: string; value: number; defaulted: boolean }[] }) => string)
  | undefined;
const effectiveResidencyPolicy = (remoteMod as Record<string, unknown>)[
  "effectiveResidencyPolicy"
] as
  | ((residency: { residentPreference?: number }) => {
      knobs: readonly { name: string; value: number; defaulted: boolean }[];
    })
  | undefined;

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-describe-noderun-residency-"));
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  mkdirSync(process.env["LLAMACTL_WORKLOADS_DIR"], { recursive: true });
  mkdirSync(process.env["LOCAL_AI_RUNTIME_DIR"], { recursive: true });
});

afterEach(() => {
  __resetWorkloadTestSeams();
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

async function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = stdoutOrig;
    process.stderr.write = stderrOrig;
  }
}

function writeNodeRun(name: string, extraSpecLines: string[]): void {
  writeFileSync(
    join(process.env["LLAMACTL_WORKLOADS_DIR"]!, `${name}.yaml`),
    `${[
      "apiVersion: llamactl/v1",
      "kind: NodeRun",
      "metadata:",
      `  name: ${name}`,
      "spec:",
      "  node: z13",
      "  infra:",
      "    - pkg: llama-cpp",
      "      version: b4500",
      ...extraSpecLines.map((line) => `  ${line}`),
    ].join("\n")}\n`,
    "utf8",
  );
}

function seamInfraList(): void {
  __setWorkloadTestSeams({
    getNodeClientByName: () =>
      ({
        infraList: { query: () => Promise.resolve([]) },
      }) as unknown as remoteMod.NodeClient,
    nodeQueryTimeoutMs: 1000,
  });
}

// Kills: runDescribeNodeRun not rendering spec.residency or spec.budget.
test("DN1: describe noderun renders explicit residency knobs and computed budget", async () => {
  writeNodeRun("nr1", ["residency:", "  minResidencySeconds: 300", "  switchCooldownSeconds: 60"]);
  seamInfraList();

  const { result, stdout } = await withCapturedIo(() => runDescribe(["noderun", "nr1"]));

  expect(result).toBe(0);
  expect(stdout).toContain(
    "Residency:  idleEvictSeconds 0 (default), minResidencySeconds 300, switchCooldownSeconds 60, safetyMarginRatio 0.75 (default), residentPreference 0 (default), coldLoadPenaltyMs 0 (default)\n",
  );
  expect(stdout).toContain("Budget:     computed from node memory x safetyMarginRatio\n");
});

// Kills: skipping the line when residency is absent, or printing only the knobs that are set.
test("DN2: describe noderun renders every default residency knob without a policy", async () => {
  writeNodeRun("nr1", []);
  seamInfraList();

  const { result, stdout } = await withCapturedIo(() => runDescribe(["noderun", "nr1"]));

  expect(result).toBe(0);
  expect(stdout).toContain(
    "Residency:  idleEvictSeconds 0 (default), minResidencySeconds 0 (default), switchCooldownSeconds 0 (default), safetyMarginRatio 0.75 (default), residentPreference 0 (default), coldLoadPenaltyMs 0 (default)\n",
  );
});

// Kills: an explicit budget being ignored, or a knob that is set being marked defaulted.
test("DN3: describe noderun renders an explicit budget and non-default safety margin", async () => {
  writeNodeRun("nr1", ["budget:", "  memoryGiB: 24", "residency:", "  safetyMarginRatio: 0.5"]);
  seamInfraList();

  const { result, stdout } = await withCapturedIo(() => runDescribe(["noderun", "nr1"]));

  expect(result).toBe(0);
  expect(stdout).toContain("Budget:     24.0 GiB (spec.budget.memoryGiB)\n");
  expect(stdout).toContain("safetyMarginRatio 0.5,");
  expect(stdout).not.toContain("safetyMarginRatio 0.5 (default)");
});

// Kills: the lines being rendered after LiveInfra, or not at all.
test("DN4: describe noderun renders budget and residency before infra", async () => {
  writeNodeRun("nr1", []);
  seamInfraList();

  const { result, stdout } = await withCapturedIo(() => runDescribe(["noderun", "nr1"]));

  expect(result).toBe(0);
  const nodeIndex = stdout.indexOf("Node:");
  const budgetIndex = stdout.indexOf("Budget:");
  const residencyIndex = stdout.indexOf("Residency:");
  const infraIndex = stdout.indexOf("Infra:");
  expect(nodeIndex).toBeGreaterThanOrEqual(0);
  expect(budgetIndex).toBeGreaterThanOrEqual(0);
  expect(residencyIndex).toBeGreaterThanOrEqual(0);
  expect(infraIndex).toBeGreaterThanOrEqual(0);
  expect(nodeIndex).toBeLessThan(budgetIndex);
  expect(budgetIndex).toBeLessThan(residencyIndex);
  expect(residencyIndex).toBeLessThan(infraIndex);
});

// Kills: the JSON payload omitting the resolved policy.
test("DN5: describe noderun --json includes the resolved effective policy", async () => {
  writeNodeRun("nr1", ["residency:", "  idleEvictSeconds: 600"]);
  seamInfraList();

  const { stdout } = await withCapturedIo(() => runDescribe(["noderun", "nr1", "--json"]));
  const parsed = JSON.parse(stdout) as {
    effectivePolicy?: {
      knobs?: { name: string; value: number; defaulted: boolean }[];
    };
    liveInfra?: unknown;
    manifest?: unknown;
  };

  expect(parsed.effectivePolicy).toBeDefined();
  expect(parsed.effectivePolicy?.knobs?.map((knob) => knob.name)).toEqual([
    "idleEvictSeconds",
    "minResidencySeconds",
    "switchCooldownSeconds",
    "safetyMarginRatio",
    "residentPreference",
    "coldLoadPenaltyMs",
  ]);
  expect(parsed.effectivePolicy?.knobs?.[0]).toEqual({
    defaulted: false,
    name: "idleEvictSeconds",
    value: 600,
  });
  expect(parsed.manifest).toMatchObject({ kind: "NodeRun", metadata: { name: "nr1" } });
  expect(parsed.liveInfra).toEqual([]);
});

// Kills: no shared formatter, or no exported resolver.
test("DN6: the shared formatter and exported resolver render defaults together", () => {
  expect(typeof formatResidencyKnobs).toBe("function");
  expect(typeof effectiveResidencyPolicy).toBe("function");
  if (
    typeof formatResidencyKnobs === "function" &&
    typeof effectiveResidencyPolicy === "function"
  ) {
    expect(formatResidencyKnobs(effectiveResidencyPolicy({ residentPreference: 2 }))).toBe(
      "idleEvictSeconds 0 (default), minResidencySeconds 0 (default), switchCooldownSeconds 0 (default), safetyMarginRatio 0.75 (default), residentPreference 2, coldLoadPenaltyMs 0 (default)",
    );
  }
});
