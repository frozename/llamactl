import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import type { BenchCompareRow } from "../src/bench/compare.js";

import { benchCompare, hasAnyTunedRecord } from "../src/bench/compare.js";
import { BUILTIN_CATALOG } from "../src/catalog.js";
import { mkdirSync, utimesSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

/**
 * Pins benchCompare (packages/core/src/bench/compare.ts): one row per
 * catalog entry, the class/scope filters, the installed probe, the build
 * key, and how a tuned record is resolved from llama-bench-profiles.tsv
 * (current-schema key match, last duplicate wins, legacy rel-only
 * fallback) and bench-vision.tsv. Every case runs against a fresh temp
 * runtime with an explicit env, so nothing reads the operator's real
 * bench files, models or llama.cpp build.
 */

const MACHINE = "macbook-pro-48g";
const GEMMA_CTX = "32768";
const QWEN_CTX = "65536";
// Builtin, class multimodal, scope fast: keys on mode vision + the Gemma ctx.
const GEMMA_REL = "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf";
// Builtin, class reasoning: keys on mode text + the Qwen ctx.
const QWEN_REL = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf";

let temp: ReturnType<typeof makeTempRuntime>;
let env: NodeJS.ProcessEnv;
let binDir: string;
let previousCatalogFile: string | undefined;

beforeEach(() => {
  temp = makeTempRuntime();
  const srcDir = join(temp.devStorage, "llama-src");
  binDir = join(temp.devStorage, "llama-bin");
  mkdirSync(temp.runtimeDir, { recursive: true });
  mkdirSync(temp.modelsDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  env = {
    ...envForTemp(temp),
    LLAMA_CPP_SRC: srcDir,
    LLAMA_CPP_BIN: binDir,
    LLAMA_CPP_GEMMA_CTX_SIZE: GEMMA_CTX,
    LLAMA_CPP_QWEN_CTX_SIZE: QWEN_CTX,
  };
  // listCatalog/findByRel read the custom catalog path from process.env,
  // not from the env argument, so pin it to the temp runtime too.
  previousCatalogFile = process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"];
  process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] = join(temp.runtimeDir, "curated-models.tsv");
});

afterEach(() => {
  if (previousCatalogFile === undefined) {
    Reflect.deleteProperty(process.env, "LOCAL_AI_CUSTOM_CATALOG_FILE");
  } else {
    process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] = previousCatalogFile;
  }
  temp.cleanup();
});

function writeTsv(name: string, rows: string[][]): void {
  const body = rows.map((cols) => cols.join("\t")).join("\n");
  writeFileSync(join(temp.runtimeDir, name), `${body}\n`);
}

// Current-schema bench-profiles row (9 columns, benchProfileFields order).
const BASE_PROFILE = {
  machine: MACHINE,
  rel: GEMMA_REL,
  mode: "vision",
  ctx: GEMMA_CTX,
  build: "unknown",
  profile: "default",
  gen_ts: "20.0",
  prompt_ts: "600.0",
  updated_at: "2026-10-01T10:00:00+0000",
};

function profileRow(over: Partial<typeof BASE_PROFILE>): string[] {
  const r = { ...BASE_PROFILE, ...over };
  return [r.machine, r.rel, r.mode, r.ctx, r.build, r.profile, r.gen_ts, r.prompt_ts, r.updated_at];
}

// bench-vision row (9 columns, benchVisionFields order).
const BASE_VISION = {
  machine: MACHINE,
  rel: GEMMA_REL,
  ctx: "4096",
  build: "unknown",
  load_ms: "1167.15",
  image_encode_ms: "88.2",
  prompt_tps: "512.5",
  gen_tps: "40.1",
  updated_at: "2026-10-03T10:00:00+0000",
};

function visionRow(over: Partial<typeof BASE_VISION>): string[] {
  const r = { ...BASE_VISION, ...over };
  return [
    r.machine,
    r.rel,
    r.ctx,
    r.build,
    r.load_ms,
    r.image_encode_ms,
    r.prompt_tps,
    r.gen_tps,
    r.updated_at,
  ];
}

function rowFor(rows: BenchCompareRow[], rel: string): BenchCompareRow {
  const row = rows.find((r) => r.rel === rel);
  if (!row) throw new Error(`no compare row for ${rel}`);
  return row;
}

function keyOf(row: BenchCompareRow): { mode: string; ctx: string; build: string } {
  return { mode: row.mode, ctx: row.ctx, build: row.build };
}

describe("benchCompare catalog rows", () => {
  test("returns one row per builtin entry in catalog order with entry fields copied", () => {
    const rows = benchCompare({}, env);
    expect(
      rows.map((r) => ({ label: r.label, class: r.class, scope: r.scope, rel: r.rel })),
    ).toEqual(
      BUILTIN_CATALOG.map((e) => ({ label: e.label, class: e.class, scope: e.scope, rel: e.rel })),
    );
    expect(rows.every((r) => r.machine === MACHINE)).toBe(true);
    expect(rows.every((r) => !r.installed && r.tuned === null && r.vision === null)).toBe(true);
  });

  test("appends custom catalog rows after the builtin entries", () => {
    writeFileSync(
      join(temp.runtimeDir, "curated-models.tsv"),
      "my-custom\tMy Custom\tcustom\tcustom\tlab\tCustom-GGUF/custom.gguf\tme/Custom-GGUF\tgguf\n",
    );
    const rows = benchCompare({}, env);
    expect(rows).toHaveLength(BUILTIN_CATALOG.length + 1);
    const last = rows[rows.length - 1];
    expect(last?.rel).toBe("Custom-GGUF/custom.gguf");
    expect(last?.label).toBe("My Custom");
    expect(last?.class).toBe("custom");
    expect(last?.scope).toBe("lab");
  });

  test("classFilter keeps only rows of that class", () => {
    const rels = benchCompare({ classFilter: "multimodal" }, env).map((r) => r.rel);
    expect(rels).toEqual(BUILTIN_CATALOG.filter((e) => e.class === "multimodal").map((e) => e.rel));
    expect(rels.length).toBeGreaterThan(0);
  });

  test("scopeFilter keeps only rows of that scope", () => {
    const rels = benchCompare({ scopeFilter: "fast" }, env).map((r) => r.rel);
    expect(rels).toEqual(BUILTIN_CATALOG.filter((e) => e.scope === "fast").map((e) => e.rel));
    expect(rels.length).toBeGreaterThan(0);
  });

  test("class and scope filters combine with AND, and a filter matching nothing returns []", () => {
    expect(
      benchCompare({ classFilter: "multimodal", scopeFilter: "fast" }, env).map((r) => r.rel),
    ).toEqual([GEMMA_REL]);
    expect(benchCompare({ classFilter: "reasoning", scopeFilter: "fast" }, env)).toEqual([]);
    expect(benchCompare({ scopeFilter: "no-such-scope" }, env)).toEqual([]);
  });

  test("installed is true only when the model file exists under LLAMA_CPP_MODELS", () => {
    const modelPath = join(temp.modelsDir, QWEN_REL);
    mkdirSync(dirname(modelPath), { recursive: true });
    writeFileSync(modelPath, "");
    const rows = benchCompare({}, env);
    expect(rows.filter((r) => r.installed).map((r) => r.rel)).toEqual([QWEN_REL]);
  });
});

describe("benchCompare build and env key", () => {
  test("build is 'unknown' without a git source tree or llama-server binary", () => {
    const rows = benchCompare({}, env);
    expect(rows.every((r) => r.build === "unknown")).toBe(true);
  });

  test("build is bin-<mtime seconds> of LLAMA_CPP_BIN/llama-server", () => {
    const serverPath = join(binDir, "llama-server");
    writeFileSync(serverPath, "");
    utimesSync(serverPath, 1700000000, 1700000000);
    const rows = benchCompare({}, env);
    expect(rowFor(rows, GEMMA_REL).build).toBe("bin-1700000000");
  });

  test("with no bench record, tuned is null and mode/ctx/build come from the env key", () => {
    const rows = benchCompare({}, env);
    const gemma = rowFor(rows, GEMMA_REL);
    const qwen = rowFor(rows, QWEN_REL);
    expect(gemma.tuned).toBeNull();
    expect(keyOf(gemma)).toEqual({ mode: "vision", ctx: GEMMA_CTX, build: "unknown" });
    expect(qwen.tuned).toBeNull();
    expect(keyOf(qwen)).toEqual({ mode: "text", ctx: QWEN_CTX, build: "unknown" });
  });
});

describe("benchCompare tuned record resolution", () => {
  test("a current-schema row on the full key is used, and the last duplicate wins", () => {
    writeTsv("llama-bench-profiles.tsv", [
      profileRow({}),
      profileRow({
        profile: "throughput",
        gen_ts: "21.5",
        prompt_ts: "640.0",
        updated_at: "2026-10-02T10:00:00+0000",
      }),
    ]);
    const gemma = rowFor(benchCompare({}, env), GEMMA_REL);
    expect(gemma.tuned).toEqual({
      profile: "throughput",
      gen_tps: "21.5",
      prompt_tps: "640.0",
      updated_at: "2026-10-02T10:00:00+0000",
      legacy: false,
    });
    expect(keyOf(gemma)).toEqual({ mode: "vision", ctx: GEMMA_CTX, build: "unknown" });
  });

  test("Qwen rels match on mode text and LLAMA_CPP_QWEN_CTX_SIZE", () => {
    writeTsv("llama-bench-profiles.tsv", [
      profileRow({ rel: QWEN_REL, mode: "text", ctx: GEMMA_CTX, gen_ts: "1.0" }),
      profileRow({ rel: QWEN_REL, mode: "text", ctx: QWEN_CTX, gen_ts: "42.6" }),
    ]);
    const qwen = rowFor(benchCompare({}, env), QWEN_REL);
    expect(qwen.tuned?.gen_tps).toBe("42.6");
    expect(qwen.tuned?.legacy).toBe(false);
    expect(keyOf(qwen)).toEqual({ mode: "text", ctx: QWEN_CTX, build: "unknown" });
  });

  test("current-schema rows whose machine, build, ctx or mode differ are ignored", () => {
    writeTsv("llama-bench-profiles.tsv", [
      profileRow({ machine: "mac-mini-16g" }),
      profileRow({ build: "abc1234" }),
      profileRow({ ctx: QWEN_CTX }),
      profileRow({ mode: "text" }),
    ]);
    const gemma = rowFor(benchCompare({}, env), GEMMA_REL);
    expect(gemma.tuned).toBeNull();
    expect(keyOf(gemma)).toEqual({ mode: "vision", ctx: GEMMA_CTX, build: "unknown" });
  });

  test("a legacy 5-column row is the fallback and reports mode/ctx/build as 'legacy'", () => {
    writeTsv("llama-bench-profiles.tsv", [
      [GEMMA_REL, "conservative", "9.5", "120.0", "2026-09-01T00:00:00+0000"],
    ]);
    const gemma = rowFor(benchCompare({}, env), GEMMA_REL);
    expect(keyOf(gemma)).toEqual({ mode: "legacy", ctx: "legacy", build: "legacy" });
    expect(gemma.tuned).toEqual({
      profile: "conservative",
      gen_tps: "9.5",
      prompt_tps: "120.0",
      updated_at: "2026-09-01T00:00:00+0000",
      legacy: true,
    });
  });

  test("a current-schema match beats a legacy row for the same rel", () => {
    writeTsv("llama-bench-profiles.tsv", [
      profileRow({}),
      [GEMMA_REL, "conservative", "9.5", "120.0", "2026-10-05T00:00:00+0000"],
    ]);
    const gemma = rowFor(benchCompare({}, env), GEMMA_REL);
    expect(gemma.tuned?.legacy).toBe(false);
    expect(gemma.tuned?.profile).toBe("default");
    expect(keyOf(gemma)).toEqual({ mode: "vision", ctx: GEMMA_CTX, build: "unknown" });
  });
});

describe("benchCompare vision record", () => {
  test("a bench-vision row on (machine, rel, build) is mapped whatever its ctx", () => {
    writeTsv("bench-vision.tsv", [visionRow({}), visionRow({ rel: QWEN_REL, build: "abc1234" })]);
    const rows = benchCompare({}, env);
    expect(rowFor(rows, GEMMA_REL).vision).toEqual({
      load_ms: "1167.15",
      image_encode_ms: "88.2",
      prompt_tps: "512.5",
      gen_tps: "40.1",
      updated_at: "2026-10-03T10:00:00+0000",
    });
    expect(rowFor(rows, QWEN_REL).vision).toBeNull();
  });
});

describe("hasAnyTunedRecord", () => {
  test("is false for no rows and for rows without a tuned record", () => {
    expect(hasAnyTunedRecord([])).toBe(false);
    expect(hasAnyTunedRecord(benchCompare({}, env))).toBe(false);
  });

  test("is true when one row has a tuned record", () => {
    writeTsv("llama-bench-profiles.tsv", [
      [QWEN_REL, "default", "9.5", "120.0", "2026-09-01T00:00:00+0000"],
    ]);
    expect(hasAnyTunedRecord(benchCompare({}, env))).toBe(true);
  });
});
