import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  classifyRepoFormat,
  pickCandidateFile,
  pullCandidate,
  type PullEvent,
  pullRepo,
  pullRepoFile,
  resolveHfToken,
  type RunHf,
} from "../src/pull.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

describe("classifyRepoFormat", () => {
  test("classifies a gguf-bearing repo as gguf", () => {
    const files = ["Qwen3-8B-Q4_K_M.gguf", "README.md", "config.json"];
    expect(classifyRepoFormat("Qwen3-8B-GGUF", files)).toEqual({ ok: true, format: "gguf" });
  });

  test("classifies an mlx-community repo with safetensors + config + tokenizer as mlx", () => {
    const files = ["model.safetensors", "config.json", "tokenizer.json", "README.md"];
    expect(classifyRepoFormat("mlx-community/Qwen3-8B-MLX-4bit", files)).toEqual({
      ok: true,
      format: "mlx",
    });
  });

  test("classifies a sharded mlx repo (safetensors.index.json) as mlx", () => {
    const files = [
      "model.safetensors.index.json",
      "model-00001-of-00003.safetensors",
      "config.json",
      "tokenizer.model",
    ];
    expect(classifyRepoFormat("mlx-community/Llama-3.1-8B-MLX", files)).toEqual({
      ok: true,
      format: "mlx",
    });
  });

  test("returns error when neither gguf nor mlx signatures present", () => {
    const files = ["README.md"];
    const result = classifyRepoFormat("foo/bar", files);
    expect(result.ok).toBe(false);
  });

  test("prefers gguf when both gguf and mlx markers exist (back-compat)", () => {
    const files = ["model.gguf", "model.safetensors", "config.json", "tokenizer.json"];
    expect(classifyRepoFormat("mixed/repo", files)).toEqual({ ok: true, format: "gguf" });
  });

  test("--format=mlx override picks mlx even when gguf exists", () => {
    const files = ["model.gguf", "model.safetensors", "config.json", "tokenizer.json"];
    expect(classifyRepoFormat("mixed/repo", files, { override: "mlx" })).toEqual({
      ok: true,
      format: "mlx",
    });
  });

  test("case-insensitive .gguf detection", () => {
    const files = ["Qwen3-8B-Q4_K_M.GGUF", "README.md"];
    expect(classifyRepoFormat("Qwen3-8B-GGUF", files)).toEqual({ ok: true, format: "gguf" });
  });
});

describe("pull.pickCandidateFile", () => {
  test("returns the caller-supplied file without hitting HF", async () => {
    const result = await pickCandidateFile({
      repo: "unsloth/demo-GGUF",
      file: "demo-UD-Q4_K_XL.gguf",
      profile: "balanced",
    });
    expect(result).toEqual({
      repo: "unsloth/demo-GGUF",
      file: "demo-UD-Q4_K_XL.gguf",
      source: "requested",
      profile: "balanced",
      eligible: ["demo-UD-Q4_K_XL.gguf"],
    });
  });

  test("normalises a profile alias", async () => {
    const result = await pickCandidateFile({
      repo: "unsloth/demo",
      file: "x.gguf",
      profile: "mbp",
    });
    expect(result?.profile).toBe("macbook-pro-48g");
  });
});

describe("pull.resolveHfToken", () => {
  test("returns HF_TOKEN when set", () => {
    const original = process.env.HF_TOKEN;
    process.env.HF_TOKEN = "test-token";
    try {
      expect(resolveHfToken()).toBe("test-token");
    } finally {
      if (original === undefined) delete process.env.HF_TOKEN;
      else process.env.HF_TOKEN = original;
    }
  });
});

describe("pull.pullRepo (injected runHf)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("defaults target to $LLAMA_CPP_MODELS/<repo-basename> and assembles argv", async () => {
    const captured: string[][] = [];
    const runHf: RunHf = (args) => {
      captured.push(args);
      return Promise.resolve(0);
    };
    const result = await pullRepo({ repo: "unsloth/demo-GGUF", runHf });
    const expectedTarget = join(temp.modelsDir, "demo-GGUF");
    expect(result.target).toBe(expectedTarget);
    expect(result.code).toBe(0);
    expect(captured).toEqual([["download", "unsloth/demo-GGUF", "--local-dir", expectedTarget]]);
  });

  test("honours explicit targetDir", async () => {
    const override = join(temp.devStorage, "custom");
    const runHf: RunHf = () => Promise.resolve(0);
    const result = await pullRepo({
      repo: "unsloth/demo",
      targetDir: override,
      runHf,
    });
    expect(result.target).toBe(override);
  });

  test("propagates non-zero exit code", async () => {
    const runHf: RunHf = () => Promise.resolve(2);
    const result = await pullRepo({ repo: "unsloth/demo", runHf });
    expect(result.code).toBe(2);
  });
});

describe("pull.pullRepoFile (injected runHf)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("wasMissing=true when target is absent; argv omits mmproj when skipMmproj", async () => {
    const captured: string[][] = [];
    const runHf: RunHf = (args) => {
      captured.push(args);
      return Promise.resolve(0);
    };
    const result = await pullRepoFile({
      repo: "unsloth/demo-GGUF",
      file: "demo-Q4.gguf",
      runHf,
      skipMmproj: true,
    });
    const target = join(temp.modelsDir, "demo-GGUF");
    expect(result.rel).toBe("demo-GGUF/demo-Q4.gguf");
    expect(result.target).toBe(target);
    expect(result.wasMissing).toBe(true);
    expect(result.mmproj).toBeNull();
    expect(result.requestedFiles).toEqual(["demo-Q4.gguf"]);
    expect(captured).toEqual([
      ["download", "unsloth/demo-GGUF", "demo-Q4.gguf", "--local-dir", target],
    ]);
  });

  test("wasMissing=false when file already lives under $LLAMA_CPP_MODELS", async () => {
    const target = join(temp.modelsDir, "demo-GGUF");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "demo-Q4.gguf"), "");
    const runHf: RunHf = () => Promise.resolve(0);
    const result = await pullRepoFile({
      repo: "unsloth/demo-GGUF",
      file: "demo-Q4.gguf",
      runHf,
      skipMmproj: true,
    });
    expect(result.wasMissing).toBe(false);
  });

  test("respects caller-supplied rel-style file (contains /)", async () => {
    const runHf: RunHf = () => Promise.resolve(0);
    const result = await pullRepoFile({
      repo: "unsloth/demo-GGUF",
      file: "nested/demo-Q8.gguf",
      runHf,
      skipMmproj: true,
    });
    expect(result.rel).toBe("nested/demo-Q8.gguf");
    expect(result.requestedFiles).toEqual(["nested/demo-Q8.gguf"]);
  });

  test("emits a start event before spawn", async () => {
    const events: PullEvent[] = [];
    const runHf: RunHf = (_args, onEvent) => {
      onEvent?.({ type: "stderr", line: "progress..." });
      onEvent?.({ type: "exit", code: 0 });
      return Promise.resolve(0);
    };
    await pullRepoFile({
      repo: "unsloth/demo",
      file: "demo.gguf",
      runHf,
      skipMmproj: true,
      onEvent: (e) => events.push(e),
    });
    expect(events[0]?.type).toBe("start");
    expect(events.some((e) => e.type === "stderr" && e.line === "progress...")).toBe(true);
  });
});

describe("pull.pullCandidate", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("error when HF is disabled and no file override is given", async () => {
    const runHf: RunHf = () => Promise.resolve(0);
    const result = await pullCandidate({ repo: "unsloth/demo", runHf });
    expect(result).toEqual({ error: "Unable to resolve a candidate file for unsloth/demo" });
  });

  test("short-circuits to pullRepoFile when caller supplies the file", async () => {
    const captured: string[][] = [];
    const runHf: RunHf = (args) => {
      captured.push(args);
      return Promise.resolve(0);
    };
    const result = await pullCandidate({
      repo: "unsloth/demo-GGUF",
      file: "demo-Q4.gguf",
      runHf,
      skipMmproj: true,
    });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.picked.source).toBe("requested");
    expect(result.rel).toBe("demo-GGUF/demo-Q4.gguf");
    expect(captured).toHaveLength(1);
  });
});
