import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { computeModelHostSpecHash } from "../../../core/src/engines/state.js";
import { readdirSync, readFileSync } from "../../src/safe-fs.js";
import {
  externalManagerOf,
  MANAGED_BY_LABEL,
  modelHostBindRefusal,
  type ModelHostManifest,
  ModelHostManifestSchema,
  specForEngine,
  specForHash,
} from "../../src/workload/modelhost-schema.js";

function hostWithLabels(labels?: Record<string, string>): ModelHostManifest {
  return ModelHostManifestSchema.parse({
    ...valid,
    metadata: { name: "host-a", ...(labels !== undefined ? { labels } : {}) },
  });
}

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

describe("externalManagerOf", () => {
  test("MANAGED_BY_LABEL is the documented label key", () => {
    expect(MANAGED_BY_LABEL).toBe("llamactl.io/managed-by");
  });

  test("returns the manager for a labeled manifest", () => {
    expect(externalManagerOf(hostWithLabels({ [MANAGED_BY_LABEL]: "mac-mini" }))).toBe("mac-mini");
  });

  test("returns null when metadata.labels is absent", () => {
    expect(externalManagerOf(hostWithLabels())).toBeNull();
  });

  test("returns null when only other labels are present", () => {
    expect(externalManagerOf(hostWithLabels({ tier: "prod" }))).toBeNull();
  });

  test("returns null for an empty label value", () => {
    expect(externalManagerOf(hostWithLabels({ [MANAGED_BY_LABEL]: "" }))).toBeNull();
  });

  test("returns null for a whitespace-only label value", () => {
    expect(externalManagerOf(hostWithLabels({ [MANAGED_BY_LABEL]: "  " }))).toBeNull();
  });

  test("trims surrounding whitespace from the manager", () => {
    expect(externalManagerOf(hostWithLabels({ [MANAGED_BY_LABEL]: "  mac-mini  " }))).toBe(
      "mac-mini",
    );
  });
});

// #516: binaryNames names the argv0 basenames a llama-server-compatible fork
// may run under, so pid-identity checks stop refusing the Gufo shim.
describe("spec.binaryNames (#516)", () => {
  const llamacppSpec = {
    ...valid.spec,
    engine: "llamacpp",
    binary: "/usr/local/bin/llama-server-fork-pristine",
    hostedModels: [{ rel: "gufo/model.gguf" }],
  };

  test("accepts binaryNames on a llamacpp spec", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...llamacppSpec, binaryNames: ["llama-server-fork-pristine"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec).toMatchObject({
        binaryNames: ["llama-server-fork-pristine"],
      });
    }
  });

  test.each([
    ["an empty list", []],
    ["an empty entry", [""]],
    ["a path entry", ["/opt/x/llama-server"]],
    ["a whitespace entry", ["a b"]],
    ["a backslash entry", ["a\\b"]],
  ] as const)("rejects binaryNames with %s", (_label, binaryNames) => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...llamacppSpec, binaryNames: [...binaryNames] },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.includes("binaryNames"))).toBe(true);
  });

  test("rejects binaryNames on a non-llamacpp engine", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, binaryNames: ["llama-server-fork-pristine"] },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.includes("binaryNames"))).toBe(true);
  });

  test("a spec without binaryNames parses with no binaryNames key", () => {
    const result = ModelHostManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect("binaryNames" in result.data.spec).toBe(false);
  });

  test("specForEngine never emits a binaryNames key", () => {
    const parsed = ModelHostManifestSchema.parse(valid);
    const withField = { ...parsed.spec, binaryNames: ["llama-server-fork-pristine"] };
    expect("binaryNames" in specForEngine(parsed.spec)).toBe(false);
    expect("binaryNames" in specForEngine(withField)).toBe(false);
  });

  test("binaryNames does not change the spec hash", () => {
    const parsed = ModelHostManifestSchema.parse({ ...valid, spec: { ...llamacppSpec } });
    const withField = { ...parsed.spec, binaryNames: ["llama-server-fork-pristine"] };
    expect(computeModelHostSpecHash(specForHash(withField))).toBe(
      computeModelHostSpecHash(specForHash(parsed.spec)),
    );
  });
});

// #277 C-2: spec.resources gains residentGiB (memory charged at admission) and
// diskBackedGiB (weights on disk, not resident). The fields are admission
// metadata: they must never leak into the launch spec hash or engine spec.
describe("spec.resources memory declarations (#277)", () => {
  test("accepts optional resources.residentGiB and diskBackedGiB; absent by default", () => {
    const withMemory = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: {
        ...valid.spec,
        resources: { expectedMemoryGiB: 12, residentGiB: 100, diskBackedGiB: 103 },
      },
    });
    expect(withMemory.success).toBe(true);
    if (!withMemory.success) return;
    expect(withMemory.data.spec.resources).toMatchObject({
      expectedMemoryGiB: 12,
      residentGiB: 100,
      diskBackedGiB: 103,
    });

    const base = ModelHostManifestSchema.safeParse(valid);
    expect(base.success).toBe(true);
    if (!base.success) return;
    expect("residentGiB" in (base.data.spec.resources ?? {})).toBe(false);
    expect("diskBackedGiB" in (base.data.spec.resources ?? {})).toBe(false);
  });

  test("rejects diskBackedGiB without residentGiB", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: {
        ...valid.spec,
        resources: { expectedMemoryGiB: 12, diskBackedGiB: 103 },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.at(-1) === "diskBackedGiB");
    expect(issue?.path).toEqual(["spec", "resources", "diskBackedGiB"]);
    expect(issue?.message).toContain("residentGiB");
  });

  test("rejects non-positive residentGiB and negative diskBackedGiB", () => {
    const rejected: { resources: Record<string, number>; field: string }[] = [
      { resources: { residentGiB: 0 }, field: "residentGiB" },
      { resources: { residentGiB: -1 }, field: "residentGiB" },
      { resources: { residentGiB: 5, diskBackedGiB: -1 }, field: "diskBackedGiB" },
    ];
    for (const { resources, field } of rejected) {
      const result = ModelHostManifestSchema.safeParse({
        ...valid,
        spec: { ...valid.spec, resources },
      });
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.issues.some((issue) => issue.path.at(-1) === field)).toBe(true);
    }
    const accepted = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, resources: { residentGiB: 5, diskBackedGiB: 0 } },
    });
    expect(accepted.success).toBe(true);
  });

  test("the new memory fields never change any template's spec hash or engine spec", () => {
    const templatesDir = join(import.meta.dir, "../../../../templates/workloads");
    const raws: unknown[] = [];
    for (const file of readdirSync(templatesDir)) {
      if (!file.endsWith(".yaml")) continue;
      const raw: unknown = parseYaml(readFileSync(join(templatesDir, file), "utf8"));
      if (typeof raw !== "object" || raw === null) continue;
      if ((raw as { kind?: unknown }).kind !== "ModelHost") continue;
      raws.push(raw);
    }
    expect(raws.length).toBeGreaterThan(0);
    for (const raw of raws) {
      const parsed = ModelHostManifestSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const spec = parsed.data.spec;
      const h0 = computeModelHostSpecHash(specForHash(spec));
      const e0 = specForEngine(spec);

      const clone = structuredClone(raw) as {
        spec?: { resources?: Record<string, number> };
      };
      clone.spec = {
        ...clone.spec,
        resources: { ...clone.spec?.resources, residentGiB: 7, diskBackedGiB: 3 },
      };
      const reparsed = ModelHostManifestSchema.safeParse(clone);
      expect(reparsed.success).toBe(true);
      if (!reparsed.success) continue;
      expect(reparsed.data.spec.resources).toMatchObject({ residentGiB: 7, diskBackedGiB: 3 });
      expect(computeModelHostSpecHash(specForHash(reparsed.data.spec))).toBe(h0);
      expect(specForEngine(reparsed.data.spec)).toStrictEqual(e0);
    }
  });

  test("resources holding only the new memory fields hash like legacy empty resources", () => {
    const specNoResources: Record<string, unknown> = { ...valid.spec };
    delete specNoResources["resources"];
    const parseWith = (
      resources: Record<string, number>,
    ): ReturnType<(typeof ModelHostManifestSchema)["safeParse"]> =>
      ModelHostManifestSchema.safeParse({ ...valid, spec: { ...specNoResources, resources } });

    const noResources = ModelHostManifestSchema.safeParse({ ...valid, spec: specNoResources });
    expect(noResources.success).toBe(true);
    if (!noResources.success) return;

    const emptyResources = parseWith({});
    expect(emptyResources.success).toBe(true);
    if (!emptyResources.success) return;
    expect(specForHash(emptyResources.data.spec).resources).toStrictEqual({});
    const hEmpty = computeModelHostSpecHash(specForHash(emptyResources.data.spec));
    expect(computeModelHostSpecHash(specForHash(noResources.data.spec))).not.toBe(hEmpty);

    const newFieldsOnly: Record<string, number>[] = [
      { residentGiB: 5 },
      { residentGiB: 5, diskBackedGiB: 2 },
    ];
    for (const resources of newFieldsOnly) {
      const result = parseWith(resources);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(specForHash(result.data.spec).resources).toStrictEqual({});
      expect(computeModelHostSpecHash(specForHash(result.data.spec))).toBe(hEmpty);
    }

    const expectedOnly = parseWith({ expectedMemoryGiB: 12 });
    expect(expectedOnly.success).toBe(true);
    if (!expectedOnly.success) return;
    expect(specForHash(expectedOnly.data.spec).resources).toStrictEqual({
      expectedMemoryGiB: 12,
    });
  });
});

// #557 S3: libosmos joins the engine enum; binaryNames stays llamacpp-only.
describe("engine=libosmos (#557)", () => {
  const libosmosSpec = {
    ...valid.spec,
    engine: "libosmos",
    binary: "/usr/local/bin/osmos-api",
    hostedModels: [
      {
        rel: "DeepSeek-V4.1-Flash-1017-GGUF/UD-IQ1_M/DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf",
      },
    ],
    extraArgs: ["--max-context", "65536"],
  };

  test("accepts a libosmos manifest and threads the engine through", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: libosmosSpec,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(specForEngine(result.data.spec).engine as string).toBe("libosmos");
    }
  });

  test("rejects binaryNames on a libosmos spec with an issue on binaryNames", () => {
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...libosmosSpec, binaryNames: ["osmos-api"] },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.includes("binaryNames"))).toBe(true);
  });

  // GUARD (#557 S3): the production Gufo llamacpp manifest must keep hashing
  // byte-identically — readiness and binaryNames stay outside the hash.
  test("hashes a production Gufo llamacpp manifest byte-identically", () => {
    const manifest = ModelHostManifestSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "gufo-host" },
      spec: {
        engine: "llamacpp",
        node: "local",
        binary: "/home/alex/strix-halo-bench/gufo/bin/llama-server-fork-pristine",
        endpoint: { host: "127.0.0.1", port: 8080 },
        hostedModels: [{ rel: "Qwen3.8-Flash-Next-GGUF/Qwen3.8-Flash-Next-Q4_K_M.gguf" }],
        extraArgs: ["--served-model-name", "Qwen3.8-Flash-Next-Q4_K_M.gguf", "--context", "131072"],
        resources: { expectedMemoryGiB: 60 },
        restartPolicy: "Always",
        timeoutSeconds: 600,
        env: { ROCBLAS_USE_HIPBLASLT: "1" },
        binaryNames: ["llama-server-fork-pristine"],
        readiness: { path: "/ready", expectStatus: 200 },
      },
    });
    expect(computeModelHostSpecHash(specForHash(manifest.spec))).toBe(
      '{"engine":"llamacpp","binary":"/home/alex/strix-halo-bench/gufo/bin/llama-server-fork-pristine","endpoint":{"host":"127.0.0.1","port":8080},"hostedModels":[{"rel":"Qwen3.8-Flash-Next-GGUF/Qwen3.8-Flash-Next-Q4_K_M.gguf"}],"extraArgs":["--served-model-name","Qwen3.8-Flash-Next-Q4_K_M.gguf","--context","131072"],"resources":{"expectedMemoryGiB":60},"restartPolicy":"Always","timeoutSeconds":600,"env":{"ROCBLAS_USE_HIPBLASLT":"1"}}',
    );
  });
});
