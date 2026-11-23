// RED tests for frozename/llamactl#518: `llamactl qualification apply`
// and `unapply` — the writer path behind applyQualification. Every case
// spawns the real CLI against a temp runtime; the subcommands do not
// exist on the base, so each case fails by assertion on exit code,
// stdout or stderr, never by import.
import { catalog, env, workloadRuntime } from "@llamactl/core";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readQualificationOverrides } from "../../core/src/qualification/overrides.js";
import { PromotionThresholdsSchema } from "../../core/src/qualification/promotion.js";
import { existsSync, readFileSync, writeFileSync } from "../src/safe-fs.js";
import { makeTempRuntime, parseJsonRecord, requireRecordField, runCli } from "./helpers.js";

const OVERRIDES_FILE_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";
const RUNTIME_DIR_ENV = "LOCAL_AI_RUNTIME_DIR";

interface QualRuntime {
  env: NodeJS.ProcessEnv;
  devStorage: string;
  runtimeDir: string;
  overridesFile: string;
  cleanup: () => void;
}

function makeQualRuntime(): QualRuntime {
  const temp = makeTempRuntime();
  const overridesFile = join(temp.devStorage, "q.tsv");
  const childEnv: NodeJS.ProcessEnv = {
    ...temp.env,
    HOME: temp.devStorage,
    LLAMACTL_CONFIG: join(temp.devStorage, "absent-config"),
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(temp.devStorage, "absent-custom-catalog.tsv"),
    [OVERRIDES_FILE_ENV]: overridesFile,
  };
  return {
    env: childEnv,
    devStorage: temp.devStorage,
    runtimeDir: temp.runtimeDir,
    overridesFile,
    cleanup: temp.cleanup,
  };
}

// qualificationOverridesFileFor reads LOCAL_AI_QUALIFICATION_OVERRIDES_FILE
// from process.env (it is not a ResolvedEnv key), so the parity check has
// to lend the child's values to this process for the duration of the call.
function routingStages(
  childEnv: NodeJS.ProcessEnv,
): ReturnType<typeof workloadRuntime.catalogQualificationStages> {
  const keys = [OVERRIDES_FILE_ENV, RUNTIME_DIR_ENV] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) {
    const value = childEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  try {
    return workloadRuntime.catalogQualificationStages(env.resolveEnv(childEnv));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

function qualFixtures(): { exp: string; plain: string } {
  const rows = catalog.listCatalog("builtin");
  const exp = rows.find((row) => row.qualification?.stage === "experimental")?.rel;
  const plain = rows.find((row) => row.qualification === undefined)?.rel;
  expect(exp, "builtin catalog has an experimental rel").toBeDefined();
  expect(plain, "builtin catalog has an unqualified rel").toBeDefined();
  return { exp: exp!, plain: plain! };
}

function fullEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evaluatedTasks: 50,
    evidenceRef: "eval://run-1",
    firstAttemptSuccess: 0.9,
    repairSuccess: 0.9,
    toolCallCorrectness: 0.95,
    structuredOutputValidity: 0.97,
    regression: 0.01,
    improvement: 0.05,
    memoryStability: 0.99,
    runtimeReliability: 0.99,
    ...overrides,
  };
}

function thresholds(): Record<string, number> {
  const floors: Record<string, number> = {};
  for (const key of Object.keys(PromotionThresholdsSchema.shape)) {
    if (key === "minEvaluatedTasks") floors[key] = 20;
    else if (key === "maxRegression") floors[key] = 0.05;
    else if (key === "minImprovement") floors[key] = 0;
    else floors[key] = 0.8;
  }
  return floors;
}

function writeJsonFile(dir: string, name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

function autoApplyPolicy(): Record<string, unknown> {
  return {
    thresholds: { candidate: thresholds(), validated: thresholds() },
    autoApply: true,
  };
}

describe("#518 qualification apply", () => {
  let qual: QualRuntime;

  beforeEach(() => {
    qual = makeQualRuntime();
  });

  afterEach(() => {
    qual.cleanup();
  });

  function inputs(
    evidence: unknown,
    policy: unknown,
  ): { evidenceFile: string; policyFile: string } {
    return {
      evidenceFile: writeJsonFile(qual.devStorage, "evidence.json", evidence),
      policyFile: writeJsonFile(qual.devStorage, "policy.json", policy),
    };
  }

  function applyRel(
    rel: string,
    evidenceFile: string,
    policyFile: string,
    extra: string[] = [],
  ): ReturnType<typeof runCli> {
    return runCli(
      ["qualification", "apply", rel, "--evidence", evidenceFile, "--policy", policyFile, ...extra],
      qual.env,
    );
  }

  // Kills: not injecting the writer into applyQualification.
  test("apply writes an applied row and routing sees the applied stage", () => {
    const { exp } = qualFixtures();
    const { evidenceFile, policyFile } = inputs(fullEvidence(), autoApplyPolicy());
    const r = applyRel(exp, evidenceFile, policyFile, ["--author", "ops"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`apply: applied ${exp} experimental -> candidate`);

    const rows = readQualificationOverrides(qual.overridesFile);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.rel).toBe(exp);
    expect(row.action as string).toBe("applied");
    expect(row.stage).toBe("candidate");
    expect(row.author).toBe("ops");
    expect(row.reason).toContain("experimental -> candidate");
    expect(row.reason).toContain("eval://run-1");
    expect(routingStages(qual.env).get(exp)).toBe("candidate");
  });

  // Kills: calling the writer without the autoApply gate.
  test("apply without autoApply proposes and writes nothing", () => {
    const { exp } = qualFixtures();
    const { evidenceFile, policyFile } = inputs(fullEvidence(), {
      thresholds: { candidate: thresholds(), validated: thresholds() },
    });
    const r = applyRel(exp, evidenceFile, policyFile);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("apply: proposed (nothing written; policy autoApply is off)");
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  // Kills: declared ignoring the applied row (catalog ?? pin only) and
  // the writer appending instead of replacing.
  test("a second apply climbs from the applied stage and replaces the row", () => {
    const { exp } = qualFixtures();
    const { evidenceFile, policyFile } = inputs(fullEvidence(), autoApplyPolicy());
    const first = applyRel(exp, evidenceFile, policyFile, ["--author", "ops"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`apply: applied ${exp} experimental -> candidate`);

    const second = applyRel(exp, evidenceFile, policyFile, ["--author", "ops"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`apply: applied ${exp} candidate -> validated`);

    const rows = readQualificationOverrides(qual.overridesFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action as string).toBe("applied");
    expect(rows[0]!.stage).toBe("validated");
  });

  // Kills: writing on a 'none' decision.
  test("apply on a pinned rel is skipped and leaves the file untouched", () => {
    const { exp } = qualFixtures();
    const pin = runCli(
      ["qualification", "pin", exp, "candidate", "--reason", "r", "--author", "ops"],
      qual.env,
    );
    expect(pin.code).toBe(0);
    const before = readFileSync(qual.overridesFile, "utf8");
    const { evidenceFile, policyFile } = inputs(fullEvidence(), autoApplyPolicy());
    const r = applyRel(exp, evidenceFile, policyFile);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`none ${exp}: pinned`);
    expect(r.stdout).toContain("apply: skipped (nothing written)");
    expect(readFileSync(qual.overridesFile, "utf8")).toBe(before);
  });

  // Kills: a writer that handles only PromotionProposal.
  test("apply records a demotion as an applied degraded row", () => {
    const { exp } = qualFixtures();
    writeFileSync(
      qual.overridesFile,
      `${exp}\tapplied\tproduction\tops\tseeded\t2026-01-01T00:00:00Z\n`,
    );
    const { evidenceFile, policyFile } = inputs(fullEvidence({ toolCallCorrectness: 0.5 }), {
      thresholds: { candidate: thresholds(), validated: thresholds() },
      demotion: { minEvaluatedTasks: 20, minToolCallCorrectness: 0.9 },
      autoApply: true,
    });
    const r = applyRel(exp, evidenceFile, policyFile);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`apply: applied ${exp} production -> degraded`);

    const rows = readQualificationOverrides(qual.overridesFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action as string).toBe("applied");
    expect(rows[0]!.stage).toBe("degraded");
  });

  // Kills: computeEffective/statusFor ignoring the applied row.
  test("status --json reports the applied row, effective and routing stages", () => {
    const { exp, plain } = qualFixtures();
    const { evidenceFile, policyFile } = inputs(fullEvidence(), autoApplyPolicy());
    const applied = applyRel(exp, evidenceFile, policyFile, ["--author", "ops"]);
    expect(applied.code).toBe(0);

    const r = runCli(["qualification", "status", exp, "--json"], qual.env);
    expect(r.code).toBe(0);
    const parsed = parseJsonRecord(r.stdout);
    const appliedView = requireRecordField(parsed, "applied");
    expect(appliedView["stage"]).toBe("candidate");
    expect(appliedView["author"]).toBe("ops");
    expect(requireRecordField(parsed, "effective")["stage"]).toBe("candidate");
    expect(parsed["routingStage"]).toBe("candidate");

    const plainStatus = runCli(["qualification", "status", plain, "--json"], qual.env);
    expect(plainStatus.code).toBe(0);
    expect("applied" in parseJsonRecord(plainStatus.stdout)).toBe(false);
  });

  // Kills: unapply deleting the wrong action.
  test("unapply removes the applied row and a second unapply fails", () => {
    const { exp } = qualFixtures();
    const { evidenceFile, policyFile } = inputs(fullEvidence(), autoApplyPolicy());
    const applied = applyRel(exp, evidenceFile, policyFile, ["--author", "ops"]);
    expect(applied.code).toBe(0);

    const u = runCli(["qualification", "unapply", exp], qual.env);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(`unapplied ${exp}`);
    expect(routingStages(qual.env).get(exp)).toBe("experimental");

    const again = runCli(["qualification", "unapply", exp], qual.env);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`qualification unapply: no applied stage for '${exp}'`);
  });

  // Kills: propose not sharing the applied-aware declared resolution, or
  // propose gaining the writer.
  test("propose climbs from the applied stage and stays read-only", () => {
    const { exp } = qualFixtures();
    const { evidenceFile, policyFile } = inputs(fullEvidence(), autoApplyPolicy());
    const applied = applyRel(exp, evidenceFile, policyFile, ["--author", "ops"]);
    expect(applied.code).toBe(0);
    const before = readFileSync(qual.overridesFile, "utf8");

    const p = runCli(
      ["qualification", "propose", exp, "--evidence", evidenceFile, "--policy", policyFile],
      qual.env,
    );
    expect(p.code).toBe(0);
    expect(p.stdout).toContain(`proposal ${exp} candidate -> validated`);
    expect(p.stdout).toContain("apply: proposed (nothing written; autoApply has no writer here)");
    expect(readFileSync(qual.overridesFile, "utf8")).toBe(before);
  });

  // Kills: the writer ZodError being caught as 'invalid policy' by
  // evaluateProposal, or escaping.
  test("apply reports an unwritable applied stage without a stack trace", () => {
    const { exp } = qualFixtures();
    const { evidenceFile, policyFile } = inputs(
      fullEvidence({ evidenceRef: "eval://a\tb" }),
      autoApplyPolicy(),
    );
    const r = applyRel(exp, evidenceFile, policyFile);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qualification apply: cannot record applied stage:");
    expect(r.stderr).not.toContain("invalid policy");
    expect(r.stderr).not.toContain("    at ");
    expect(existsSync(qual.overridesFile)).toBe(false);
  });
});
