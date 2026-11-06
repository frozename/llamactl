import { afterAll, describe, expect, test } from "bun:test";

import { resolveTarget } from "../src/target.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const temp = makeTempRuntime();
const base = envForTemp(temp);
afterAll(() => {
  temp.cleanup();
});

const G31 = "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf";
const G26 = "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
const E4B_Q8 = "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf";
const E4B_Q4 = "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf";
const Q36_S = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf";
const Q36_M = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf";
const Q36_XL = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf";
const Q27 = "Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf";

type Env = NodeJS.ProcessEnv;

function makeEnv(overrides: Partial<Env>): Env {
  return { ...base, ...overrides };
}

describe("resolveTarget preset aliases per profile", () => {
  test.each([
    ["mac-mini-16g", "best", E4B_Q8],
    ["mac-mini-16g", "quality", E4B_Q8],
    ["mac-mini-16g", "vision", E4B_Q8],
    ["mac-mini-16g", "image", E4B_Q8],
    ["mac-mini-16g", "balanced", E4B_Q4],
    ["mac-mini-16g", "daily", E4B_Q4],
    ["mac-mini-16g", "fast", E4B_Q4],
    ["mac-mini-16g", "small", E4B_Q4],
    ["balanced", "best", G31],
    ["balanced", "quality", G31],
    ["balanced", "vision", G26],
    ["balanced", "image", G26],
    ["balanced", "balanced", G26],
    ["balanced", "daily", G26],
    ["balanced", "fast", E4B_Q8],
    ["balanced", "small", E4B_Q8],
    ["macbook-pro-48g", "best", G31],
    ["macbook-pro-48g", "quality", G31],
    ["macbook-pro-48g", "vision", G26],
    ["macbook-pro-48g", "image", G26],
    ["macbook-pro-48g", "balanced", G26],
    ["macbook-pro-48g", "daily", G26],
    ["macbook-pro-48g", "fast", E4B_Q8],
    ["macbook-pro-48g", "small", E4B_Q8],
  ])("%s + %s -> %s", (profile: string, preset: string, expected: string) => {
    const env = makeEnv({ LLAMA_CPP_MACHINE_PROFILE: profile });
    expect(resolveTarget(preset, env)).toBe(expected);
  });
});

describe("resolveTarget Qwen 3.6 per profile", () => {
  test.each([
    ["mac-mini-16g", Q36_S],
    ["balanced", Q36_M],
    ["macbook-pro-48g", Q36_XL],
    ["large-128g", Q36_XL],
  ])("qwen aliases on %s -> %s", (profile: string, expected: string) => {
    const aliases = ["qwen", "qwen36", "qwen3.6", "qwen3.6-35b", "qwen35b"];
    const env = makeEnv({ LLAMA_CPP_MACHINE_PROFILE: profile });
    for (const alias of aliases) {
      expect(resolveTarget(alias, env)).toBe(expected);
    }
  });
});

describe("resolveTarget profile alias normalisation", () => {
  test('LLAMA_CPP_MACHINE_PROFILE "mini" maps to mac-mini-16g presets', () => {
    const env = makeEnv({ LLAMA_CPP_MACHINE_PROFILE: "mini" });
    expect(resolveTarget("qwen", env)).toBe(Q36_S);
    expect(resolveTarget("balanced", env)).toBe(E4B_Q4);
  });
});

describe("resolveTarget fixed aliases are profile-independent", () => {
  test.each([
    ["31b", G31],
    ["gemma4-31b", G31],
    ["gemma-4-31b", G31],
    ["26b", G26],
    ["gemma4-26b", G26],
    ["gemma-4-26b", G26],
    ["e4b", E4B_Q8],
    ["gemma4-e4b", E4B_Q8],
    ["gemma-4-e4b", E4B_Q8],
    ["qwen27", Q27],
    ["qwen35", Q27],
    ["qwen3.5-27b", Q27],
  ])("%s -> %s", (target: string, expected: string) => {
    expect(resolveTarget(target, makeEnv({ LLAMA_CPP_MACHINE_PROFILE: "mac-mini-16g" }))).toBe(
      expected,
    );
    expect(resolveTarget(target, makeEnv({ LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g" }))).toBe(
      expected,
    );
  });
});

describe("resolveTarget current model resolution", () => {
  test('undefined, "" and "current" return LOCAL_AI_SOURCE_MODEL when set', () => {
    const env = makeEnv({
      ...base,
      LOCAL_AI_SOURCE_MODEL: "Src/s.gguf",
    });
    expect(resolveTarget(undefined, env)).toBe("Src/s.gguf");
    expect(resolveTarget("", env)).toBe("Src/s.gguf");
    expect(resolveTarget("current", env)).toBe("Src/s.gguf");
  });

  test('undefined, "" and "current" fall back to LLAMA_CPP_DEFAULT_MODEL', () => {
    const env = makeEnv({
      ...base,
      LLAMA_CPP_DEFAULT_MODEL: "Def/d.gguf",
    });
    expect(resolveTarget("current", env)).toBe("Def/d.gguf");
  });
});

describe("resolveTarget env preset override flows through", () => {
  test('LOCAL_AI_PRESET_MAC_MINI_16G_FAST_MODEL overrides "small" and "fast" on mac-mini-16g', () => {
    const env = makeEnv({
      ...base,
      LLAMA_CPP_MACHINE_PROFILE: "mini",
      LOCAL_AI_PRESET_MAC_MINI_16G_FAST_MODEL: "env/fast.gguf",
    });
    expect(resolveTarget("small", env)).toBe("env/fast.gguf");
    expect(resolveTarget("fast", env)).toBe("env/fast.gguf");
  });

  test("same override var is keyed by profile — ignored on balanced", () => {
    const env = makeEnv({
      ...base,
      LLAMA_CPP_MACHINE_PROFILE: "balanced",
      LOCAL_AI_PRESET_MAC_MINI_16G_FAST_MODEL: "env/fast.gguf",
    });
    expect(resolveTarget("small", env)).toBe(E4B_Q8);
  });
});

describe("resolveTarget passthrough and unknown", () => {
  test.each([
    ["model.gguf", "model.gguf"],
    ["org/model", "org/model"],
    ["nope", null],
    ["Best", null],
    ["m.GGUF", null],
  ])('"%s" -> %s', (target: string, expected: string | null) => {
    expect(resolveTarget(target, base)).toBe(expected);
  });
});
