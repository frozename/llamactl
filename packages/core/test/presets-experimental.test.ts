// RED tests for frozename/llamactl#518 slice (a): preset promotion refuses
// experimental rels at the TS write surface. writePresetOverride is the
// core writer behind `llamactl catalog promote`, the promote tRPC
// procedure and the MCP/ops-chat promote tools, so the guard lives here
// and must consult catalogQualificationStages — catalog rows plus pin
// overrides plus the custom catalog — never raw BUILTIN_CATALOG stages.
// On the base there is no guard, so every refusal case fails by
// assertion (no throw / a written file), never by import.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BUILTIN_CATALOG } from "../src/catalog.js";
import { resolveEnv } from "../src/env.js";
import { readPresetOverrides, writePresetOverride } from "../src/presets.js";
import {
  qualificationOverridesFileFor,
  writeQualificationOverride,
} from "../src/qualification/overrides.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const QUAL_OVERRIDES_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";

// The refusal text every #518 preset-promotion surface must carry.
const REFUSAL =
  "is experimental (#518): experimental models are served only on an exact model pin and never as a preset default";

const EXP_REL = BUILTIN_CATALOG.find((row) => row.qualification?.stage === "experimental")?.rel;
const PLAIN_REL = BUILTIN_CATALOG.find((row) => row.qualification === undefined)?.rel;

function requireRel(rel: string | undefined, label: string): string {
  expect(rel, label).toBeDefined();
  return rel!;
}

describe("#518 preset promotion refuses experimental rels", () => {
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

  test("refuses an experimental rel and leaves the overrides file byte-identical", () => {
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    const plainRel = requireRel(PLAIN_REL, "builtin catalog has an unqualified rel");
    writePresetOverride("macbook-pro-48g", "fast", plainRel, env);
    const before = readFileSync(presetFile(), "utf8");
    expect(() => {
      writePresetOverride("macbook-pro-48g", "best", expRel, env);
    }).toThrow(/is experimental \(#518\).*never as a preset default/);
    expect(readFileSync(presetFile(), "utf8")).toBe(before);
  });

  test("refusal with no overrides file leaves the file absent", () => {
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    expect(() => {
      writePresetOverride("macbook-pro-48g", "best", expRel, env);
    }).toThrow(REFUSAL);
    expect(existsSync(presetFile())).toBe(false);
  });

  test("a validated pin override lets the same rel promote", () => {
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    expect(() => {
      writePresetOverride("macbook-pro-48g", "best", expRel, env);
    }).toThrow(REFUSAL);

    writeQualificationOverride(qualificationOverridesFileFor(resolveEnv(env)), {
      rel: expRel,
      action: "pin",
      stage: "validated",
      author: "ops",
      reason: "w4 passed",
    });

    writePresetOverride("macbook-pro-48g", "best", expRel, env);
    const rows = readPresetOverrides(presetFile());
    expect(rows.some((row) => row.rel === expRel && row.preset === "best")).toBe(true);
  });

  test("a custom-catalog experimental rel is refused; a plain custom rel is accepted", () => {
    const catalogFile = env["LOCAL_AI_CUSTOM_CATALOG_FILE"]!;
    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(
      catalogFile,
      [
        'exp-custom\tExp Custom\tcustomfam\tcustom\tcandidate\texp-custom/model.gguf\torg/exp-custom\tgguf\t{"qualification":{"stage":"experimental"}}',
        "plain-custom\tPlain Custom\tcustomfam\tcustom\tcandidate\tplain-custom/model.gguf\torg/plain-custom\tgguf",
        "",
      ].join("\n"),
    );

    expect(() => {
      writePresetOverride("macbook-pro-48g", "best", "exp-custom/model.gguf", env);
    }).toThrow(REFUSAL);

    writePresetOverride("macbook-pro-48g", "best", "plain-custom/model.gguf", env);
    const rows = readPresetOverrides(presetFile());
    expect(rows.some((row) => row.rel === "plain-custom/model.gguf")).toBe(true);
  });
});
