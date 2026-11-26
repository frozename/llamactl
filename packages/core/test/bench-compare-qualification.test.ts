import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { BenchCompareRow } from "../src/bench/compare.js";

import { benchCompare } from "../src/bench/compare.js";
import { writeAppliedStage, writeQualificationOverride } from "../src/qualification/overrides.js";
import { mkdirSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const QUAL_OVERRIDES_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";
const EXPERIMENTAL_REASONING_REL =
  "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GEMMA_Q8_REL = "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf";
const GEMMA_Q4_REL = "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf";

type RowWithQualification = BenchCompareRow & { qualificationStage?: string };

let temp: ReturnType<typeof makeTempRuntime>;
let env: NodeJS.ProcessEnv;
let qualFile: string;
let previousCatalogFile: string | undefined;
let savedQualEnv: string | undefined;

beforeEach(() => {
  temp = makeTempRuntime();
  const srcDir = join(temp.devStorage, "llama-src");
  const binDir = join(temp.devStorage, "llama-bin");
  mkdirSync(temp.runtimeDir, { recursive: true });
  mkdirSync(temp.modelsDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  env = {
    ...envForTemp(temp),
    LLAMA_CPP_SRC: srcDir,
    LLAMA_CPP_BIN: binDir,
  };
  previousCatalogFile = process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"];
  process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] = join(temp.runtimeDir, "curated-models.tsv");
  savedQualEnv = process.env[QUAL_OVERRIDES_ENV];
  qualFile = join(temp.runtimeDir, "qualification-overrides.tsv");
  process.env[QUAL_OVERRIDES_ENV] = qualFile;
});

afterEach(() => {
  if (previousCatalogFile === undefined) {
    Reflect.deleteProperty(process.env, "LOCAL_AI_CUSTOM_CATALOG_FILE");
  } else {
    process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] = previousCatalogFile;
  }
  if (savedQualEnv === undefined) {
    Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
  } else {
    process.env[QUAL_OVERRIDES_ENV] = savedQualEnv;
  }
  temp.cleanup();
});

function rowFor(rows: BenchCompareRow[], rel: string): RowWithQualification {
  const row = rows.find((r) => r.rel === rel);
  if (!row) throw new Error(`no compare row for ${rel}`);
  return row;
}

describe("benchCompare qualification stages", () => {
  test("builtin experimental rows carry their catalog qualification stage", () => {
    Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
    const row = rowFor(benchCompare({}, env), EXPERIMENTAL_REASONING_REL);
    // Kills: no qualificationStage on BenchCompareRow.
    expect(row.qualificationStage).toBe("experimental");
  });

  test("a pin override supplies the row qualification stage", () => {
    writeQualificationOverride(qualFile, {
      rel: GEMMA_Q8_REL,
      action: "pin",
      stage: "experimental",
      author: "test",
      reason: "pin",
    });
    const row = rowFor(benchCompare({}, env), GEMMA_Q8_REL);
    // Kills: reading the raw catalog entry.qualification instead of catalogQualificationStages.
    expect(row.qualificationStage).toBe("experimental");
  });

  test("applied rows overlay the catalog stage and a pin wins over applied", () => {
    writeAppliedStage(qualFile, { rel: GEMMA_Q8_REL, from: "candidate", to: "degraded" }, "test");
    // Kills: reporting only the catalog stage, or bypassing the applied/pin overlay.
    expect(rowFor(benchCompare({}, env), GEMMA_Q8_REL).qualificationStage).toBe("degraded");

    writeQualificationOverride(qualFile, {
      rel: GEMMA_Q8_REL,
      action: "pin",
      stage: "validated",
      author: "test",
      reason: "pin wins",
    });
    expect(rowFor(benchCompare({}, env), GEMMA_Q8_REL).qualificationStage).toBe("validated");
  });

  test("unstaged rows omit the qualificationStage key", () => {
    Reflect.deleteProperty(process.env, QUAL_OVERRIDES_ENV);
    const row = rowFor(benchCompare({}, env), GEMMA_Q4_REL);
    // Kills: emitting the key as undefined.
    expect("qualificationStage" in row).toBe(false);
  });
});
