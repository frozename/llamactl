// RED tests for frozename/llamactl#518 slice (a): `llamactl catalog
// promote` refuses an experimental rel at every preset slot. Each case
// spawns the real CLI through runCli against a temp runtime; on the
// base the promote succeeds (exit 0, 'Promoted'), so every case fails
// by assertion on code/stdout/stderr, never by import.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../src/safe-fs.js";
import { makeTempRuntime, runCli } from "./helpers.js";

const QUAL_OVERRIDES_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";

// The builtin GLM row staged experimental in packages/core/src/catalog.ts.
const EXP_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";

// The refusal text every #518 preset-promotion surface must carry.
const REFUSAL =
  "is experimental (#518): experimental models are served only on an exact model pin and never as a preset default";

describe("#518 catalog promote refuses experimental rels", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let savedQualEnv: string | undefined;

  beforeEach(() => {
    temp = makeTempRuntime();
    // The spawned CLI resolves LOCAL_AI_QUALIFICATION_OVERRIDES_FILE from
    // its own env (absent here → runtime-dir fallback); keep the parent
    // value saved/restored so the suite never leaks process state.
    savedQualEnv = process.env[QUAL_OVERRIDES_ENV];
    Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
  });

  afterEach(() => {
    if (savedQualEnv === undefined) Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
    else process.env[QUAL_OVERRIDES_ENV] = savedQualEnv;
    temp.cleanup();
  });

  const presetFile = (): string => join(temp.runtimeDir, "preset-overrides.tsv");

  test("catalog promote best <experimental rel> exits 1 with the refusal and writes nothing", () => {
    const r = runCli(["catalog", "promote", "macbook-pro-48g", "best", EXP_REL], temp.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`catalog promote: model '${EXP_REL}' is experimental (#518)`);
    expect(r.stderr).toContain(REFUSAL);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stdout).not.toContain("Promoted");
    expect(existsSync(presetFile())).toBe(false);
  });

  test("a validated pin lets the same rel promote afterwards", () => {
    const refused = runCli(["catalog", "promote", "macbook-pro-48g", "best", EXP_REL], temp.env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(REFUSAL);

    const pin = runCli(
      ["qualification", "pin", EXP_REL, "validated", "--reason", "w4 passed"],
      temp.env,
    );
    expect(pin.code).toBe(0);

    const r = runCli(["catalog", "promote", "macbook-pro-48g", "best", EXP_REL], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Promoted ${EXP_REL}`);
  });

  test("catalog promote vision refuses the same rel with the same stderr", () => {
    const r = runCli(["catalog", "promote", "macbook-pro-48g", "vision", EXP_REL], temp.env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`catalog promote: model '${EXP_REL}' is experimental (#518)`);
    expect(r.stderr).toContain(REFUSAL);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stdout).not.toContain("Promoted");
    expect(existsSync(presetFile())).toBe(false);
  });
});
