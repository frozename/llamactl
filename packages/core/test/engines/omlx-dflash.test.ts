import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ModelHostSpecForEngine } from "../../src/engines/types.js";

import { ENGINES } from "../../src/engines/index.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

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

  test.each([
    { form: "separate", extraArgs: ["--base-path", "/tmp/alternate"] },
    { form: "inline", extraArgs: ["--base-path=/tmp/alternate"] },
  ])("declared model settings refuse an overriding base path ($form)", async ({ extraArgs }) => {
    const spec = {
      ...baseSpec,
      hostedModels: [{ rel: baseSpec.hostedModels[0]!.rel, omlx: { max_tokens: 128 } }],
      extraArgs: [...extraArgs],
    };
    const env = {
      LLAMA_CPP_MODELS: "/unused/models",
      LLAMACTL_RUNTIME_DIR: runtimeRoot,
      workloadName: "settings-override",
    };
    expect(() => ENGINES.omlx.buildBootCommand(spec, env)).toThrow("base-path");
    let preparationError: unknown;
    try {
      await ENGINES.omlx.prepareLaunch?.(spec, env);
    } catch (error) {
      preparationError = error;
    }
    expect(preparationError).toEqual(
      new Error("oMLX model settings require the workload's --base-path"),
    );
    expect(existsSync(join(runtimeRoot, "workloads", "settings-override"))).toBe(false);
  });

  test("a host with no manifest settings retains its legacy launch and settings file", async () => {
    const spec = {
      ...baseSpec,
      hostedModels: [{ rel: baseSpec.hostedModels[0]!.rel }],
    };
    const env = {
      LLAMA_CPP_MODELS: "/unused/models",
      LLAMACTL_RUNTIME_DIR: runtimeRoot,
      workloadName: "legacy-settings",
    };
    const basePath = join(runtimeRoot, "workloads", "legacy-settings", ".omlx");
    mkdirSync(basePath, { recursive: true });
    const settings = join(basePath, "model_settings.json");
    writeFileSync(settings, "opaque legacy file");
    expect(ENGINES.omlx.buildBootCommand(spec, env).args).not.toContain("--base-path");
    const customSpec = { ...spec, extraArgs: ["--base-path", "/legacy/omlx"] };
    expect(ENGINES.omlx.buildBootCommand(customSpec, env).args.slice(-2)).toEqual([
      "--base-path",
      "/legacy/omlx",
    ]);
    await ENGINES.omlx.prepareLaunch?.(spec, env);
    expect(readFileSync(settings, "utf8")).toBe("opaque legacy file");
  });

  test("replaces stale DFlash options without dropping declared context settings", async () => {
    const model = baseSpec.hostedModels[0]!;
    const spec = {
      ...baseSpec,
      hostedModels: [
        {
          rel: model.rel,
          dflash: { enabled: true, dflash_draft_model: "current-draft" },
          omlx: { max_context_window: 4096 },
        },
      ],
    };
    const env = {
      LLAMA_CPP_MODELS: "/unused/models",
      LLAMACTL_RUNTIME_DIR: runtimeRoot,
      workloadName: "combined-settings",
    };
    const basePath = join(runtimeRoot, "workloads", "combined-settings", ".omlx");
    mkdirSync(basePath, { recursive: true });
    const settings = join(basePath, "model_settings.json");
    const id = basename(model.rel);
    writeFileSync(
      settings,
      JSON.stringify({
        version: 1,
        models: { [id]: { dflash_draft_model: "old-draft", dflash_in_memory_cache: true } },
      }),
    );
    await ENGINES.omlx.prepareLaunch?.(spec, env);
    const expected = {
      version: 1,
      models: {
        [id]: {
          dflash_enabled: true,
          dflash_draft_model: "current-draft",
          max_context_window: 4096,
        },
      },
    };
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(expected);
    const prepared = readFileSync(settings, "utf8");
    await ENGINES.omlx.prepareLaunch?.(spec, env);
    expect(readFileSync(settings, "utf8")).toBe(prepared);
  });

  afterAll(() => {
    try {
      // Remove the whole mkdir'd directory, not just the binary inside it (#870).
      rmSync(dirname(fakeBinary), { recursive: true, force: true });
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
