import { catalog } from "@llamactl/core";
import { ENGINES } from "@llamactl/core/engines";
import { describe, expect, test } from "bun:test";
import { basename, isAbsolute, join, resolve } from "node:path";

import { specForEngine } from "../../src/workload/modelhost-schema.js";
import {
  asRecord,
  fileClaimingName,
  filesClaimingNodePort,
  loadModelHostTemplate,
} from "./template-arms.js";

/**
 * RED pins for frozename/llamactl#557 (S2): five tier-0 runtime-arm ModelHost
 * templates on z13 — GLM halo Vulkan + HIP, MiMo halo Vulkan + b12206 Vulkan,
 * DeepSeek IQ1_M HIP baseline. Every arm is engine llamacpp, committed
 * disabled, on the exclusive z13-large-gpu residency group, with its own
 * name, port, runtime-arm and backend labels. The templates do not exist
 * yet, so every case fails on the missing file until the GREEN slice lands
 * them. extraArgs, env, resources, rels and header pins mirror the impl
 * brief (05-runtime-engine-matrix.md sections 2.1, 2.3, 4.x).
 */
const HALO_BINARY =
  "/home/alex/strix-halo-bench/runtimes/llama.cpp-halo-529ac893e754-16da7de2a165/bin/llama-server";
const HALO_GLM_VOCAB =
  "/home/alex/strix-halo-bench/runtimes/halo-configs-16da7de2a165/glm-dv-65536.bin";
const HALO_MIMO_VOCAB =
  "/home/alex/strix-halo-bench/runtimes/halo-configs-16da7de2a165/mimo-dv-65536.bin";
const B12206_HIP_BINARY =
  "/home/alex/strix-halo-bench/runtimes/llama.cpp-cf34d311332e/bin/llama-server";
const B12206_VULKAN_BINARY =
  "/home/alex/strix-halo-bench/runtimes/llama.cpp-cf34d311332e/bin-vulkan/llama-server";
const GLM_A4E3S_REL =
  "GLM-5.3-Flash-a4e3s-j2ipper/5716e483/GLM-5.3-Flash-a4e3s-00001-of-00004.gguf";
const GLM_IQ2_XXS_REL =
  "GLM-5.3-Flash-GGUF/UD-IQ2_XXS/GLM-5.3-Flash-UD-IQ2_XXS-00001-of-00004.gguf";
const MIMO_MODEL_REL =
  "MiMo-V2.6-Flash-MOPD-GGUF-AesSedai/b6e95d58/BPW2.5/MiMo-V2.6-Flash-MOPD-BPW2.5-00001-of-00003.gguf";
const MIMO_DRAFT_REL =
  "MiMo-V2.6-Flash-MOPD-GGUF-ggml-org/c9d86979/dflash/dflash-MiMo-V2.6-Flash-MOPD-Q8_0.gguf";
const DS_IQ1_M_REL =
  "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/UD-IQ1_M/DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf";
const DS_DRAFT_REL =
  "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/dspark/dspark-DeepSeek-V4.1-Flash-1017-Q8_0.gguf";

const RESERVED_PORTS = [8080, 8081, 8082, 8083, 8084, 8091];

interface ArmResources {
  residentGiB?: number;
  diskBackedGiB?: number;
}

interface ArmSpec {
  file: string;
  name: string;
  port: number;
  arm: string;
  backend: string;
  family: string;
  binary: string;
  rel: string;
  env?: Record<string, string>;
  extraArgs: string[];
  resources: ArmResources;
  draftRel?: string;
  draftVocab?: string;
  headerPins: readonly string[];
  catalogRowId?: string;
}

const ARMS: readonly ArmSpec[] = [
  {
    file: "llamacpp-glm53-vulkan-halo-z13.yaml",
    name: "llamacpp-glm53-vulkan-halo",
    port: 8086,
    arm: "G-V1-e742170e08db",
    backend: "vulkan",
    family: "glm53",
    binary: HALO_BINARY,
    rel: GLM_A4E3S_REL,
    env: { GGML_VK_DMMV_LARGE_MAX_M: "1024", GGML_VK_DMMV_LARGE_MIN_K: "8192" },
    extraArgs: [
      "--served-model-name",
      "GLM-5.3-Flash-a4e3s-00001-of-00004.gguf",
      "--jinja",
      "-ngl",
      "99",
      "-ub",
      "1024",
      "--load-mode",
      "none",
      "-c",
      "65536",
      "--parallel",
      "1",
      "-ctxcp",
      "4",
      "--cache-ram",
      "0",
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      "2",
      "--spec-draft-ubatch",
      "128",
      "--spec-draft-sampling",
      "probabilistic",
      "--spec-draft-vocab",
      HALO_GLM_VOCAB,
    ],
    resources: { residentGiB: 112 },
    draftVocab: HALO_GLM_VOCAB,
    headerPins: [
      "529ac893e754",
      "16da7de2a165",
      "e742170e08db",
      "5716e4835f50",
      "[u]",
      "derived",
      "glm-dv-65536.bin",
      "catalog follow-up",
    ],
  },
  {
    file: "llamacpp-glm53-hip-b12206-z13.yaml",
    name: "llamacpp-glm53-hip-b12206",
    port: 8087,
    arm: "G-H1-cf34d311332e",
    backend: "hip",
    family: "glm53",
    binary: B12206_HIP_BINARY,
    rel: GLM_IQ2_XXS_REL,
    extraArgs: [
      "--served-model-name",
      "GLM-5.3-Flash-UD-IQ2_XXS-00001-of-00004.gguf",
      "--jinja",
      "-ngl",
      "99",
      "-fa",
      "on",
      "-ub",
      "1024",
      "--load-mode",
      "none",
      "-c",
      "65536",
      "--parallel",
      "1",
      "-ctxcp",
      "4",
      "--cache-ram",
      "0",
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      "2",
      "--spec-draft-n-ubatch",
      "128",
      "--spec-draft-sampling",
      "probabilistic",
    ],
    resources: { residentGiB: 100 },
    headerPins: [
      "cf34d311332e",
      "a38483c8",
      "todo(#557)",
      "unverified",
      "catalog.ts:158",
      "derived",
      "catalog follow-up",
    ],
  },
  {
    file: "llamacpp-mimo26-bpw25-vulkan-halo-z13.yaml",
    name: "llamacpp-mimo26-bpw25-vulkan-halo",
    port: 8088,
    arm: "M-V1-e742170e08db",
    backend: "vulkan",
    family: "mimo26",
    binary: HALO_BINARY,
    rel: MIMO_MODEL_REL,
    env: {
      GGML_VK_FA_WAVE32: "1",
      GGML_VK_FA_KV_SLICE: "8192",
      LLAMA_SPEC_ADAPTIVE: "1.2",
    },
    extraArgs: [
      "--served-model-name",
      "MiMo-V2.6-Flash-MOPD-BPW2.5-00001-of-00003.gguf",
      "--n-gpu-layers",
      "999",
      "--flash-attn",
      "on",
      "-fit",
      "off",
      "--load-mode",
      "none",
      "--parallel",
      "1",
      "--ctx-size",
      "131072",
      "-ctk",
      "q8_0",
      "-ctv",
      "q8_0",
      "--ubatch-size",
      "2048",
      "--batch-size",
      "2048",
      "--cache-ram",
      "0",
      "--jinja",
      "--temp",
      "1.0",
      "--top-p",
      "1.0",
      "--top-k",
      "20",
      "--min-p",
      "0.0",
      "-md",
      MIMO_DRAFT_REL,
      "-ngld",
      "999",
      "--spec-type",
      "draft-dflash",
      "--spec-draft-n-max",
      "4",
      "--spec-draft-vocab",
      HALO_MIMO_VOCAB,
    ],
    resources: { residentGiB: 98 },
    draftRel: MIMO_DRAFT_REL,
    draftVocab: HALO_MIMO_VOCAB,
    headerPins: [
      "529ac893e754",
      "16da7de2a165",
      "e742170e08db",
      "b6e95d58",
      "c9d86979",
      "[u]",
      "derived",
      "131072",
      "mimo-dv-65536.bin",
    ],
    catalogRowId: "mimo26-flash-mopd-bpw25",
  },
  {
    file: "llamacpp-mimo26-bpw25-vulkan-b12206-z13.yaml",
    name: "llamacpp-mimo26-bpw25-vulkan-b12206",
    port: 8089,
    arm: "M-V2-cf34d311332e",
    backend: "vulkan",
    family: "mimo26",
    binary: B12206_VULKAN_BINARY,
    rel: MIMO_MODEL_REL,
    extraArgs: [
      "--served-model-name",
      "MiMo-V2.6-Flash-MOPD-BPW2.5-00001-of-00003.gguf",
      "-ngl",
      "999",
      "-fa",
      "on",
      "-fit",
      "off",
      "--load-mode",
      "none",
      "--parallel",
      "1",
      "-c",
      "131072",
      "-ctk",
      "q8_0",
      "-ctv",
      "q8_0",
      "-ub",
      "2048",
      "-b",
      "2048",
      "--cache-ram",
      "0",
      "--jinja",
      "--temp",
      "1.0",
      "--top-p",
      "1.0",
      "--top-k",
      "20",
      "--min-p",
      "0.0",
      "-md",
      MIMO_DRAFT_REL,
      "-ngld",
      "999",
      "--spec-type",
      "draft-dflash",
      "--spec-draft-n-max",
      "4",
    ],
    resources: { residentGiB: 98 },
    draftRel: MIMO_DRAFT_REL,
    headerPins: ["cf34d311332e", "bin-vulkan", "b6e95d58", "derived"],
    catalogRowId: "mimo26-flash-mopd-bpw25",
  },
  {
    file: "llamacpp-ds41-ud-iq1m-hip-b12206-z13.yaml",
    name: "llamacpp-ds41-ud-iq1m-hip-b12206",
    port: 8090,
    arm: "D-L-cf34d311332e",
    backend: "hip",
    family: "deepseek41",
    binary: B12206_HIP_BINARY,
    rel: DS_IQ1_M_REL,
    extraArgs: [
      "--served-model-name",
      "DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf",
      "-c",
      "65536",
      "--spec-type",
      "draft-dspark",
      "-md",
      DS_DRAFT_REL,
    ],
    resources: { residentGiB: 130.2, diskBackedGiB: 103 },
    draftRel: DS_DRAFT_REL,
    headerPins: [
      "cf34d311332e",
      "2688c0c3",
      "baseline",
      "libosmos",
      "derived",
      "not measured",
      "exceeds",
      "116",
      "124.9",
      "catalog follow-up",
    ],
  },
];

for (const arm of ARMS) {
  describe(arm.file, () => {
    test("parses strictly as a ModelHost manifest", () => {
      const { raw, manifest } = loadModelHostTemplate(arm.file);
      expect(manifest.apiVersion).toBe("llamactl/v1");
      expect(manifest.kind).toBe("ModelHost");
      const record = asRecord(raw);
      expect(record?.["kind"]).toBe("ModelHost");
    });

    test("is committed disabled via an explicit enabled: false", () => {
      const { raw, manifest } = loadModelHostTemplate(arm.file);
      expect(manifest.spec.enabled).toBe(false);
      const spec = asRecord(asRecord(raw)?.["spec"]);
      expect(spec?.["enabled"]).toBe(false);
    });

    test(`is named ${arm.name}`, () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      expect(manifest.metadata.name).toBe(arm.name);
    });

    test("pins the z13 llamacpp identity, endpoint, binary and no probes", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const spec = manifest.spec;
      expect(spec.node).toBe("z13");
      expect(spec.engine).toBe("llamacpp");
      expect(spec.restartPolicy).toBe("Never");
      expect(spec.endpoint).toEqual({ host: "127.0.0.1", port: arm.port });
      expect(spec.binary).toBe(arm.binary);
      expect(isAbsolute(spec.binary)).toBe(true);
      expect(basename(spec.binary)).toBe("llama-server");
      expect(spec.binaryNames).toBeUndefined();
      expect(spec.readiness).toBeUndefined();
    });

    test("labels the arm experimental on the z13-large-gpu residency group", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const labels = manifest.metadata.labels;
      expect(labels?.["llamactl.io/qualification"]).toBe("experimental");
      expect(labels?.["llamactl.io/residency-group"]).toBe("z13-large-gpu");
      expect(labels?.["llamactl.io/runtime-arm"]).toBe(arm.arm);
      expect(labels?.["llamactl.io/backend"]).toBe(arm.backend);
      expect(labels?.["family"]).toBe(arm.family);
    });

    test("hosts exactly the pinned rel with served-model-name matching its basename", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const hosted = manifest.spec.hostedModels;
      expect(hosted).toHaveLength(1);
      const entry = hosted[0];
      expect(entry?.rel).toBe(arm.rel);
      expect(entry?.lora_path).toBeUndefined();
      expect(entry?.dflash).toBeUndefined();
      const args = manifest.spec.extraArgs;
      const idx = args.indexOf("--served-model-name");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe(basename(arm.rel));
    });

    test("declares the arm env or none", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      if (arm.env === undefined) {
        expect(manifest.spec.env).toBeUndefined();
      } else {
        expect(manifest.spec.env).toEqual(arm.env);
      }
    });

    test("pins the exact extraArgs without engine-owned flags", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const args = manifest.spec.extraArgs;
      expect(args).toEqual(arm.extraArgs);
      expect(args).not.toContain("--host");
      expect(args).not.toContain("--port");
      expect(args).not.toContain("-m");
      expect(args).not.toContain("--model");
    });

    test("resolves the model and drafter paths under the models dir at boot", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const spec = manifest.spec;
      const modelsDir = resolve("/fixture/models");
      const boot = ENGINES.llamacpp.buildBootCommand(specForEngine(spec), {
        LLAMACTL_MODELS_DIR: modelsDir,
      });
      expect(boot.binary).toBe(spec.binary);
      const modelIdx = boot.args.indexOf("-m");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(boot.args[modelIdx + 1]).toBe(join(modelsDir, arm.rel));
      if (arm.draftRel !== undefined) {
        const draftIdx = boot.args.indexOf("-md");
        expect(draftIdx).toBeGreaterThanOrEqual(0);
        expect(boot.args[draftIdx + 1]).toBe(join(modelsDir, arm.draftRel));
      }
      if (arm.draftVocab !== undefined) {
        const vocabIdx = boot.args.indexOf("--spec-draft-vocab");
        expect(vocabIdx).toBeGreaterThanOrEqual(0);
        const vocab = boot.args[vocabIdx + 1];
        expect(vocab).toBe(arm.draftVocab);
        expect(typeof vocab === "string" && isAbsolute(vocab)).toBe(true);
      }
    });

    test("declares the derived resident memory budget", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      expect(manifest.spec.resources).toEqual(arm.resources);
    });

    test("pins provenance in the leading header comment", () => {
      const { header } = loadModelHostTemplate(arm.file);
      for (const pin of arm.headerPins) {
        expect(header).toContain(pin);
      }
    });

    test("claims its name and z13 port uniquely and avoids reserved ports", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      expect(fileClaimingName(arm.name)).toEqual([arm.file]);
      expect(filesClaimingNodePort("z13", arm.port)).toEqual([arm.file]);
      expect(RESERVED_PORTS).not.toContain(manifest.spec.endpoint.port);
    });

    const catalogRowId = arm.catalogRowId;
    if (catalogRowId !== undefined) {
      test("joins the pinned catalog row rel and family", () => {
        const { manifest } = loadModelHostTemplate(arm.file);
        const row = catalog.BUILTIN_CATALOG.find((m) => m.id === catalogRowId);
        expect(row).toBeDefined();
        if (row === undefined) return;
        expect(manifest.spec.hostedModels[0]?.rel).toBe(row.rel);
        expect(manifest.metadata.labels?.["family"]).toBe(row.family);
      });
    }
  });
}
