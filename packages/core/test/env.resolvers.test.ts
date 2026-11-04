import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveCustomCatalogFile, resolveEnv, resolveRuntimeDir } from "../src/env.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

function makeTempDir(prefix = "llamactl-env-resolvers-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("env.resolveRuntimeDir — precedence", () => {
  test("(1) LOCAL_AI_RUNTIME_DIR wins over LLAMACTL_TEST_PROFILE and DEV_STORAGE", () => {
    expect(
      resolveRuntimeDir({
        DEV_STORAGE: "/tmp/ds",
        LLAMACTL_TEST_PROFILE: "/tmp/tp",
        LOCAL_AI_RUNTIME_DIR: "/my/runtime",
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      }),
    ).toBe("/my/runtime");
  });

  test("(2) with only LLAMACTL_TEST_PROFILE=/tmp/tp, result is /tmp/tp/ai-models/local-ai", () => {
    expect(
      resolveRuntimeDir({
        LLAMACTL_TEST_PROFILE: "/tmp/tp",
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      }),
    ).toBe("/tmp/tp/ai-models/local-ai");
  });

  test("(3) with only DEV_STORAGE=/tmp/ds, result is /tmp/ds/ai-models/local-ai", () => {
    expect(
      resolveRuntimeDir({
        DEV_STORAGE: "/tmp/ds",
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      }),
    ).toBe("/tmp/ds/ai-models/local-ai");
  });

  test("(4) empty LOCAL_AI_RUNTIME_DIR is ignored, falls through to DEV_STORAGE default", () => {
    expect(
      resolveRuntimeDir({
        DEV_STORAGE: "/tmp/ds",
        LOCAL_AI_RUNTIME_DIR: "",
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      }),
    ).toBe("/tmp/ds/ai-models/local-ai");
  });
});

describe("env.resolveCustomCatalogFile", () => {
  test("(5) explicit LOCAL_AI_CUSTOM_CATALOG_FILE is returned verbatim", () => {
    expect(
      resolveCustomCatalogFile({
        LOCAL_AI_CUSTOM_CATALOG_FILE: "/my/catalog.tsv",
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      }),
    ).toBe("/my/catalog.tsv");
  });

  test("(6) default is <LOCAL_AI_RUNTIME_DIR>/curated-models.tsv and follows LOCAL_AI_RUNTIME_DIR override", () => {
    expect(
      resolveCustomCatalogFile({
        DEV_STORAGE: "/tmp/ds",
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      }),
    ).toBe("/tmp/ds/ai-models/local-ai/curated-models.tsv");
    expect(
      resolveCustomCatalogFile({
        LLAMACTL_TEST_PROFILE: "/tmp/tp",
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      }),
    ).toBe("/tmp/tp/ai-models/local-ai/curated-models.tsv");
  });
});

describe("env.resolveEnv — LOCAL_AI_PRESET_OVERRIDES_FILE", () => {
  test("(7) defaults to <runtimeDir>/preset-overrides.tsv", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });
    expect(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE).toBe(
      "/tmp/ds/ai-models/local-ai/preset-overrides.tsv",
    );
  });
});

describe("env.resolveEnv — default-model ladder", () => {
  test("(8) single file gemma-4-E4B-it-GGUF/Q8_0.gguf is the default model", () => {
    const d = makeTempDir("llamactl-ladder-8-");
    try {
      const modelsDir = join(d, "models");
      const modelPath = join(modelsDir, "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf");
      mkdirSync(dirname(modelPath), { recursive: true });
      writeFileSync(modelPath, "");

      const resolved = resolveEnv({
        DEV_STORAGE: d,
        LLAMA_CPP_MODELS: modelsDir,
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      });
      expect(resolved.LLAMA_CPP_DEFAULT_MODEL).toBe("gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("(9) 26B UD-Q4_K_XL wins over E4B Q8_0 (ladder order on macbook-pro-48g)", () => {
    const d = makeTempDir("llamactl-ladder-9-");
    try {
      const modelsDir = join(d, "models");
      const path26B = join(modelsDir, "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf");
      const pathE4B = join(modelsDir, "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf");
      mkdirSync(dirname(path26B), { recursive: true });
      mkdirSync(dirname(pathE4B), { recursive: true });
      writeFileSync(path26B, "");
      writeFileSync(pathE4B, "");

      const resolved = resolveEnv({
        DEV_STORAGE: d,
        LLAMA_CPP_MODELS: modelsDir,
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      });
      expect(resolved.LLAMA_CPP_DEFAULT_MODEL).toBe(
        "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf",
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("(10) explicit LLAMA_CPP_DEFAULT_MODEL wins even when ladder files exist", () => {
    const d = makeTempDir("llamactl-ladder-10-");
    try {
      const modelsDir = join(d, "models");
      const path26B = join(modelsDir, "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf");
      mkdirSync(dirname(path26B), { recursive: true });
      writeFileSync(path26B, "");

      const resolved = resolveEnv({
        DEV_STORAGE: d,
        LLAMA_CPP_MODELS: modelsDir,
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
        LLAMA_CPP_DEFAULT_MODEL: "my-override.gguf",
      });
      expect(resolved.LLAMA_CPP_DEFAULT_MODEL).toBe("my-override.gguf");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("(11) empty models dir yields profile fallback (31B rel)", () => {
    const d = makeTempDir("llamactl-ladder-11-");
    try {
      const modelsDir = join(d, "models");
      mkdirSync(modelsDir, { recursive: true });

      const resolved = resolveEnv({
        DEV_STORAGE: d,
        LLAMA_CPP_MODELS: modelsDir,
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      });
      expect(resolved.LLAMA_CPP_DEFAULT_MODEL).toBe(
        "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf",
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("env.resolveEnv — provider fallbacks", () => {
  test("(12) lmstudio with LOCAL_AI_SOURCE_MODEL + no LOCAL_AI_MODEL", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_PROVIDER: "lmstudio",
      LOCAL_AI_SOURCE_MODEL: "gemma-4-31B-it-GGUF/x.gguf",
    });
    expect(resolved.LOCAL_AI_MODEL).toBe("local/gemma-4-31B-it-GGUF");
  });

  test("(13) lmstudio without LM_API_TOKEN: both keys are 'local'", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_PROVIDER: "lmstudio",
    });
    expect(resolved.LOCAL_AI_API_KEY).toBe("local");
    expect(resolved.OPENAI_API_KEY).toBe("local");
  });

  test("(14) llama.cpp provider (unset) with LLAMA_CPP_SERVER_ALIAS + no LOCAL_AI_MODEL", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMA_CPP_SERVER_ALIAS: "my-alias",
    });
    expect(resolved.LOCAL_AI_MODEL).toBe("my-alias");
  });

  test("(15) llama.cpp with neither: LOCAL_AI_MODEL is 'local'", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });
    expect(resolved.LOCAL_AI_MODEL).toBe("local");
  });

  test("(16) LOCAL_AI_PROVIDER='ollama' (unknown) resolves to 'llama.cpp' + uses base URL", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_PROVIDER: "ollama",
      LOCAL_AI_LLAMA_CPP_BASE_URL: "http://10.0.0.99:9999/v1",
    });
    expect(resolved.LOCAL_AI_PROVIDER).toBe("llama.cpp");
    expect(resolved.LOCAL_AI_PROVIDER_URL).toBe("http://10.0.0.99:9999/v1");
  });

  test("(17) empty-string-is-unset: LLAMA_CPP_PORT='' yields '8080', LLAMA_CPP_SERVER_ALIAS='' yields 'local'", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMA_CPP_PORT: "",
      LLAMA_CPP_SERVER_ALIAS: "",
    });
    expect(resolved.LLAMA_CPP_PORT).toBe("8080");
    expect(resolved.LOCAL_AI_MODEL).toBe("local");
  });

  test("(18) LOCAL_AI_LMSTUDIO_HOST + PORT yield base URL, explicit BASE_URL wins", () => {
    const resolved1 = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_PROVIDER: "lmstudio",
      LOCAL_AI_LMSTUDIO_HOST: "10.0.0.5",
      LOCAL_AI_LMSTUDIO_PORT: "4321",
    });
    expect(resolved1.LOCAL_AI_LMSTUDIO_BASE_URL).toBe("http://10.0.0.5:4321/v1");

    const resolved2 = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_PROVIDER: "lmstudio",
      LOCAL_AI_LMSTUDIO_HOST: "10.0.0.5",
      LOCAL_AI_LMSTUDIO_PORT: "4321",
      LOCAL_AI_LMSTUDIO_BASE_URL: "http://explicit/v1",
    });
    expect(resolved2.LOCAL_AI_LMSTUDIO_BASE_URL).toBe("http://explicit/v1");
  });
});

describe("env.resolveEnv — cache + context defaults", () => {
  test("(19) LLAMA_CACHE defaults to LLAMA_CPP_CACHE and follows override", () => {
    const resolved1 = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });
    expect(resolved1.LLAMA_CACHE).toBe("/tmp/ds/ai-models/llama.cpp/.cache");

    const resolved2 = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMA_CPP_CACHE: "/my/cache",
      LLAMA_CACHE: "/my/cache",
    });
    expect(resolved2.LLAMA_CACHE).toBe("/my/cache");
  });

  test("(20) LOCAL_AI_CONTEXT_LENGTH defaults to profile gemma ctx, overridable", () => {
    const resolved1 = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });
    expect(resolved1.LOCAL_AI_CONTEXT_LENGTH).toBe("32768");

    const resolved2 = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMA_CPP_GEMMA_CTX_SIZE: "12345",
    });
    expect(resolved2.LOCAL_AI_CONTEXT_LENGTH).toBe("12345");

    const resolved3 = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMA_CPP_GEMMA_CTX_SIZE: "12345",
      LOCAL_AI_CONTEXT_LENGTH: "99999",
    });
    expect(resolved3.LOCAL_AI_CONTEXT_LENGTH).toBe("99999");
  });
});
