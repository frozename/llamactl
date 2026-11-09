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
  modelHostNodePort,
  modelRunsTargetingRel,
  residencyGroupLabel,
  templateDocs,
  TEMPLATES_DIR,
} from "./template-arms.js";

/**
 * Pins frozename/llamactl#515 (C-3): the DeepSeek-V4.1-Flash-1017 UD-IQ1_S
 * GGUF is served on z13 by a disabled, experimental ModelHost template on
 * upstream llama.cpp b12206 @ cf34d311332e (no Gufo fork identity, no
 * /ready probe). The drafter is the pinned dspark Q8_0 file kept
 * models-dir-relative so the engine boot command resolves it, and the
 * hosted rel is the pinned <repo>-<owner>/<rev8> models-root layout the
 * catalog row also carries. The runtime is pinned to
 * llama.cpp-cf34d311332e. The last cases guard the catalog rel, the
 * metadata name, the port and the z13-large-gpu residency group: the rel may
 * be carried by several disabled arm templates (#557) as long as each claims
 * a distinct name and z13 port, and no ModelRun targets the rels.
 */
const FILE = "llamacpp-deepseek41-flash-iq1s-z13.yaml";
const NAME = "llamacpp-deepseek41-flash-iq1s";
const MODEL_REL =
  "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/UD-IQ1_S/DeepSeek-V4.1-Flash-1017-UD-IQ1_S-00001-of-00005.gguf";
const DRAFT_REL =
  "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/dspark/dspark-DeepSeek-V4.1-Flash-1017-Q8_0.gguf";
const RUNTIME_PREFIX = "/home/alex/strix-halo-bench/runtimes/llama.cpp-cf34d311332e/";
const DS_ROW = catalog.BUILTIN_CATALOG.find((m) => m.id === "deepseek41-flash-1017-ud-iq1s");

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
    throw new Error("llamacpp-deepseek41-flash-iq1s-z13.yaml must parse as a ModelHost manifest");
  }
  return { raw, manifest: result.data };
}

function flagArgValue(args: readonly string[], flag: string): string {
  const idx = args.indexOf(flag);
  const value = idx >= 0 ? args[idx + 1] : undefined;
  if (value === undefined) {
    throw new Error(`expected ${flag} to be followed by a value`);
  }
  return value;
}

function expectDuplicatedZ13RelsFormArmGroups(): void {
  const z13RelCounts = new Map<string, number>();
  for (const { doc } of templateDocs()) {
    if (doc["kind"] !== "ModelHost" || modelHostNodePort(doc).node !== "z13") continue;
    for (const rel of hostedModelRels(doc)) {
      z13RelCounts.set(rel, (z13RelCounts.get(rel) ?? 0) + 1);
    }
  }
  for (const [rel, count] of z13RelCounts) {
    if (count <= 1) continue;
    const entries = carriers((candidate) => hostedModelRels(candidate).includes(rel)).filter(
      (entry) => entry.node === "z13",
    );
    expectArmGroup(entries, 2);
  }
}

describe("llamacpp-deepseek41-flash-iq1s-z13.yaml (#515 C-3)", () => {
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

  test("is named llamacpp-deepseek41-flash-iq1s", () => {
    const { manifest } = loadManifest();
    expect(manifest.metadata.name).toBe(NAME);
  });

  test("pins the z13 upstream-llama.cpp identity, endpoint and memory", () => {
    const { manifest } = loadManifest();
    const spec = manifest.spec;
    expect(spec.node).toBe("z13");
    expect(spec.engine).toBe("llamacpp");
    expect(spec.restartPolicy).toBe("Never");
    expect(spec.endpoint).toEqual({ host: "127.0.0.1", port: 8084 });
    expect(isAbsolute(spec.binary)).toBe(true);
    expect(basename(spec.binary)).toBe("llama-server");
    expect(spec.binary.startsWith(RUNTIME_PREFIX)).toBe(true);
    const binaryName = spec.binary.toLowerCase();
    expect(binaryName.includes("gufo")).toBe(false);
    expect(binaryName.includes("devstorage")).toBe(false);
    expect(spec.binaryNames).toBeUndefined();
    expect(spec.readiness).toBeUndefined();
    expect(spec.resources?.residentGiB).toBe(114);
    expect(spec.resources?.diskBackedGiB).toBe(103);
    expect(DS_ROW).toBeDefined();
    if (DS_ROW === undefined) return;
    const rowMemory = DS_ROW.memory;
    expect(rowMemory).toBeDefined();
    if (rowMemory === undefined) return;
    expect(spec.resources).toMatchObject(rowMemory);
    expect(spec.resources?.expectedMemoryGiB).toBeUndefined();
  });

  test("hosts the pinned UD-IQ1_S rel and joins the catalog row", () => {
    const { manifest } = loadManifest();
    expect(DS_ROW).toBeDefined();
    if (DS_ROW === undefined) return;
    expect(DS_ROW.rel).toBe(MODEL_REL);
    const hosted = manifest.spec.hostedModels;
    expect(hosted).toHaveLength(1);
    const entry = hosted[0];
    expect(entry?.rel).toBe(MODEL_REL);
    expect(entry?.rel).toBe(DS_ROW.rel);
    expect(entry?.lora_path).toBeUndefined();
    expect(entry?.dflash).toBeUndefined();
    const args = manifest.spec.extraArgs;
    const idx = args.indexOf("--served-model-name");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(flagArgValue(args, "--served-model-name")).toBe(basename(MODEL_REL));
  });

  test("wires the 64k context with --spec-type draft-dspark + -md", () => {
    const { manifest } = loadManifest();
    const args = manifest.spec.extraArgs;
    const ctxIdx = args.indexOf("-c");
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(flagArgValue(args, "-c")).toBe("65536");
    expect(args).not.toContain("--ctx-size");
    expect(args).not.toContain("--jinja");
    expect(args).not.toContain("--no-jinja");
    expect(args).not.toContain("--chat-template");
    expect(args).not.toContain("--chat-template-file");
    expect(args).not.toContain("--dspark");
    expect(args).not.toContain("--model-draft");
    // --spec-type appears once (for draft-dspark)
    expect(args.filter((a) => a === "--spec-type")).toHaveLength(1);
    expect(args).not.toContain("--dflash");
    expect(DS_ROW).toBeDefined();
    if (DS_ROW === undefined) return;
    expect(DS_ROW.runtime?.engines).toContain("llamacpp");
    expect(DS_ROW.runtime?.minBuild).toBe("b11870");
  });

  test("resolves the --spec-type draft-dspark + -md drafter at boot", () => {
    const { manifest } = loadManifest();
    const spec = manifest.spec;
    const args = spec.extraArgs;
    const specTypeIdx = args.indexOf("--spec-type");
    expect(specTypeIdx).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf("--spec-type")).toBe(specTypeIdx);
    expect(flagArgValue(args, "--spec-type")).toBe("draft-dspark");
    const mdIdx = args.indexOf("-md");
    expect(mdIdx).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf("-md")).toBe(mdIdx);
    const draft = flagArgValue(args, "-md");
    expect(draft).toBe(DRAFT_REL);
    expect(isAbsolute(draft)).toBe(false);

    const modelsDir = resolve("/fixture/models");
    const boot = ENGINES.llamacpp.buildBootCommand(specForEngine(spec), {
      LLAMACTL_MODELS_DIR: modelsDir,
    });
    expect(boot.binary).toBe(spec.binary);
    expect(flagArgValue(boot.args, "-m")).toBe(resolve(modelsDir, MODEL_REL));
    expect(flagArgValue(boot.args, "-md")).toBe(resolve(modelsDir, DRAFT_REL));
  });

  test("labels the host experimental on the z13-large-gpu residency group", () => {
    const { manifest } = loadManifest();
    expect(DS_ROW).toBeDefined();
    if (DS_ROW === undefined) return;
    const labels = manifest.metadata.labels;
    expect(labels?.["llamactl.io/qualification"]).toBe("experimental");
    expect(labels?.["llamactl.io/residency-group"]).toBe("z13-large-gpu");
    expect(labels?.["llamactl.io/residency-group"]).toBe(DS_ROW.residencyGroup);
    expect(labels?.["family"]).toBe("deepseek41");
    expect(labels?.["family"]).toBe(DS_ROW.family);
  });

  test("registers the DeepSeek rel on disabled z13 arms and claims name, port and drafter uniquely", () => {
    expect(loadTemplate()).not.toBeNull();
    const modelCarriers = carriers((doc) => hostedModelRels(doc).includes(MODEL_REL));
    expectArmGroup(modelCarriers);
    expect(modelCarriers.map((entry) => entry.file)).toContain(FILE);
    expectArmGroup(carriers((_doc, _file, text) => text.includes(DRAFT_REL)));
    expect(fileClaimingName(NAME)).toEqual([FILE]);
    expect(filesClaimingNodePort("z13", 8084)).toEqual([FILE]);
    expect(modelRunsTargetingRel(MODEL_REL)).toEqual([]);
    expect(modelRunsTargetingRel(DRAFT_REL)).toEqual([]);
    expectDuplicatedZ13RelsFormArmGroups();
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

  test("keeps the pinning comments explicit", () => {
    expect(loadTemplate()).not.toBeNull();
    const text = readFileSync(join(TEMPLATES_DIR, FILE), "utf8").toLowerCase();
    expect(text).toContain("dsml");
    expect(text).toContain("unvalidated");
    expect(text).toContain("not measured");
    expect(text).toContain("cf34d311332e");
    expect(text).toContain("baseline");
    expect(text).toContain("libosmos");
    expect(text).toContain("unverified");
  });
});
