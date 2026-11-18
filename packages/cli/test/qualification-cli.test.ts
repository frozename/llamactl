// RED tests for frozename/llamactl#518: the `llamactl qualification`
// operator surface over the node-local qualification-overrides.tsv.
// Every case spawns the real CLI through runCli against a temp runtime;
// the command does not exist on the base, so each case fails by
// assertion on exit code/stderr/stdout, never by import.
import { catalog, env, workloadRuntime } from "@llamactl/core";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readQualificationOverrides } from "../../core/src/qualification/overrides.js";
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
