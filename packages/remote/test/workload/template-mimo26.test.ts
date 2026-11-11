import { catalog } from "@llamactl/core";
import { ENGINES } from "@llamactl/core/engines";
import { describe, expect, test } from "bun:test";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

import { existsSync, readFileSync } from "../../src/safe-fs.js";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
  ModelHostSpecSchema,
  specForEngine,
} from "../../src/workload/modelhost-schema.js";
import {
  asRecord,
  carriers,
  expectArmGroup,
  fileClaimingName,
  filesClaimingNodePort,
  hostedModelRels,
  modelRunsTargetingRel,
  residencyGroupLabel,
  templateDocs,
  TEMPLATES_DIR,
} from "./template-arms.js";

/**
 * Pins frozename/llamactl#515 (D-3, rel fix in C-3): the MiMo-V2.6-Flash MOPD
 * BPW2.5 GGUF is served on z13 by a disabled, experimental ModelHost template
 * on upstream llama.cpp b12206 @ cf34d311332e (no Gufo fork identity, no
 * /ready probe). The drafter file is pinned and stays a models-dir-relative
 * path so the engine boot command resolves it, and the hosted rel is the
 * pinned models-root layout the catalog row also carries. The runtime is
 * pinned to llama.cpp-cf34d311332e. --spec-type draft-dflash + -md replace
 * the old -md-only wiring. The last cases guard the catalog rel, the
 * metadata name and the z13-large-gpu residency group: the rel may be carried
 * by several disabled arm templates (#557) as long as each claims a distinct
 * name and z13 port, and no ModelRun targets the rels.
 */
const FILE = "llamacpp-mimo26-flash-bpw25-z13.yaml";
const NAME = "llamacpp-mimo26-flash-bpw25";
const MODEL_REL =
  "MiMo-V2.6-Flash-MOPD-GGUF-AesSedai/b6e95d58/BPW2.5/MiMo-V2.6-Flash-MOPD-BPW2.5-00001-of-00003.gguf";
const DRAFT_REL =
  "MiMo-V2.6-Flash-MOPD-GGUF-ggml-org/c9d86979/dflash/dflash-MiMo-V2.6-Flash-MOPD-Q8_0.gguf";
const DRAFT_DIR = "MiMo-V2.6-Flash-MOPD-GGUF-ggml-org/c9d86979/dflash/";
const RUNTIME_PREFIX = "/home/alex/strix-halo-bench/runtimes/llama.cpp-cf34d311332e/";
const MIMO_ROW = catalog.BUILTIN_CATALOG.find((m) => m.id === "mimo26-flash-mopd-bpw25");

function loadTemplate(): unknown {
  const path = join(TEMPLATES_DIR, FILE);
  if (!existsSync(path)) return null;
  return parse(readFileSync(path, "utf8")) as unknown;
}

function loadManifest(): { raw: unknown; manifest: ModelHostManifest } {
  const raw = loadTemplate();
  expect(raw).not.toBeNull();
  const result = ModelHostManifestSchema.safeParse(raw);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("llamacpp-mimo26-flash-bpw25-z13.yaml must parse as a ModelHost manifest");
  }
  return { raw, manifest: result.data };
}

function draftArgValue(args: readonly string[]): string {
  const mdIdx = args.indexOf("-md");
  const draft = args[mdIdx + 1];
  if (draft === undefined) {
    throw new Error("expected -md to be followed by a drafter path");
  }
  return draft;
}

describe("llamacpp-mimo26-flash-bpw25-z13.yaml (#515 D-3)", () => {
  test("parses strictly as a ModelHost manifest", () => {
    const raw = loadTemplate();
    expect(raw).not.toBeNull();
    const manifest = ModelHostManifestSchema.safeParse(raw);
    expect(manifest.success).toBe(true);
    const record = asRecord(raw);
    expect(record?.["kind"]).toBe("ModelHost");
    expect(ModelHostSpecSchema.safeParse(record?.["spec"]).success).toBe(true);
  });

  test("is committed disabled via an explicit enabled: false", () => {
    const { raw, manifest } = loadManifest();
    expect(manifest.spec.enabled).toBe(false);
    const spec = asRecord(asRecord(raw)?.["spec"]);
    expect(spec?.["enabled"]).toBe(false);
  });

  test("is named llamacpp-mimo26-flash-bpw25", () => {
    const { manifest } = loadManifest();
    expect(manifest.metadata.name).toBe(NAME);
  });

  test("pins the z13 upstream-llama.cpp identity, endpoint and memory", () => {
    const { manifest } = loadManifest();
    const spec = manifest.spec;
    expect(spec.node).toBe("z13");
    expect(spec.engine).toBe("llamacpp");
    expect(spec.restartPolicy).toBe("Never");
    expect(spec.endpoint).toEqual({ host: "127.0.0.1", port: 8083 });
    expect(isAbsolute(spec.binary)).toBe(true);
    expect(basename(spec.binary)).toBe("llama-server");
    expect(spec.binary.startsWith(RUNTIME_PREFIX)).toBe(true);
    const binaryName = spec.binary.toLowerCase();
    expect(binaryName.includes("gufo")).toBe(false);
    expect(binaryName.includes("devstorage")).toBe(false);
    expect(spec.binaryNames).toBeUndefined();
    expect(spec.readiness).toBeUndefined();
    expect(spec.resources?.expectedMemoryGiB).toBe(98);
  });

  test("hosts the pinned BPW2.5 rel and joins the catalog row", () => {
    const { manifest } = loadManifest();
    expect(MIMO_ROW).toBeDefined();
    if (MIMO_ROW === undefined) return;
    const hosted = manifest.spec.hostedModels;
    expect(hosted).toHaveLength(1);
    const entry = hosted[0];
    expect(entry?.rel).toBe(MODEL_REL);
    expect(entry?.rel).toBe(MIMO_ROW.rel);
    expect(MIMO_ROW.rel).toBe(MODEL_REL);
    expect(entry?.lora_path).toBeUndefined();
    expect(entry?.dflash).toBeUndefined();
    const args = manifest.spec.extraArgs;
    const idx = args.indexOf("--alias");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(basename(MODEL_REL));
    expect(args).not.toContain("--served-model-name");
  });

  test("wires the 64k context, jinja template and catalog formats", () => {
    const { manifest } = loadManifest();
    const args = manifest.spec.extraArgs;
    const ctxIdx = args.indexOf("-c");
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(args[ctxIdx + 1]).toBe("65536");
    expect(args).not.toContain("--ctx-size");
    expect(args).not.toContain("--context");
    expect(args).toContain("--jinja");
    expect(args).not.toContain("--no-jinja");
    expect(args).not.toContain("--chat-template");
    expect(args).not.toContain("--chat-template-file");
    expect(args).not.toContain("--reasoning-format");
    expect(MIMO_ROW).toBeDefined();
    if (MIMO_ROW === undefined) return;
    expect(MIMO_ROW.runtime?.engines).toContain("llamacpp");
    expect(MIMO_ROW.runtime?.minBuild).toBe("b11298");
    expect(MIMO_ROW.runtime?.toolCallFormat).toBe("mimo-xml");
    expect(MIMO_ROW.runtime?.reasoningFormat).toBe("think-tags");
    expect(MIMO_ROW.availability?.declared).toBe("unavailable");
  });

  test("keeps the dflash drafter models-dir relative for the boot command", () => {
    const { manifest } = loadManifest();
    expect(MIMO_ROW).toBeDefined();
    if (MIMO_ROW === undefined) return;
    const spec = manifest.spec;
    const args = spec.extraArgs;
    const mdIdx = args.indexOf("-md");
    expect(mdIdx).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf("-md")).toBe(mdIdx);
    const draft = draftArgValue(args);
    expect(draft).toBe(DRAFT_REL);
    expect(isAbsolute(draft)).toBe(false);
    expect(draft.startsWith(DRAFT_DIR)).toBe(true);
    expect(draft.endsWith(".gguf")).toBe(true);
    expect(draft.includes("Q8_0")).toBe(true);

    const modelsDir = resolve("/fixture/models");
    const boot = ENGINES.llamacpp.buildBootCommand(specForEngine(spec), {
      LLAMACTL_MODELS_DIR: modelsDir,
    });
    expect(boot.binary).toBe(spec.binary);
    const modelIdx = boot.args.indexOf("-m");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(boot.args[modelIdx + 1]).toBe(resolve(modelsDir, MODEL_REL));
    const bootDraftIdx = boot.args.indexOf("-md");
    expect(bootDraftIdx).toBeGreaterThanOrEqual(0);
    expect(boot.args[bootDraftIdx + 1]).toBe(resolve(modelsDir, draft));
  });

  test("labels the host experimental on the z13-large-gpu residency group", () => {
    const { manifest } = loadManifest();
    expect(MIMO_ROW).toBeDefined();
    if (MIMO_ROW === undefined) return;
    const labels = manifest.metadata.labels;
    expect(labels?.["llamactl.io/qualification"]).toBe("experimental");
    expect(labels?.["llamactl.io/residency-group"]).toBe("z13-large-gpu");
    expect(labels?.["llamactl.io/residency-group"]).toBe(MIMO_ROW.residencyGroup);
    expect(labels?.["family"]).toBe("mimo26");
    expect(labels?.["family"]).toBe(MIMO_ROW.family);
  });

  test("registers the MiMo rel on disabled z13 arms and claims name and port uniquely", () => {
    expect(loadTemplate()).not.toBeNull();
    const modelCarriers = carriers((doc) => hostedModelRels(doc).includes(MODEL_REL));
    expectArmGroup(modelCarriers);
    expect(modelCarriers.map((entry) => entry.file)).toContain(FILE);
    expectArmGroup(carriers((_doc, _file, text) => text.includes(DRAFT_REL)));
    expect(fileClaimingName(NAME)).toEqual([FILE]);
    expect(filesClaimingNodePort("z13", 8083)).toEqual([FILE]);
    expect(modelRunsTargetingRel(MODEL_REL)).toEqual([]);
    expect(modelRunsTargetingRel(DRAFT_REL)).toEqual([]);
  });

  test("keeps every z13-large-gpu ModelHost disabled", () => {
    expect(loadTemplate()).not.toBeNull();
    const group = templateDocs().filter(
      ({ doc }) => doc["kind"] === "ModelHost" && residencyGroupLabel(doc) === "z13-large-gpu",
    );
    expect(group.length).toBeGreaterThan(0);
    const offenders = group
      .filter(({ doc }) => asRecord(doc["spec"])?.["enabled"] !== false)
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test("pins the runtime and --spec-type flags", () => {
    const { manifest } = loadManifest();
    const spec = manifest.spec;
    expect(spec.binary.startsWith(RUNTIME_PREFIX)).toBe(true);
    const args = spec.extraArgs;
    const specTypeIdx = args.indexOf("--spec-type");
    expect(specTypeIdx).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf("--spec-type")).toBe(specTypeIdx);
    expect(args[specTypeIdx + 1]).toBe("draft-dflash");
    const mdIdx = args.indexOf("-md");
    expect(mdIdx).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf("-md")).toBe(mdIdx);
    const draft = draftArgValue(args);
    expect(draft).toBe(DRAFT_REL);
    expect(draft.includes("unpinned")).toBe(false);
    expect(args).not.toContain("--dspark");
  });

  test("keeps the baseline and pinning comments explicit", () => {
    const text = readFileSync(join(TEMPLATES_DIR, FILE), "utf8").toLowerCase();
    expect(text).toContain("baseline");
    expect(text).toContain("vulkan + dflash");
    expect(text).toContain("buildinfo.json");
    expect(text).toContain("<tool_call>");
  });
});
