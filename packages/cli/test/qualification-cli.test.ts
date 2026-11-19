// RED tests for frozename/llamactl#518: the `llamactl qualification`
// operator surface over the node-local qualification-overrides.tsv.
// Every case spawns the real CLI through runCli against a temp runtime;
// the command does not exist on the base, so each case fails by
// assertion on exit code/stderr/stdout, never by import.
import { catalog, env, workloadRuntime } from "@llamactl/core";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readQualificationOverrides } from "../../core/src/qualification/overrides.js";
import { PromotionThresholdsSchema } from "../../core/src/qualification/promotion.js";
import { existsSync, writeFileSync } from "../src/safe-fs.js";
import {
  makeTempRuntime,
  parseJsonArray,
  parseJsonRecord,
  requireRecord,
  requireRecordField,
  runCli,
} from "./helpers.js";

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

describe("llamactl qualification (#518)", () => {
  let qual: QualRuntime;

  beforeEach(() => {
    qual = makeQualRuntime();
  });

  afterEach(() => {
    qual.cleanup();
  });

  test("pin writes the (rel, pin) row and routing sees the pinned stage", () => {
    const { exp } = qualFixtures();
    const r = runCli(
      ["qualification", "pin", exp, "production", "--reason", "w4 bench", "--author", "ops"],
      qual.env,
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Unknown command");
    expect(r.stdout).toContain(`pinned ${exp} at production`);

    const rows = readQualificationOverrides(qual.overridesFile);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.rel).toBe(exp);
    expect(row.action).toBe("pin");
    expect(row.stage).toBe("production");
    expect(row.author).toBe("ops");
    expect(row.reason).toBe("w4 bench");
    expect(row.updated_at.length).toBeGreaterThan(0);
    expect(routingStages(qual.env).get(exp)).toBe("production");
  });

  test("pin replaces the existing row for the same rel and action", () => {
    const { exp } = qualFixtures();
    const first = runCli(
      ["qualification", "pin", exp, "candidate", "--reason", "r1", "--author", "ops"],
      qual.env,
    );
    expect(first.code).toBe(0);
    const second = runCli(
      ["qualification", "pin", exp, "validated", "--reason", "r2", "--author", "ops"],
      qual.env,
    );
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("Unknown command");

    const rows = readQualificationOverrides(qual.overridesFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rel).toBe(exp);
    expect(rows[0]!.action).toBe("pin");
    expect(rows[0]!.stage).toBe("validated");
  });

  test("pin rejects an unknown stage without writing", () => {
    const { plain } = qualFixtures();
    const r = runCli(["qualification", "pin", plain, "bogus", "--reason", "x"], qual.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "qualification pin: unknown stage 'bogus' (expected experimental | candidate | validated | production | degraded)",
    );
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  test("pin requires --reason", () => {
    const { plain } = qualFixtures();
    const r = runCli(["qualification", "pin", plain, "candidate"], qual.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qualification pin: --reason is required");
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  test("pin rejects a reason containing a tab", () => {
    const { plain } = qualFixtures();
    const r = runCli(["qualification", "pin", plain, "candidate", "--reason", "a\tb"], qual.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("reason must not contain tabs or newlines");
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  test("freeze writes a stageless row and unfreeze removes the file", () => {
    const { plain } = qualFixtures();
    const f = runCli(
      ["qualification", "freeze", plain, "--reason", "hold", "--author", "ops"],
      qual.env,
    );
    expect(f.code).toBe(0);
    expect(f.stderr).not.toContain("Unknown command");
    expect(f.stdout).toContain(`froze ${plain}`);

    const rows = readQualificationOverrides(qual.overridesFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rel).toBe(plain);
    expect(rows[0]!.action).toBe("freeze");
    expect(rows[0]!.stage).toBe("");
    expect(routingStages(qual.env).has(plain)).toBe(false);

    const u = runCli(["qualification", "unfreeze", plain], qual.env);
    expect(u.code).toBe(0);
    expect(u.stderr).not.toContain("Unknown command");
    expect(u.stdout).toContain(`unfroze ${plain}`);
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  test("unpin removes only the pin row", () => {
    const { exp } = qualFixtures();
    writeFileSync(
      qual.overridesFile,
      `${exp}\tpin\tcandidate\tops\tr\t2026-01-01T00:00:00Z\n` +
        `${exp}\tfreeze\t\tops\thold\t2026-01-01T00:00:00Z\n`,
    );
    const r = runCli(["qualification", "unpin", exp], qual.env);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Unknown command");
    expect(r.stdout).toContain(`unpinned ${exp}`);

    const rows = readQualificationOverrides(qual.overridesFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rel).toBe(exp);
    expect(rows[0]!.action).toBe("freeze");
  });

  test("unpin fails when no pin override exists", () => {
    const { plain } = qualFixtures();
    const r = runCli(["qualification", "unpin", plain], qual.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`qualification unpin: no pin override for '${plain}'`);
  });

  test("status --json reports catalog stage, overrides, effective stage and routing stage", () => {
    const { exp } = qualFixtures();
    const pin = runCli(
      ["qualification", "pin", exp, "production", "--reason", "w4 bench", "--author", "ops"],
      qual.env,
    );
    expect(pin.code).toBe(0);

    const r = runCli(["qualification", "status", exp, "--json"], qual.env);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Unknown command");
    const parsed = parseJsonRecord(r.stdout);
    const pinView = requireRecordField(parsed, "pin");
    expect(typeof pinView["updated_at"]).toBe("string");
    const normalized: Record<string, unknown> = {
      ...parsed,
      pin: { ...pinView, updated_at: "<ts>" },
    };
    expect(normalized).toEqual({
      rel: exp,
      catalogStage: "experimental",
      pin: {
        stage: "production",
        author: "ops",
        reason: "w4 bench",
        updated_at: "<ts>",
      },
      freeze: null,
      effective: { stage: "production", source: "pin", baseStage: "production", degraded: false },
      routingStage: "production",
    });
    expect(parsed["routingStage"]).toBe(routingStages(qual.env).get(exp) ?? null);
  });

  test("status --json reports nulls for an unstaged rel; text mode prints unstaged", () => {
    const { plain } = qualFixtures();
    const r = runCli(["qualification", "status", plain, "--json"], qual.env);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Unknown command");
    expect(parseJsonRecord(r.stdout)).toEqual({
      rel: plain,
      catalogStage: null,
      pin: null,
      freeze: null,
      effective: null,
      routingStage: null,
    });

    const text = runCli(["qualification", "status", plain], qual.env);
    expect(text.code).toBe(0);
    expect(text.stderr).not.toContain("Unknown command");
    expect(text.stdout).toContain(`${plain}\tunstaged`);
  });

  test("list --json covers staged and override-only rels with routing parity", () => {
    const { exp, plain } = qualFixtures();
    const pin = runCli(
      ["qualification", "pin", exp, "production", "--reason", "w4 bench", "--author", "ops"],
      qual.env,
    );
    expect(pin.code).toBe(0);
    const freeze = runCli(
      ["qualification", "freeze", plain, "--reason", "hold", "--author", "ops"],
      qual.env,
    );
    expect(freeze.code).toBe(0);

    const r = runCli(["qualification", "list", "--json"], qual.env);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Unknown command");
    const entries = parseJsonArray(r.stdout).map(requireRecord);
    const stages = routingStages(qual.env);

    const expEntry = entries.find((entry) => entry["rel"] === exp);
    expect(expEntry, `list entry for ${exp}`).toBeDefined();
    expect(requireRecordField(expEntry!, "effective")).toMatchObject({ stage: "production" });
    const plainEntry = entries.find((entry) => entry["rel"] === plain);
    expect(plainEntry, `list entry for ${plain}`).toBeDefined();
    expect(plainEntry!["freeze"]).not.toBeNull();
    expect(plainEntry!["effective"]).toBeNull();

    for (const row of catalog.listCatalog("builtin")) {
      if (row.qualification?.stage !== "experimental") continue;
      expect(
        entries.some((entry) => entry["rel"] === row.rel),
        row.rel,
      ).toBe(true);
    }
    for (const entry of entries) {
      const rel = entry["rel"];
      expect(typeof rel).toBe("string");
      expect(entry["routingStage"]).toBe(stages.get(rel as string) ?? null);
    }
  });

  test("pin without LOCAL_AI_QUALIFICATION_OVERRIDES_FILE writes under the runtime dir", () => {
    const { exp } = qualFixtures();
    const childEnv: NodeJS.ProcessEnv = { ...qual.env };
    Reflect.deleteProperty(childEnv, OVERRIDES_FILE_ENV);
    const r = runCli(
      ["qualification", "pin", exp, "candidate", "--reason", "r", "--author", "ops"],
      childEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Unknown command");

    const target = join(qual.runtimeDir, "qualification-overrides.tsv");
    expect(existsSync(target)).toBe(true);
    const rows = readQualificationOverrides(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rel: exp, action: "pin", stage: "candidate" });
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  test("--node=<remote> refuses to write node-local overrides", () => {
    const { exp } = qualFixtures();
    const r = runCli(
      ["--node=gpu1", "qualification", "pin", exp, "candidate", "--reason", "r", "--author", "ops"],
      qual.env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qualification: overrides are node-local");
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  test("unknown subcommand fails", () => {
    const r = runCli(["qualification", "frob"], qual.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown qualification subcommand: frob");
  });
});

// ---------------------------------------------------------------------------
// #518 slice: read-only evidence-based `qualification propose`. Every case
// spawns the real CLI; on the base the subcommand does not exist, so each
// case fails by assertion on exit code/stdout/stderr, never by import.
// ---------------------------------------------------------------------------

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

describe("#518 qualification propose", () => {
  let qual: QualRuntime;

  beforeEach(() => {
    qual = makeQualRuntime();
  });

  afterEach(() => {
    qual.cleanup();
  });

  // Kills: dropping the propose case / wrong ladder target.
  test("propose reports a promotion proposal for a staged rel", () => {
    const { exp } = qualFixtures();
    const evidenceFile = writeJsonFile(qual.devStorage, "evidence.json", fullEvidence());
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const r = runCli(
      ["qualification", "propose", exp, "--evidence", evidenceFile, "--policy", policyFile],
      qual.env,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`proposal ${exp} experimental -> candidate`);
  });

  // Kills: JSON shape drift / writing an override.
  test("propose --json reports rel, declared, decision and apply without writing", () => {
    const { exp } = qualFixtures();
    const evidenceFile = writeJsonFile(qual.devStorage, "evidence.json", fullEvidence());
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const r = runCli(
      [
        "qualification",
        "propose",
        exp,
        "--evidence",
        evidenceFile,
        "--policy",
        policyFile,
        "--json",
      ],
      qual.env,
    );
    expect(r.code).toBe(0);
    const parsed = parseJsonRecord(r.stdout);
    expect(parsed["rel"]).toBe(exp);
    expect(parsed["declared"]).toBe("experimental");
    const decision = requireRecordField(parsed, "decision");
    expect(decision["kind"]).toBe("proposal");
    const proposal = requireRecordField(decision, "proposal");
    expect(proposal["to"]).toBe("candidate");
    expect(proposal["evidenceRef"]).toBe("eval://run-1");
    const apply = requireRecordField(parsed, "apply");
    expect(apply["status"]).toBe("proposed");
    expect(existsSync(qual.overridesFile)).toBe(false);
  });

  // Kills: injecting a writer into applyQualification.
  test("propose honors autoApply only as a gate — still proposed, still read-only", () => {
    const { exp } = qualFixtures();
    const evidenceFile = writeJsonFile(qual.devStorage, "evidence.json", fullEvidence());
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
      autoApply: true,
    });
    const r = runCli(
      [
        "qualification",
        "propose",
        exp,
        "--evidence",
        evidenceFile,
        "--policy",
        policyFile,
        "--json",
      ],
      qual.env,
    );
    expect(r.code).toBe(0);
    const apply = requireRecordField(parseJsonRecord(r.stdout), "apply");
    expect(apply["status"]).toBe("proposed");
    expect(existsSync(qual.overridesFile)).toBe(false);
    expect(existsSync(qual.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] ?? "")).toBe(false);
  });

  // Kills: dropping the failed list.
  test("propose reports below-threshold with the failed metrics", () => {
    const { exp } = qualFixtures();
    const evidenceFile = writeJsonFile(
      qual.devStorage,
      "evidence.json",
      fullEvidence({ toolCallCorrectness: 0.5 }),
    );
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const args = [
      "qualification",
      "propose",
      exp,
      "--evidence",
      evidenceFile,
      "--policy",
      policyFile,
    ];
    const r = runCli(args, qual.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("below-threshold");
    expect(r.stdout).toContain("toolCallCorrectness");

    const j = runCli([...args, "--json"], qual.env);
    expect(j.code).toBe(0);
    const decision = requireRecordField(parseJsonRecord(j.stdout), "decision");
    expect(decision["reason"]).toBe("below-threshold");
    const failed = decision["failed"];
    expect(Array.isArray(failed) && failed.includes("toolCallCorrectness")).toBe(true);
  });

  // Kills: not passing overridesFor(...) from the shared overrides file.
  test("propose reports frozen when a freeze override exists", () => {
    const { exp } = qualFixtures();
    const freeze = runCli(["qualification", "freeze", exp, "--reason", "r"], qual.env);
    expect(freeze.code).toBe(0);
    const evidenceFile = writeJsonFile(qual.devStorage, "evidence.json", fullEvidence());
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const args = [
      "qualification",
      "propose",
      exp,
      "--evidence",
      evidenceFile,
      "--policy",
      policyFile,
    ];
    const j = runCli([...args, "--json"], qual.env);
    expect(j.code).toBe(0);
    const decision = requireRecordField(parseJsonRecord(j.stdout), "decision");
    expect(decision["reason"]).toBe("frozen");

    const r = runCli(args, qual.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("frozen");
  });

  // Kills: calling proposePromotion instead of evaluateQualification.
  test("propose demotes a production rel past a demotion floor", () => {
    const catalogFile = qual.env["LOCAL_AI_CUSTOM_CATALOG_FILE"]!;
    writeFileSync(
      catalogFile,
      "prod-model\tProd test\tprod\tcustom\tcustom\tprod/model.gguf\torg/prod-model\tgguf\t" +
        '{"qualification":{"stage":"production"}}\n',
    );
    const evidenceFile = writeJsonFile(
      qual.devStorage,
      "evidence.json",
      fullEvidence({ runtimeReliability: 0.5 }),
    );
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: {},
      demotion: { minEvaluatedTasks: 20, minRuntimeReliability: 0.9 },
    });
    const args = [
      "qualification",
      "propose",
      "prod/model.gguf",
      "--evidence",
      evidenceFile,
      "--policy",
      policyFile,
    ];
    const r = runCli(args, qual.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("demotion prod/model.gguf production -> degraded");
    expect(r.stdout).toContain("runtimeReliability");

    const j = runCli([...args, "--json"], qual.env);
    expect(j.code).toBe(0);
    const decision = requireRecordField(parseJsonRecord(j.stdout), "decision");
    expect(decision["kind"]).toBe("demotion");
  });

  // Kills: defaulting an unstaged rel to a stage.
  test("propose refuses a rel with no qualification stage", () => {
    const { plain } = qualFixtures();
    const evidenceFile = writeJsonFile(qual.devStorage, "evidence.json", fullEvidence());
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const r = runCli(
      ["qualification", "propose", plain, "--evidence", evidenceFile, "--policy", policyFile],
      qual.env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`qualification propose: '${plain}' has no qualification stage`);
  });

  // Kills: skipping flag validation.
  test("propose requires --evidence and --policy", () => {
    const { exp } = qualFixtures();
    const evidenceFile = writeJsonFile(qual.devStorage, "evidence.json", fullEvidence());
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const noEvidence = runCli(["qualification", "propose", exp, "--policy", policyFile], qual.env);
    expect(noEvidence.code).toBe(1);
    expect(noEvidence.stderr).toContain("qualification propose: --evidence is required");

    const noPolicy = runCli(
      ["qualification", "propose", exp, "--evidence", evidenceFile],
      qual.env,
    );
    expect(noPolicy.code).toBe(1);
    expect(noPolicy.stderr).toContain("qualification propose: --policy is required");
  });

  // Kills: a non-strict PromotionEvidenceSchema.
  test("propose rejects evidence with an unrecognized key", () => {
    const { exp } = qualFixtures();
    const typo = fullEvidence();
    delete typo["toolCallCorrectness"];
    typo["toolCallCorectness"] = 0.95;
    const evidenceFile = writeJsonFile(qual.devStorage, "evidence.json", typo);
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const r = runCli(
      ["qualification", "propose", exp, "--evidence", evidenceFile, "--policy", policyFile],
      qual.env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qualification propose: ");
    expect(r.stderr).toMatch(/toolCallCorectness|Unrecognized key/);
  });

  // Kills: an unguarded read.
  test("propose reports an unreadable evidence file", () => {
    const { exp } = qualFixtures();
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const r = runCli(
      [
        "qualification",
        "propose",
        exp,
        "--evidence",
        join(qual.devStorage, "absent-evidence.json"),
        "--policy",
        policyFile,
      ],
      qual.env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qualification propose: cannot read evidence file");
  });
});

// ---------------------------------------------------------------------------
// Part of #518: boundary review of `qualification propose` — pin-stage
// fallback, pin rows reaching evaluateQualification, policy/evidence
// validation and the read-error paths. Each case names the mutation it kills.
// ---------------------------------------------------------------------------
describe("#518 qualification propose boundaries", () => {
  let qual: QualRuntime;

  beforeEach(() => {
    qual = makeQualRuntime();
  });

  afterEach(() => {
    qual.cleanup();
  });

  function propose(
    rel: string,
    evidence: unknown,
    policy: unknown,
    json = false,
  ): ReturnType<typeof runCli> {
    const evidenceFile = writeJsonFile(qual.devStorage, "evidence.json", evidence);
    const policyFile = writeJsonFile(qual.devStorage, "policy.json", policy);
    const args = [
      "qualification",
      "propose",
      rel,
      "--evidence",
      evidenceFile,
      "--policy",
      policyFile,
    ];
    return runCli(json ? [...args, "--json"] : args, qual.env);
  }

  // Kills: removing `?? pinStage` from the declared-stage resolution (an
  // uncatalogued pinned rel would exit 1 'has no qualification stage').
  test("an uncatalogued rel with a pin override reports none: pinned", () => {
    const { plain } = qualFixtures();
    const pin = runCli(["qualification", "pin", plain, "candidate", "--reason", "r"], qual.env);
    expect(pin.code).toBe(0);
    const policy = { thresholds: { validated: thresholds() } };
    const r = propose(plain, fullEvidence(), policy);
    expect(r.stderr).not.toContain("has no qualification stage");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`none ${plain}: pinned`);

    const j = propose(plain, fullEvidence(), policy, true);
    expect(j.code).toBe(0);
    const parsed = parseJsonRecord(j.stdout);
    expect(parsed["declared"]).toBe("candidate");
    expect(requireRecordField(parsed, "decision")["reason"]).toBe("pinned");
  });

  // Kills: swapping the operands to `pinStage ?? catalogStage` (the pin
  // stage would win over the catalog stage in `declared`).
  test("the catalog stage wins over the pin stage in declared", () => {
    const { exp } = qualFixtures();
    const pin = runCli(["qualification", "pin", exp, "production", "--reason", "r"], qual.env);
    expect(pin.code).toBe(0);
    const j = propose(exp, fullEvidence(), { thresholds: { candidate: thresholds() } }, true);
    expect(j.code).toBe(0);
    expect(parseJsonRecord(j.stdout)["declared"]).toBe("experimental");
  });

  // Kills: passing only the freeze row (not the pin row) to
  // evaluateQualification — a pinned rel with passing evidence would get a
  // promotion proposal.
  test("a pinned catalog rel gets no promotion proposal", () => {
    const { exp } = qualFixtures();
    const control = propose(exp, fullEvidence(), { thresholds: { candidate: thresholds() } }, true);
    expect(requireRecordField(parseJsonRecord(control.stdout), "decision")["kind"]).toBe(
      "proposal",
    );
    const pin = runCli(["qualification", "pin", exp, "candidate", "--reason", "r"], qual.env);
    expect(pin.code).toBe(0);
    const j = propose(exp, fullEvidence(), { thresholds: { candidate: thresholds() } }, true);
    expect(j.code).toBe(0);
    const decision = requireRecordField(parseJsonRecord(j.stdout), "decision");
    expect(decision["kind"]).toBe("none");
    expect(decision["reason"]).toBe("pinned");
  });

  // Kills: passing only the freeze row to evaluateQualification — a pinned
  // production rel past a demotion floor would get a demotion proposal.
  test("a pinned production rel gets no demotion proposal", () => {
    const catalogFile = qual.env["LOCAL_AI_CUSTOM_CATALOG_FILE"]!;
    writeFileSync(
      catalogFile,
      "prod-model\tProd test\tprod\tcustom\tcustom\tprod/model.gguf\torg/prod-model\tgguf\t" +
        '{"qualification":{"stage":"production"}}\n',
    );
    const rel = "prod/model.gguf";
    const policy = {
      thresholds: {},
      demotion: { minEvaluatedTasks: 20, minRuntimeReliability: 0.9 },
    };
    const evidence = fullEvidence({ runtimeReliability: 0.5 });
    const pin = runCli(["qualification", "pin", rel, "production", "--reason", "r"], qual.env);
    expect(pin.code).toBe(0);
    const j = propose(rel, evidence, policy, true);
    expect(j.code).toBe(0);
    const decision = requireRecordField(parseJsonRecord(j.stdout), "decision");
    expect(decision["kind"]).toBe("none");
    expect(decision["reason"]).toBe("pinned");
  });

  // Kills: replacing PromotionPolicySchema.parse with a cast — with no
  // thresholds the decision is `none`, so applyQualification never parses
  // the policy and the bad autoApply would go unreported (exit 0).
  test("an invalid policy file is refused with a clean error", () => {
    const { exp } = qualFixtures();
    const r = propose(exp, fullEvidence(), { thresholds: {}, autoApply: "yes" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qualification propose: invalid policy file '");
    expect(r.stderr).toContain("autoApply: ");
    expect(r.stderr).not.toContain("    at ");
    expect(r.stdout).toBe("");
  });

  // Kills: dropping .strict() from PromotionPolicySchema (the typo key
  // would be stripped and autoApply silently default to false).
  test("a policy with a typo key such as autoapply is refused", () => {
    const { exp } = qualFixtures();
    const r = propose(exp, fullEvidence(), {
      thresholds: { candidate: thresholds() },
      autoapply: true,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qualification propose: invalid policy file '");
    expect(r.stderr).toContain("autoapply");
    expect(r.stdout).toBe("");
  });

  // Kills: leaving evidence ratio metrics unbounded (95 would pass a 0.8
  // floor and yield a proposal).
  test("percent-scaled evidence is refused", () => {
    const { exp } = qualFixtures();
    const r = propose(exp, fullEvidence({ toolCallCorrectness: 95 }), {
      thresholds: { candidate: thresholds() },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("qualification propose: invalid evidence file '");
    expect(r.stderr).toContain("toolCallCorrectness: ");
    expect(r.stdout).not.toContain("proposal");
  });

  // Kills: removing readJsonFile's JSON.parse try/catch (the SyntaxError
  // would escape as an uncaught stack trace).
  test("a malformed JSON evidence or policy file is reported cleanly", () => {
    const { exp } = qualFixtures();
    const goodEvidence = writeJsonFile(qual.devStorage, "evidence.json", fullEvidence());
    const goodPolicy = writeJsonFile(qual.devStorage, "policy.json", {
      thresholds: { candidate: thresholds() },
    });
    const bad = join(qual.devStorage, "bad.json");
    writeFileSync(bad, "{not json\n");

    const e = runCli(
      ["qualification", "propose", exp, "--evidence", bad, "--policy", goodPolicy],
      qual.env,
    );
    expect(e.code).toBe(1);
    expect(e.stderr).toContain(`qualification propose: invalid JSON in evidence file '${bad}'`);

    const p = runCli(
      ["qualification", "propose", exp, "--evidence", goodEvidence, "--policy", bad],
      qual.env,
    );
    expect(p.code).toBe(1);
    expect(p.stderr).toContain(`qualification propose: invalid JSON in policy file '${bad}'`);
  });

  // Kills: dropping or rewording the text-mode apply line.
  test("text mode reports the apply status and that nothing was written", () => {
    const { exp } = qualFixtures();
    const r = propose(exp, fullEvidence(), { thresholds: { candidate: thresholds() } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("apply: proposed (nothing written; autoApply has no writer here)\n");
  });
});
