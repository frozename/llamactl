import { defaultConfigPath } from "@llamactl/core/config/kubeconfig";
import { resolveEnv } from "@llamactl/core/env";
import { workloadStore } from "@llamactl/remote";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SANDBOX_PREFIX, sandboxOperatorStorage } from "./storage-sandbox.js";

const RUNTIME_PATH_OVERRIDES = [
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_ROOT",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_LOGS",
  "LLAMA_CPP_CACHE",
  "LLAMA_CACHE",
  "HF_HOME",
  "HUGGINGFACE_HUB_CACHE",
  "OLLAMA_MODELS",
];

/**
 * The bun test preload for this package reroots operator state (DEV_STORAGE)
 * into a temporary directory so no test can write manifests, config or
 * journals into the operator's live $DEV_STORAGE. These tests pin what the
 * preload guarantees plus the helper's env-rewriting contract.
 */
describe("storage sandbox preload", () => {
  test("DEV_STORAGE points at a fresh sandbox under the system temp dir", () => {
    const root = process.env["DEV_STORAGE"];
    expect(root).toBeDefined();
    expect(dirname(root!)).toBe(tmpdir());
    expect(root!.startsWith(join(tmpdir(), SANDBOX_PREFIX))).toBe(true);
  });

  test("default operator-state paths resolve inside the sandbox", () => {
    const prefix = `${tmpdir()}/`;
    expect(workloadStore.defaultWorkloadsDir().startsWith(prefix)).toBe(true);
    expect(defaultConfigPath().startsWith(prefix)).toBe(true);
  });

  test("the composites dir resolves inside the sandbox", () => {
    const root = process.env["DEV_STORAGE"];
    expect(root).toBeDefined();
    expect(process.env["LLAMACTL_COMPOSITES_DIR"]).toBe(join(root!, "composites"));
  });

  test("runtime path overrides from the shell do not reach the run", () => {
    const leaked = [
      "LLAMA_CPP_ROOT",
      "LLAMA_CPP_CACHE",
      "LLAMA_CACHE",
      "HF_HOME",
      "HUGGINGFACE_HUB_CACHE",
      "OLLAMA_MODELS",
    ].filter((key) => key in process.env);
    expect(leaked).toEqual([]);
  });
});

describe("sandboxOperatorStorage", () => {
  test("reroots DEV_STORAGE and the composites dir and strips the state-dir overrides", () => {
    const env: NodeJS.ProcessEnv = {
      DEV_STORAGE: "/live",
      LLAMACTL_COMPOSITES_DIR: "/live/composites",
      LLAMACTL_CONFIG: "/live/config",
      LLAMACTL_HOME: "/live/repo",
      LLAMACTL_WORKLOADS_DIR: "/live/wl",
      PATH: "/bin",
    };
    sandboxOperatorStorage(env, "/sandbox");
    expect(env["DEV_STORAGE"]).toBe("/sandbox");
    expect(env["LLAMACTL_COMPOSITES_DIR"]).toBe(join("/sandbox", "composites"));
    expect(env["LLAMACTL_HOME"]).toBe("/live/repo");
    expect("LLAMACTL_CONFIG" in env).toBe(false);
    expect("LLAMACTL_WORKLOADS_DIR" in env).toBe(false);
    expect(env["PATH"]).toBe("/bin");
    expect(workloadStore.defaultWorkloadsDir(env)).toBe(join("/sandbox", "workloads"));
    expect(defaultConfigPath(env)).toBe(join("/sandbox", "config"));
  });

  test("strips the runtime path overrides that resolveEnv prefers over DEV_STORAGE", () => {
    const env: NodeJS.ProcessEnv = {
      DEV_STORAGE: "/live",
      HF_HOME: "/live/hf",
      HUGGINGFACE_HUB_CACHE: "/live/hf/hub",
      LLAMA_CACHE: "/live/llama-cache",
      LLAMA_CPP_BIN: "/live/bin",
      LLAMA_CPP_CACHE: "/live/llama.cpp/.cache",
      LLAMA_CPP_LOGS: "/live/logs",
      LLAMA_CPP_MACHINE_PROFILE: "balanced",
      LLAMA_CPP_MODELS: "/live/models",
      LLAMA_CPP_ROOT: "/live/llama.cpp",
      LLAMA_CPP_SRC: "/live/src/llama.cpp",
      LLAMACTL_HOME: "/live/repo",
      LOCAL_AI_RUNTIME_DIR: "/live/runtime",
      OLLAMA_MODELS: "/live/ollama",
      PATH: "/bin",
    };
    sandboxOperatorStorage(env, "/sandbox");
    const kept = RUNTIME_PATH_OVERRIDES.filter((key) => key in env);
    expect(kept).toEqual([]);
    expect(env["DEV_STORAGE"]).toBe("/sandbox");
    expect(env["LLAMA_CPP_BIN"]).toBe("/live/bin");
    expect(env["LLAMA_CPP_SRC"]).toBe("/live/src/llama.cpp");
    expect(env["LLAMACTL_HOME"]).toBe("/live/repo");
    expect(env["PATH"]).toBe("/bin");
    const resolved = resolveEnv(env);
    expect(resolved.LOCAL_AI_RUNTIME_DIR).toBe(join("/sandbox", "ai-models/local-ai"));
    expect(resolved.LLAMA_CPP_ROOT).toBe(join("/sandbox", "ai-models/llama.cpp"));
    expect(resolved.LLAMA_CPP_MODELS).toBe(join("/sandbox", "ai-models/llama.cpp/models"));
    expect(resolved.LLAMA_CPP_LOGS).toBe(join("/sandbox", "logs/llama.cpp"));
    expect(resolved.LLAMA_CPP_CACHE).toBe(join("/sandbox", "ai-models/llama.cpp/.cache"));
    expect(resolved.LLAMA_CACHE).toBe(join("/sandbox", "ai-models/llama.cpp/.cache"));
    expect(resolved.HF_HOME).toBe(join("/sandbox", "cache/huggingface"));
    expect(resolved.HUGGINGFACE_HUB_CACHE).toBe(join("/sandbox", "cache/huggingface/hub"));
    expect(resolved.OLLAMA_MODELS).toBe(join("/sandbox", "ai-models/ollama"));
    expect(resolved.LLAMA_CPP_BIN).toBe("/live/bin");
  });
});
