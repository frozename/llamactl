import { describe, expect, test } from "bun:test";

import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";

const base = {
  apiVersion: "llamactl/v1",
  kind: "ModelHost",
  metadata: { name: "mlx-host-local" },
  spec: {
    engine: "omlx",
    node: "local",
    enabled: true,
    binary: "/Volumes/WorkSSD/src/omlx/.venv/bin/omlx",
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
        },
      },
    ],
    extraArgs: [],
    restartPolicy: "Always",
    timeoutSeconds: 60,
  },
};

describe("ModelHostManifestSchema dflash", () => {
  test("round-trips hostedModels[0].dflash", () => {
    const parsed = ModelHostManifestSchema.parse(base);
    expect(parsed.spec.hostedModels[0]?.dflash).toEqual(base.spec.hostedModels[0]!.dflash);
  });

  test("round-trips without dflash", () => {
    const parsed = ModelHostManifestSchema.parse({
      ...base,
      spec: {
        ...base.spec,
        hostedModels: [{ rel: base.spec.hostedModels[0]!.rel }],
      },
    });
    expect(parsed.spec.hostedModels[0]?.dflash).toBeUndefined();
  });

  test("rejects unknown fields inside dflash", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...base,
      spec: {
        ...base.spec,
        hostedModels: [
          {
            ...base.spec.hostedModels[0]!,
            dflash: {
              ...base.spec.hostedModels[0]!.dflash,
              unexpected: true,
            },
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});
