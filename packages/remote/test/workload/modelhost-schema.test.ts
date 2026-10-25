import { describe, expect, test } from "bun:test";

import {
  modelHostBindRefusal,
  ModelHostManifestSchema,
  specForEngine,
} from "../../src/workload/modelhost-schema.js";

const valid = {
  apiVersion: "llamactl/v1",
  kind: "ModelHost",
  metadata: { name: "mlx-host-local" },
  spec: {
    engine: "omlx",
    node: "local",
    enabled: true,
    binary: "/Volumes/WorkSSD/src/omlx/.venv/bin/omlx",
    resources: { expectedMemoryGiB: 12 },
    endpoint: { host: "127.0.0.1", port: 8094 },
    hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
    extraArgs: ["--max-concurrent-requests", "4"],
    restartPolicy: "Always",
    timeoutSeconds: 60,
  },
};

describe("ModelHostManifestSchema", () => {
  test("accepts a valid manifest", () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("accepts engine=llamacpp (registry-wired engine)", () => {
    const llamacppManifest = {
      ...valid,
      spec: {
        ...valid.spec,
        engine: "llamacpp",
        binary: "/usr/local/bin/llama-server",
        hostedModels: [{ rel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf" }],
      },
    };
    const result = ModelHostManifestSchema.safeParse(llamacppManifest);
    expect(result.success).toBe(true);
  });

  test("accepts engine=strata (registry-wired engine)", () => {
    const strataManifest = {
      ...valid,
      spec: {
        ...valid.spec,
        engine: "strata",
        binary: "/usr/local/bin/strata-server",
        hostedModels: [{ rel: "strata/qwen3-8b.safetensors" }],
      },
    };
    const result = ModelHostManifestSchema.safeParse(strataManifest);
    expect(result.success).toBe(true);
  });

  test("rejects engine string outside the enum", () => {
    const bad = { ...valid, spec: { ...valid.spec, engine: "vllm-mlx" } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects missing endpoint.port (no default)", () => {
    const bad = { ...valid, spec: { ...valid.spec, endpoint: { host: "127.0.0.1" } } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects empty hostedModels (Sub A min length 1)", () => {
    const bad = { ...valid, spec: { ...valid.spec, hostedModels: [] } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects hostedModels length > 1 (Sub A max length 1)", () => {
    const bad = {
      ...valid,
      spec: {
        ...valid.spec,
        hostedModels: [{ rel: "mlx-community/A" }, { rel: "mlx-community/B" }],
      },
    };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("accepts hostedModels[].lora_path (train -> serve adapter edge)", () => {
    const manifest = {
      ...valid,
      spec: {
        ...valid.spec,
        engine: "llamacpp",
        binary: "/usr/local/bin/llama-server",
        hostedModels: [
          {
            rel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
            lora_path: "adapters/granite-sql-lora.gguf",
          },
        ],
      },
    };
    const result = ModelHostManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec.hostedModels[0]?.lora_path).toBe("adapters/granite-sql-lora.gguf");
    }
  });

  test("rejects empty lora_path string", () => {
    const bad = {
      ...valid,
      spec: {
        ...valid.spec,
        hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit", lora_path: "" }],
      },
    };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("omitting lora_path leaves it undefined (back-compat)", () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec.hostedModels[0]?.lora_path).toBeUndefined();
    }
  });

  test("rejects manifest with stray `target` field (ModelRun-only)", () => {
    const bad = {
      ...valid,
      spec: { ...valid.spec, target: { kind: "rel", value: "foo" } },
    };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects manifest with stray `workers` field (ModelRun-only)", () => {
    const bad = { ...valid, spec: { ...valid.spec, workers: [] } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects empty binary string (no PATH fallback for ModelHost)", () => {
    const bad = { ...valid, spec: { ...valid.spec, binary: "" } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects kind other than ModelHost", () => {
    const bad = { ...valid, kind: "ModelRun" };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("accepts spec.env with string values", () => {
    const manifest = {
      ...valid,
      spec: { ...valid.spec, env: { FOO: "bar", MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1" } },
    };
    const result = ModelHostManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec.env).toEqual({ FOO: "bar", MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1" });
    }
  });

  test("rejects spec.env with non-string values", () => {
    const bad = { ...valid, spec: { ...valid.spec, env: { FOO: 123 } } };
    const result = ModelHostManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("accepts manifest without spec.env (back-compat)", () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec.env).toBeUndefined();
    }
  });

  test("accepts optional priority in 0-100 range", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, priority: 80 },
    });
    expect(result.success).toBe(true);
  });

  test("rejects priority above 100", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, priority: 101 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects priority below 0", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, priority: -1 },
    });
    expect(result.success).toBe(false);
  });

  test("omitting priority leaves it undefined (no forced default)", () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.spec.priority).toBeUndefined();
  });

  test("accepts allowExternalBind true and false", () => {
    for (const allowExternalBind of [true, false]) {
      const result = ModelHostManifestSchema.safeParse({
        ...valid,
        spec: { ...valid.spec, allowExternalBind },
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects non-boolean allowExternalBind", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, allowExternalBind: "yes" },
    });
    expect(result.success).toBe(false);
  });

  test("omitting allowExternalBind leaves it undefined (absent means false)", () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.spec.allowExternalBind).toBeUndefined();
  });
});

describe("spec.readiness", () => {
  test("accepts a readiness probe on a ModelHost manifest", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: {
        ...valid.spec,
        readiness: { path: "/ready", expectStatus: 200, expectJson: { status: "ready" } },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec.readiness).toEqual({
        path: "/ready",
        expectStatus: 200,
        expectJson: { status: "ready" },
      });
    }
  });

  test("defaults expectStatus to 200 when omitted", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, readiness: { path: "/ready" } },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.spec.readiness?.expectStatus).toBe(200);
  });

  test("rejects a readiness path without a leading slash", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, readiness: { path: "ready" } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown keys inside readiness", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, readiness: { path: "/ready", timeoutMs: 500 } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-scalar expectJson values", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, readiness: { path: "/ready", expectJson: { meta: { a: 1 } } } },
    });
    expect(result.success).toBe(false);
  });

  test("omitting readiness leaves it undefined (today's behaviour)", () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.spec.readiness).toBeUndefined();
  });

  test("specForEngine threads readiness to the engine layer", () => {
    const parsed = ModelHostManifestSchema.parse({
      ...valid,
      spec: { ...valid.spec, readiness: { path: "/ready", expectJson: { status: "ready" } } },
    });
    expect(specForEngine(parsed.spec).readiness).toEqual({
      path: "/ready",
      expectStatus: 200,
      expectJson: { status: "ready" },
    });
  });
});

describe("modelHostBindRefusal", () => {
  test("returns null for loopback endpoint hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const manifest = ModelHostManifestSchema.parse({
        ...valid,
        spec: { ...valid.spec, endpoint: { host, port: 8094 } },
      });
      expect(modelHostBindRefusal(manifest)).toBeNull();
    }
  });

  test("refuses an endpoint host of 0.0.0.0 without the opt-in", () => {
    const manifest = ModelHostManifestSchema.parse({
      ...valid,
      spec: { ...valid.spec, endpoint: { host: "0.0.0.0", port: 8094 } },
    });
    const refusal = modelHostBindRefusal(manifest);
    expect(refusal).toContain("0.0.0.0");
    expect(refusal).toContain("allowExternalBind");
  });

  test("refuses a --host override in extraArgs that escapes loopback", () => {
    const trailing = ModelHostManifestSchema.parse({
      ...valid,
      spec: { ...valid.spec, extraArgs: ["--host", "0.0.0.0"] },
    });
    expect(modelHostBindRefusal(trailing)).toContain("0.0.0.0");
    const inline = ModelHostManifestSchema.parse({
      ...valid,
      spec: { ...valid.spec, extraArgs: ["--host=192.168.1.5"] },
    });
    expect(modelHostBindRefusal(inline)).toContain("192.168.1.5");
  });

  test("returns null when allowExternalBind is true", () => {
    const manifest = ModelHostManifestSchema.parse({
      ...valid,
      spec: {
        ...valid.spec,
        endpoint: { host: "0.0.0.0", port: 8094 },
        extraArgs: ["--host", "0.0.0.0"],
        allowExternalBind: true,
      },
    });
    expect(modelHostBindRefusal(manifest)).toBeNull();
  });
});
