import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ModelHostSpecForEngine } from "../../src/engines/types.js";

import { ENGINES } from "../../src/engines/index.js";

function makeFakeBinary(): string {
  const dir = join(
    tmpdir(),
    `omlx-dflash-test-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "omlx");
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

const fakeBinary = makeFakeBinary();
const runtimeRoot = join(
  tmpdir(),
  `llamactl-runtime-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
);

const baseSpec: ModelHostSpecForEngine = {
  engine: "omlx",
  binary: fakeBinary,
  endpoint: { host: "127.0.0.1", port: 8094 },
  hostedModels: [
    {
      rel: "lmstudio-community/Qwen3-8B-MLX-4bit",
      dflash: {
        enabled: true,
        dflash_enabled: true,
        dflash_draft_model: "draft-model.gguf",
        dflash_in_memory_cache: true,
        dflash_in_memory_cache_max_entries: 8,
        dflash_in_memory_cache_max_bytes: 1024,
        dflash_ssd_cache: false,
        dflash_draft_window_size: 16,
        dflash_draft_sink_size: 4,
        dflash_verify_mode: "strict",
      },
    },
  ],
  resources: { expectedMemoryGiB: 12 },
  extraArgs: ["--max-concurrent-requests", "4"],
  timeoutSeconds: 60,
};

describe("omlx engine dflash boot command", () => {
  test("buildBootCommand passes --base-path without writing model_settings.json", async () => {
    const spec = baseSpec;
    const built = ENGINES.omlx.buildBootCommand(spec, {
      LLAMA_CPP_MODELS: "/unused/models",
      LLAMACTL_RUNTIME_DIR: runtimeRoot,
      workloadName: "mlx-host-local",
    });

    const expectedBasePath = join(runtimeRoot, "workloads", "mlx-host-local", ".omlx");
    expect(built.args).toContain("--base-path");
    expect(built.args).toContain(expectedBasePath);
    expect(existsSync(join(expectedBasePath, "model_settings.json"))).toBe(false);

    await ENGINES.omlx.prepareLaunch?.(spec, {
      LLAMA_CPP_MODELS: "/unused/models",
      LLAMACTL_RUNTIME_DIR: runtimeRoot,
      workloadName: "mlx-host-local",
    });

    expect(existsSync(join(expectedBasePath, "model_settings.json"))).toBe(true);

    const raw = readFileSync(join(expectedBasePath, "model_settings.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      models: {
        [basename(spec.hostedModels[0]!.rel)]: {
          dflash_enabled: true,
          dflash_draft_model: "draft-model.gguf",
          dflash_in_memory_cache: true,
          dflash_in_memory_cache_max_entries: 8,
          dflash_in_memory_cache_max_bytes: 1024,
          dflash_ssd_cache: false,
          dflash_draft_window_size: 16,
          dflash_draft_sink_size: 4,
          dflash_verify_mode: "strict",
        },
      },
    });
  });

  afterAll(() => {
    try {
      rmSync(fakeBinary, { force: true });
    } catch {
      // Best-effort cleanup; failures are not actionable here.
    }
    try {
      rmSync(runtimeRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; failures are not actionable here.
    }
  });
});
