import { describe, expect, test } from "bun:test";

import { ctxForModel } from "../src/ctx.js";
import { resolveEnv } from "../src/env.js";

describe("ctxForModel", () => {
  const env = resolveEnv({
    LLAMA_CPP_GEMMA_CTX_SIZE: "32768",
    LLAMA_CPP_QWEN_CTX_SIZE: "65536",
    LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
  });

  test("Qwen 3.6 35B-A3B uses Qwen ctx", () => {
    expect(ctxForModel("Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf", env)).toBe("65536");
  });
  test("Qwen 3.5 27B uses Qwen ctx", () => {
    expect(ctxForModel("Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf", env)).toBe("65536");
  });
  test("Qwen 3.8 27B uses Qwen ctx", () => {
    expect(ctxForModel("Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf", env)).toBe("65536");
  });
  test("Gemma uses Gemma ctx", () => {
    expect(ctxForModel("gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf", env)).toBe("32768");
  });
  test("unknown family falls back to Gemma ctx", () => {
    expect(ctxForModel("foo/bar-UD-Q4_K_XL.gguf", env)).toBe("32768");
  });

  // #515: GLM-5.3-Flash gets its own 128K envelope. Same fail-closed
  // shape as the Qwen rule — the leading segment must start with
  // `GLM-5.3` case-sensitively, so vendor-prefixed dirs, older GLM
  // majors, and lowercase dirs all stay on the Gemma envelope.
  describe("GLM-5.3 ctx envelope (#515)", () => {
    const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";

    test("GLM-5.3-Flash-AJ rel uses the GLM ctx", () => {
      expect(ctxForModel(GLM_REL, env)).toBe("131072");
    });

    test("non-GLM-5.3 leading segments stay on the Gemma envelope", () => {
      // GLM is not the leading segment.
      expect(ctxForModel("mlx-community/GLM-5.3-Flash-4bit", env)).toBe("32768");
      // Case-sensitive: the on-disk dir is capital-GLM.
      expect(ctxForModel("glm-5.3-flash-GGUF/x.gguf", env)).toBe("32768");
      // The rule is scoped to GLM-5.3.
      expect(ctxForModel("GLM-4.6-GGUF/GLM-4.6-Q4_K_M.gguf", env)).toBe("32768");
    });
  });

  // Pins the routing RULE, not a model list: any leading path segment
  // starting with `Qwen` takes the Qwen envelope, so a future release
  // cannot silently regress into the Gemma envelope (which would poison
  // the bench primary key, of which ctx is a component).
  describe("routes by leading-segment pattern, not by enumeration", () => {
    const qwenRels = [
      "Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf",
      "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
      "Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf",
      "Qwen4-80B-A6B-GGUF/Qwen4-80B-A6B-UD-Q4_K_XL.gguf",
    ];
    for (const rel of qwenRels) {
      test(`${rel} uses Qwen ctx`, () => {
        expect(ctxForModel(rel, env)).toBe("65536");
      });
    }

    // Fail-closed guard: without these the fix could route EVERYTHING to
    // the Qwen envelope and still look green above.
    const nonQwenRels = [
      "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf",
      "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf",
      // Vendor-prefixed: `Qwen` is not the LEADING segment, so this is not
      // a llama.cpp Qwen model dir and must keep the Gemma envelope.
      "mlx-community/Qwen3-8B-MLX-4bit",
      // Case-sensitive: the on-disk dirs are capital-Q.
      "qwen3.8-27B-GGUF/qwen3.8-27B-Q4_K_M.gguf",
    ];
    for (const rel of nonQwenRels) {
      test(`${rel} uses Gemma ctx`, () => {
        expect(ctxForModel(rel, env)).toBe("32768");
      });
    }
  });
});
