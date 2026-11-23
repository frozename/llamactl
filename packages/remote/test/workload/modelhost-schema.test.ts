import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
// Side-effect import: the #806 phase-3 mutant gate enumerates only this file
// (plus engine-survival/modelhost.test) under packages/remote, so the
// unchanged-spec adopt gates in engine-adopt-modelhost.test.ts must register
// from here for the mutants to be killed.
import "../server/engine-adopt-modelhost.test.js";

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

// #806 phase 2: adopt-instead-of-restart keys on this hash, so pin the full
// manifest pipeline — ModelHostManifestSchema.parse -> specForHash ->
// computeModelHostSpecHash -> sha256 — end to end. The literals below were
// generated at base 273437d9; they complement (not duplicate) the spec-level
// pins in packages/core/test/engines/state-records.test.ts (:353 BASE_SPEC,
// :375 Gufo) and the manifest-level Gufo pin directly above.
describe("spec-hash golden pins (#806)", () => {
  const GOLDEN_BIN = "/opt/llamactl-golden/bin/llama-server";

  const goldenHash = (manifest: unknown): { hash: string; sha256: string } => {
    const parsed = ModelHostManifestSchema.parse(manifest);
    const hash = computeModelHostSpecHash(specForHash(parsed.spec));
    return { hash, sha256: createHash("sha256").update(hash).digest("hex") };
  };

  const minimal = {
    ...valid,
    spec: {
      engine: "llamacpp",
      node: "local",
      binary: GOLDEN_BIN,
      endpoint: { host: "127.0.0.1", port: 18080 },
      hostedModels: [{ rel: "golden/model.gguf" }],
    },
  };

  const omlx = {
    ...valid,
    spec: {
      engine: "omlx",
      node: "local",
      binary: "/opt/llamactl-golden/bin/omlx",
      resources: { expectedMemoryGiB: 24, residentGiB: 20 },
      endpoint: { host: "127.0.0.1", port: 18081 },
      hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
      extraArgs: ["--max-concurrent-requests", "4"],
      env: { MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1" },
      restartPolicy: "OnFailure",
      timeoutSeconds: 120,
    },
  };

  // apiKeyRef is a ref name (env:GOLDEN_KEY), never a secret value; readiness
  // must be /health because apiKeyRef restricts the probe to unauthenticated
  // llama-server endpoints.
  const full = {
    ...valid,
    metadata: { ...valid.metadata, labels: { tier: "golden" } },
    spec: {
      engine: "llamacpp",
      node: "local",
      binary: GOLDEN_BIN,
      endpoint: { host: "127.0.0.1", port: 18082 },
      hostedModels: [{ rel: "golden/model.gguf", lora_path: "golden/adapters/lora.gguf" }],
      extraArgs: [],
      restartPolicy: "Never",
      timeoutSeconds: 45,
      apiKeyRef: "env:GOLDEN_KEY",
      binaryNames: ["llama-server"],
      readiness: { path: "/health" },
      priority: 10,
    },
  };

  const MINIMAL_HASH =
    '{"engine":"llamacpp","binary":"/opt/llamactl-golden/bin/llama-server","endpoint":{"host":"127.0.0.1","port":18080},"hostedModels":[{"rel":"golden/model.gguf"}],"extraArgs":[],"resources":null,"restartPolicy":"Always","timeoutSeconds":60,"env":null}';
  const MINIMAL_SHA256 = "5620982787fd8a1673a6431a85d4d6749951416135fb1bf5c86272494c4aa53f";
  const OMLX_HASH =
    '{"engine":"omlx","binary":"/opt/llamactl-golden/bin/omlx","endpoint":{"host":"127.0.0.1","port":18081},"hostedModels":[{"rel":"mlx-community/Qwen3-8B-MLX-4bit"}],"extraArgs":["--max-concurrent-requests","4"],"resources":{"expectedMemoryGiB":24},"restartPolicy":"OnFailure","timeoutSeconds":120,"env":{"MLX_METAL_MAX_INFLIGHT_PER_STREAM":"1"}}';
  const OMLX_SHA256 = "f6ae90d7ccaf6cc73ed4ee197ddf1d65572a43e0583276d6d981533ef9db73ea";
  const FULL_HASH =
    '{"engine":"llamacpp","binary":"/opt/llamactl-golden/bin/llama-server","endpoint":{"host":"127.0.0.1","port":18082},"hostedModels":[{"rel":"golden/model.gguf","lora_path":"golden/adapters/lora.gguf"}],"extraArgs":[],"resources":null,"restartPolicy":"Never","timeoutSeconds":45,"env":null,"apiKeyRef":"env:GOLDEN_KEY"}';
  const FULL_SHA256 = "eab7ca3a18c7ee8eea0306ebe315a0713efe76742a0a965ed97bdc5f67fbf6e9";

  test.each([
    ["minimal llamacpp", minimal, MINIMAL_HASH, MINIMAL_SHA256],
    ["omlx", omlx, OMLX_HASH, OMLX_SHA256],
    ["hosted llamacpp", full, FULL_HASH, FULL_SHA256],
  ] as const)(
    "hashes the %s manifest to the golden literal",
    (_label, manifest, expectedHash, expectedSha256) => {
      // Kills: adding a field to the hash object, reordering its keys,
      // hashing the unparsed spec, or switching the stored value to a
      // digest instead of canonical JSON.
      const parsed = ModelHostManifestSchema.safeParse(manifest);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const { hash, sha256 } = goldenHash(manifest);
      expect(hash).toBe(expectedHash);
      expect(hash.startsWith("{")).toBe(true);
      expect(sha256).toBe(expectedSha256);
      expect(sha256).toHaveLength(64);
    },
  );

  test("explicit defaults hash identically to omitted defaults", () => {
    // Kills: hashing the raw spec instead of the parsed one — `minimal`
    // omits extraArgs/restartPolicy/timeoutSeconds, so a raw hash diverges
    // from the explicit-defaults manifest and this direct comparison fails;
    // comparing against a golden literal here could not (the literal already
    // carries the parsed-in defaults).
    const explicit = {
      ...minimal,
      spec: {
        ...minimal.spec,
        enabled: true,
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
      },
    };
    expect(goldenHash(explicit).hash).toBe(goldenHash(minimal).hash);
  });

  test("readiness, priority, labels and binaryNames stay outside the hash", () => {
    // Kills: folding readiness/priority/labels/binaryNames into the hash —
    // `full` carries all of them, `stripped` omits them, so a hash that
    // included any of the two-out-of-hash fields would make the direct
    // comparison fail on its own.
    const stripped = {
      ...valid,
      spec: {
        engine: "llamacpp",
        node: "local",
        binary: GOLDEN_BIN,
        endpoint: { host: "127.0.0.1", port: 18082 },
        hostedModels: [{ rel: "golden/model.gguf", lora_path: "golden/adapters/lora.gguf" }],
        extraArgs: [],
        restartPolicy: "Never",
        timeoutSeconds: 45,
        apiKeyRef: "env:GOLDEN_KEY",
      },
    };
    expect(goldenHash(full).hash).toBe(goldenHash(stripped).hash);
  });

  test("resources.residentGiB stays outside the hash", () => {
    // Kills: hashing spec.resources verbatim instead of reshaping it to
    // expectedMemoryGiB only — `omlx` declares residentGiB, `withoutResident`
    // omits it, so only the direct comparison distinguishes the two.
    const withoutResident = {
      ...omlx,
      spec: { ...omlx.spec, resources: { expectedMemoryGiB: 24 } },
    };
    expect(goldenHash(omlx).hash).toBe(goldenHash(withoutResident).hash);
  });
});

// #214: spec.apiKeyRef names a secret ref whose resolved value the llamacpp
// launch injects into the child env as LLAMA_API_KEY — the only way an
// allowed external bind stays authenticated. The field is llamacpp-only,
// owns LLAMA_API_KEY against spec.env and --api-key* argv, and constrains
// readiness.path to endpoints that answer before auth is required.
describe("spec.apiKeyRef (#214)", () => {
  const llamacppSpec = {
    ...valid.spec,
    engine: "llamacpp",
    binary: "/usr/local/bin/llama-server",
    hostedModels: [{ rel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf" }],
  };

  const issueAt = (
    result: ReturnType<typeof ModelHostManifestSchema.safeParse>,
    path: readonly string[],
    message: string,
  ): boolean => {
    if (result.success) return false;
    return result.error.issues.some(
      (issue) => JSON.stringify(issue.path) === JSON.stringify(path) && issue.message === message,
    );
  };

  test("accepts apiKeyRef on a llamacpp ModelHost", () => {
    // Kills: removing the field.
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...llamacppSpec, apiKeyRef: "env:MH_TEST_KEY" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spec).toMatchObject({ apiKeyRef: "env:MH_TEST_KEY" });
    }
  });

  test("omitting apiKeyRef leaves it undefined (back-compat pin)", () => {
    // BACK-COMPAT PIN: passes at base; kills a defaulted apiKeyRef.
    const result = ModelHostManifestSchema.safeParse({ ...valid, spec: llamacppSpec });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("apiKeyRef" in result.data.spec).toBe(false);
    }
  });

  test("rejects apiKeyRef on a non-llamacpp engine", () => {
    // Kills: dropping the engine refinement.
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...valid.spec, apiKeyRef: "env:MH_TEST_KEY" },
    });
    expect(result.success).toBe(false);
    expect(
      issueAt(result, ["spec", "apiKeyRef"], "apiKeyRef is only supported for engine llamacpp"),
    ).toBe(true);
  });

  test("rejects env.LLAMA_API_KEY alongside apiKeyRef", () => {
    // Kills: dropping the env-conflict refinement.
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: {
        ...llamacppSpec,
        apiKeyRef: "env:MH_TEST_KEY",
        env: { LLAMA_API_KEY: "fixture-key-not-a-secret" },
      },
    });
    expect(result.success).toBe(false);
    expect(
      issueAt(result, ["spec", "env", "LLAMA_API_KEY"], "LLAMA_API_KEY is owned by spec.apiKeyRef"),
    ).toBe(true);
  });

  test.each([
    [["--api-key", "x"]],
    [["--api-key=x"]],
    [["--api-key-file", "/k"]],
    [["--api-key-file=/k"]],
  ] as const)("rejects extraArgs %j alongside apiKeyRef", (extraArgs) => {
    // Kills: dropping the extraArgs refinement.
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...llamacppSpec, apiKeyRef: "env:MH_TEST_KEY", extraArgs: [...extraArgs] },
    });
    expect(result.success).toBe(false);
    expect(
      issueAt(
        result,
        ["spec", "extraArgs"],
        "--api-key flags in extraArgs conflict with spec.apiKeyRef",
      ),
    ).toBe(true);
  });

  test.each(["/ready", "/slots", "/props"] as const)(
    "rejects readiness.path %s alongside apiKeyRef",
    (path) => {
      // Kills: dropping the readiness refinement — without it every start of
      // such a host returns 401 on the probe, times out and is torn down.
      const result = ModelHostManifestSchema.safeParse({
        ...valid,
        spec: { ...llamacppSpec, apiKeyRef: "env:MH_TEST_KEY", readiness: { path } },
      });
      expect(result.success).toBe(false);
      expect(
        issueAt(
          result,
          ["spec", "readiness", "path"],
          "readiness.path must be an unauthenticated llama-server endpoint (/health, /v1/health, /models, /v1/models, /api/tags) when spec.apiKeyRef is set",
        ),
      ).toBe(true);
    },
  );

  test.each(["/health", "/v1/models", "/health?x=1"] as const)(
    "accepts unauthenticated readiness.path %s alongside apiKeyRef",
    (path) => {
      // Kills: an over-strict refinement that rejects public endpoints or
      // ignores query-string stripping.
      const result = ModelHostManifestSchema.safeParse({
        ...valid,
        spec: { ...llamacppSpec, apiKeyRef: "env:MH_TEST_KEY", readiness: { path } },
      });
      expect(result.success).toBe(true);
    },
  );

  test("readiness.path is unconstrained without apiKeyRef (back-compat pin)", () => {
    // BACK-COMPAT PIN: passes at base; kills constraining readiness.path
    // unconditionally.
    const result = ModelHostManifestSchema.safeParse({
      ...valid,
      spec: { ...llamacppSpec, readiness: { path: "/ready" } },
    });
    expect(result.success).toBe(true);
  });
});
