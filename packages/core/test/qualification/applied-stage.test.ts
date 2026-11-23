// RED tests for frozename/llamactl#518: the `applied` override action —
// the row `llamactl qualification apply` writes and `unapply` removes.
// At the base the action is not in the schema enum, the reader drops it
// and the stage resolver ignores it, so every case fails by assertion,
// never by import.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { QualificationOverride } from "../../src/qualification/overrides.js";

import { listCatalog } from "../../src/catalog.js";
import { resolveEnv } from "../../src/env.js";
import {
  deleteQualificationOverride,
  overridesFor,
  readQualificationOverrides,
  writeQualificationOverride,
} from "../../src/qualification/overrides.js";
import { readFileSync, writeFileSync } from "../../src/safe-fs.js";
import { catalogQualificationStages } from "../../src/workloadRuntime.js";
import { envForTemp, makeTempRuntime } from "../helpers.js";

const OVERRIDES_FILE_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";
const RUNTIME_DIR_ENV = "LOCAL_AI_RUNTIME_DIR";
const TS = "2026-11-23T00:00:00Z";

type NewOverride = Omit<QualificationOverride, "updated_at">;

// 'applied' is not in the action enum at the base; the cast admits the
// wire row the widened schema must accept.
const appliedRow = (rel: string, stage: string, reason: string): QualificationOverride =>
  ({
    rel,
    action: "applied",
    stage,
    author: "ops",
    reason,
    updated_at: TS,
  }) as unknown as QualificationOverride;

// qualificationOverridesFileFor reads LOCAL_AI_QUALIFICATION_OVERRIDES_FILE
// from process.env (it is not a ResolvedEnv key), so the stage read has to
// lend the child's values to this process for the duration of the call —
// the same pattern routingStages() uses in packages/cli/test/qualification-cli.test.ts.
function routingStages(childEnv: NodeJS.ProcessEnv): ReturnType<typeof catalogQualificationStages> {
  const keys = [OVERRIDES_FILE_ENV, RUNTIME_DIR_ENV] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) {
    const value = childEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  try {
    return catalogQualificationStages(resolveEnv(childEnv));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

describe("#518 applied qualification override", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let childEnv: NodeJS.ProcessEnv;
  let overridesFile: string;

  beforeEach(() => {
    temp = makeTempRuntime();
    overridesFile = join(temp.devStorage, "qualification-overrides.tsv");
    childEnv = {
      ...envForTemp(temp),
      [OVERRIDES_FILE_ENV]: overridesFile,
      // envForTemp already points LOCAL_AI_CUSTOM_CATALOG_FILE at a path
      // that does not exist, so the custom catalog contributes no rows.
    };
  });

  afterEach(() => {
    temp.cleanup();
  });

  // Kills: leaving 'applied' out of the action enum, or the reader dropping it.
  test("writeQualificationOverride accepts and round-trips an applied row", () => {
    const file = join(temp.devStorage, "overrides.tsv");
    const input = {
      rel: "m.gguf",
      action: "applied",
      stage: "candidate",
      author: "ops",
      reason: "applied experimental -> candidate",
    } as unknown as NewOverride;
    expect(() => writeQualificationOverride(file, input, TS)).not.toThrow();
    expect(readQualificationOverrides(file)).toEqual([
      {
        rel: "m.gguf",
        action: "applied",
        stage: "candidate",
        author: "ops",
        reason: "applied experimental -> candidate",
        updated_at: TS,
      } as unknown as QualificationOverride,
    ]);
  });

  // Kills: no non-empty-stage refine for applied.
  test("an applied row requires a non-empty stage", () => {
    const file = join(temp.devStorage, "overrides.tsv");
    expect(() =>
      writeQualificationOverride(file, appliedRow("m.gguf", "candidate", "seed"), TS),
    ).not.toThrow();
    const before = readFileSync(file, "utf8");
    expect(() =>
      writeQualificationOverride(file, appliedRow("m.gguf", "", "stageless"), TS),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  // Kills: the `else grouped.freeze = row` fallthrough at overrides.ts.
  test("overridesFor groups pin, freeze and applied rows per rel", () => {
    const rel = "m.gguf";
    const pinRow: QualificationOverride = {
      rel,
      action: "pin",
      stage: "validated",
      author: "ops",
      reason: "pin it",
      updated_at: TS,
    };
    const freezeRow: QualificationOverride = {
      rel,
      action: "freeze",
      stage: "",
      author: "ops",
      reason: "hold",
      updated_at: TS,
    };
    const applied = appliedRow(rel, "production", "applied validated -> production");
    type Grouped = ReturnType<typeof overridesFor> & { applied?: QualificationOverride };
    const grouped = overridesFor([pinRow, freezeRow, applied], rel) as Grouped;
    expect(grouped.pin).toBe(pinRow);
    expect(grouped.freeze).toBe(freezeRow);
    expect(grouped.applied).toBe(applied);

    const solo = overridesFor([applied], rel) as Grouped;
    expect(solo.applied).toBe(applied);
    expect(solo.pin).toBeUndefined();
    expect(solo.freeze).toBeUndefined();
  });

  // Kills: catalogQualificationStages ignoring applied rows.
  test("catalogQualificationStages applies an applied row's stage", () => {
    const rel = listCatalog("builtin").find(
      (row) => row.qualification?.stage === "experimental",
    )?.rel;
    expect(rel, "builtin catalog has an experimental rel").toBeDefined();
    const target = rel!;
    writeFileSync(
      overridesFile,
      `${target}\tapplied\tcandidate\tops\tapplied experimental -> candidate\t${TS}\n`,
    );
    expect(routingStages(childEnv).get(target)).toBe("candidate");
  });

  // Kills: single-pass last-row-wins ordering, which would let the applied
  // row beat a pin, and also ignoring applied rows.
  test("a pin wins over an applied row regardless of file order", () => {
    const rel = "ordered/model.gguf";
    writeFileSync(
      overridesFile,
      `${rel}\tpin\tvalidated\tops\tpin it\t${TS}\n` +
        `${rel}\tapplied\tproduction\tops\tapplied validated -> production\t${TS}\n`,
    );
    expect(routingStages(childEnv).get(rel)).toBe("validated");
    expect(deleteQualificationOverride(overridesFile, rel, "pin")).toBe(true);
    expect(routingStages(childEnv).get(rel)).toBe("production");
  });

  // Kills: a freeze row clearing the applied overlay.
  test("a freeze row does not clear the applied stage", () => {
    const rel = "frozen-applied/model.gguf";
    writeFileSync(
      overridesFile,
      `${rel}\tfreeze\t\tops\thold\t${TS}\n` +
        `${rel}\tapplied\tcandidate\tops\tapplied experimental -> candidate\t${TS}\n`,
    );
    expect(routingStages(childEnv).get(rel)).toBe("candidate");
  });
});
