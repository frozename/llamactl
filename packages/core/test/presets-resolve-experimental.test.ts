// RED tests for frozename/llamactl#518 slice (b): preset resolution skips
// experimental rels on the read path. resolvePreset must consult
// catalogQualificationStages — builtin rows, custom rows and pin overrides —
// and fall through env → file → builtin, recording each skipped override on
// `skippedExperimental`. On the base there is no read-path guard, so every
// case fails by assertion (wrong rel/source or a missing skippedExperimental
// entry), never by import or type error: the field does not exist on the
// base PresetResolution, so it is read through a structural cast.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BUILTIN_CATALOG } from "../src/catalog.js";
import { resolveEnv } from "../src/env.js";
import { resolvePreset, writePresetOverride } from "../src/presets.js";
import {
  qualificationOverridesFileFor,
  writeQualificationOverride,
} from "../src/qualification/overrides.js";
import { recommendationsForProfile } from "../src/recommendations.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { resolveTarget } from "../src/target.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const QUAL_OVERRIDES_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";

const EXP_REL = BUILTIN_CATALOG.find((row) => row.qualification?.stage === "experimental")?.rel;
const BUILTIN_BEST = "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf";

function requireRel(rel: string | undefined, label: string): string {
  expect(rel, label).toBeDefined();
  return rel!;
}

// `skippedExperimental` lands on PresetResolution with the #518 read-path
// guard; the structural read keeps this file typechecking on the base,
// where the field does not exist yet.
function skippedExperimental(res: unknown): unknown {
  return (res as { skippedExperimental?: unknown }).skippedExperimental;
}

describe("#518 preset resolution skips experimental rels", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let env: NodeJS.ProcessEnv;
  let savedQualEnv: string | undefined;

  beforeEach(() => {
    temp = makeTempRuntime();
    env = envForTemp(temp);
    // qualificationOverridesFileFor reads LOCAL_AI_QUALIFICATION_OVERRIDES_FILE
    // from process.env (it is not a ResolvedEnv key) — delete it so the
    // runtime-dir fallback is deterministic inside the temp tree.
    savedQualEnv = process.env[QUAL_OVERRIDES_ENV];
    Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
  });

  afterEach(() => {
    if (savedQualEnv === undefined) Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
    else process.env[QUAL_OVERRIDES_ENV] = savedQualEnv;
    temp.cleanup();
  });

  const presetFile = (): string => env["LOCAL_AI_PRESET_OVERRIDES_FILE"]!;

  // Bypass writePresetOverride — the writer refuses experimental rels, but a
  // stale row written before the guard (or by hand) must still be skipped on
  // the read path.
  function writeStaleRow(profile: string, preset: string, rel: string): void {
    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(presetFile(), `${profile}\t${preset}\t${rel}\t2026-01-01T00:00:00+0000\n`);
  }

  test("a stale file override naming an experimental rel falls back to the builtin default", () => {
    // Kills: no read-path guard in resolvePreset (the base returns EXP_REL/'file').
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    writeStaleRow("macbook-pro-48g", "best", expRel);
    const res = resolvePreset("macbook-pro-48g", "best", env);
    expect(res.rel).toBe(BUILTIN_BEST);
    expect(res.source).toBeNull();
    expect(skippedExperimental(res)).toEqual([{ source: "file", rel: expRel }]);
  });

  test("a pin to experimental after promotion removes the rel from the preset default; a validated pin keeps it", () => {
    // Kills: a guard that reads raw BUILTIN_CATALOG/custom-catalog stages
    // instead of catalogQualificationStages (pin rows ignored).
    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(
      env["LOCAL_AI_CUSTOM_CATALOG_FILE"]!,
      "plain-custom\tPlain Custom\tcustomfam\tcustom\tcandidate\tplain-custom/model.gguf\torg/plain-custom\tgguf\n",
    );

    writePresetOverride("macbook-pro-48g", "best", "plain-custom/model.gguf", env);
    const promoted = resolvePreset("macbook-pro-48g", "best", env);
    expect(promoted.rel).toBe("plain-custom/model.gguf");
    expect(promoted.source).toBe("file");

    writeQualificationOverride(qualificationOverridesFileFor(resolveEnv(env)), {
      rel: "plain-custom/model.gguf",
      action: "pin",
      stage: "experimental",
      author: "ops",
      reason: "regressed",
    });
    const skipped = resolvePreset("macbook-pro-48g", "best", env);
    expect(skipped.rel).toBe(BUILTIN_BEST);
    expect(skipped.source).toBeNull();

    writeQualificationOverride(qualificationOverridesFileFor(resolveEnv(env)), {
      rel: "plain-custom/model.gguf",
      action: "pin",
      stage: "validated",
      author: "ops",
      reason: "recovered",
    });
    const kept = resolvePreset("macbook-pro-48g", "best", env);
    expect(kept.rel).toBe("plain-custom/model.gguf");
    expect(kept.source).toBe("file");
  });

  test("a validated pin lifts the read-path skip", () => {
    // Kills: an over-broad guard keyed on the raw builtin stage.
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    writeStaleRow("macbook-pro-48g", "best", expRel);

    // RED half: the base returns expRel/'file' here.
    const before = resolvePreset("macbook-pro-48g", "best", env);
    expect(before.rel).toBe(BUILTIN_BEST);
    expect(before.source).toBeNull();

    writeQualificationOverride(qualificationOverridesFileFor(resolveEnv(env)), {
      rel: expRel,
      action: "pin",
      stage: "validated",
      author: "ops",
      reason: "w4 passed",
    });
    const after = resolvePreset("macbook-pro-48g", "best", env);
    expect(after.rel).toBe(expRel);
    expect(after.source).toBe("file");
    expect(skippedExperimental(after)).toBeUndefined();
  });

  test("an experimental env override falls through to the file layer, not straight to the builtin", () => {
    // Kills: an unguarded env layer (the base returns EXP_REL/'env'), and a
    // guard that jumps from env straight to builtin.
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    writeStaleRow("macbook-pro-48g", "best", "kept/row.gguf");
    const envExp: NodeJS.ProcessEnv = {
      ...env,
      LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL: expRel,
    };
    const res = resolvePreset("macbook-pro-48g", "best", envExp);
    expect(res.rel).toBe("kept/row.gguf");
    expect(res.source).toBe("file");
    expect(skippedExperimental(res)).toEqual([{ source: "env", rel: expRel }]);
  });

  test("both layers experimental report both skips in layer order", () => {
    // Kills: recording only the first skip, or the file layer left unguarded
    // once env is skipped.
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    writeStaleRow("macbook-pro-48g", "best", expRel);
    const envExp: NodeJS.ProcessEnv = {
      ...env,
      LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL: expRel,
    };
    const res = resolvePreset("macbook-pro-48g", "best", envExp);
    expect(res.rel).toBe(BUILTIN_BEST);
    expect(res.source).toBeNull();
    expect(skippedExperimental(res)).toEqual([
      { source: "env", rel: expRel },
      { source: "file", rel: expRel },
    ]);
  });

  test('resolveTarget("best") (server start / keepAlive / bench / workload apply) never resolves a stale experimental override', () => {
    // Kills: a guard placed only in recommendations rather than in resolvePreset.
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    writeStaleRow("macbook-pro-48g", "best", expRel);
    expect(resolveTarget("best", env)).toBe(BUILTIN_BEST);
    expect(resolveTarget("quality", env)).toBe(BUILTIN_BEST);
  });

  test("recommendationsForProfile reports the builtin row, not the stale experimental promotion", () => {
    // Kills: the same missing guard, reached through the recommendations surface.
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    writeStaleRow("macbook-pro-48g", "best", expRel);
    const row = recommendationsForProfile("macbook-pro-48g", env).find((r) => r.target === "best");
    expect(row?.rel).toBe(BUILTIN_BEST);
    expect(row?.promoted).toBeNull();
  });
});
