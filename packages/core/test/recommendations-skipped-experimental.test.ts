// RED tests for frozename/llamactl#518: recommendationsForProfile must copy
// resolvePreset's skippedExperimental audit trail onto the preset rows.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BUILTIN_CATALOG } from "../src/catalog.js";
import { recommendationsForProfile } from "../src/recommendations.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const QUAL_OVERRIDES_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";
const EXP_REL = BUILTIN_CATALOG.find((row) => row.qualification?.stage === "experimental")?.rel;
const BUILTIN_BEST = "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf";
const NON_EXP_REL = BUILTIN_CATALOG.find(
  (row) => row.qualification?.stage !== "experimental" && row.rel !== BUILTIN_BEST,
)?.rel;

function requireRel(rel: string | undefined, label: string): string {
  expect(rel, label).toBeDefined();
  return rel!;
}

function skippedExperimental(row: unknown): unknown {
  return (row as { skippedExperimental?: unknown }).skippedExperimental;
}

describe("#518 recommendations copy skippedExperimental", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let env: NodeJS.ProcessEnv;
  let savedQualEnv: string | undefined;

  beforeEach(() => {
    temp = makeTempRuntime();
    env = envForTemp(temp);
    savedQualEnv = process.env[QUAL_OVERRIDES_ENV];
    Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
  });

  afterEach(() => {
    if (savedQualEnv === undefined) Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
    else process.env[QUAL_OVERRIDES_ENV] = savedQualEnv;
    temp.cleanup();
  });

  function writeStaleRow(profile: string, preset: string, rel: string): void {
    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(
      env["LOCAL_AI_PRESET_OVERRIDES_FILE"]!,
      `${profile}\t${preset}\t${rel}\t2026-01-01T00:00:00+0000\n`,
    );
  }

  function bestRow(envArg: NodeJS.ProcessEnv = env): unknown {
    const row = recommendationsForProfile("macbook-pro-48g", envArg).find(
      (candidate) => candidate.target === "best",
    );
    expect(row).toBeDefined();
    return row!;
  }

  test("a stale file override naming an experimental rel is reported on the builtin row", () => {
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    writeStaleRow("macbook-pro-48g", "best", expRel);
    const row = bestRow() as { rel: string; promoted: unknown };
    expect(row.rel).toBe(BUILTIN_BEST);
    expect(row.promoted).toBeNull();
    expect(skippedExperimental(row)).toEqual([{ source: "file", rel: expRel }]);
  });

  test("an experimental env override is reported when resolution falls back to the builtin", () => {
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    const envExp: NodeJS.ProcessEnv = {
      ...env,
      LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL: expRel,
    };
    const row = bestRow(envExp) as { promoted: unknown };
    expect(row.promoted).toBeNull();
    expect(skippedExperimental(row)).toEqual([{ source: "env", rel: expRel }]);
  });

  test("an experimental env override falling through to a file promotion is still reported", () => {
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    const nonExpRel = requireRel(NON_EXP_REL, "builtin catalog has a non-experimental rel");
    writeStaleRow("macbook-pro-48g", "best", nonExpRel);
    const envExp: NodeJS.ProcessEnv = {
      ...env,
      LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL: expRel,
    };
    const row = bestRow(envExp) as { rel: string; promoted: unknown };
    expect(row.rel).toBe(nonExpRel);
    expect(row.promoted).toBe("file");
    expect(skippedExperimental(row)).toEqual([{ source: "env", rel: expRel }]);
  });

  test("experimental env and file overrides report both skips in layer order", () => {
    const expRel = requireRel(EXP_REL, "builtin catalog has an experimental rel");
    writeStaleRow("macbook-pro-48g", "best", expRel);
    const envExp: NodeJS.ProcessEnv = {
      ...env,
      LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL: expRel,
    };
    const row = bestRow(envExp);
    expect(skippedExperimental(row)).toEqual([
      { source: "env", rel: expRel },
      { source: "file", rel: expRel },
    ]);
  });

  test("no overrides leave skippedExperimental off every row", () => {
    const rows = recommendationsForProfile("macbook-pro-48g", env);
    expect(rows.some((row) => row.target === "qwen")).toBe(true);
    expect(rows.some((row) => row.target === "qwen27")).toBe(true);
    for (const row of rows) {
      expect(Object.hasOwn(row, "skippedExperimental"), row.target).toBe(false);
    }
  });

  test("a non-experimental file promotion leaves skippedExperimental off the row", () => {
    const nonExpRel = requireRel(NON_EXP_REL, "builtin catalog has a non-experimental rel");
    writeStaleRow("macbook-pro-48g", "best", nonExpRel);
    const row = bestRow() as { rel: string; promoted: unknown };
    expect(row.rel).toBe(nonExpRel);
    expect(row.promoted).toBe("file");
    expect(Object.hasOwn(row, "skippedExperimental")).toBe(false);
  });
});
