import { catalog } from "@llamactl/core";
import { ENGINES } from "@llamactl/core/engines";
import { describe, expect, test } from "bun:test";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse, parseAllDocuments } from "yaml";

import { existsSync, readdirSync, readFileSync } from "../../src/safe-fs.js";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
  ModelHostSpecSchema,
  specForEngine,
} from "../../src/workload/modelhost-schema.js";

/**
 * Pins frozename/llamactl#515 (C-3): the DeepSeek-V4.1-Flash-1017 UD-IQ1_S
 * GGUF is served on z13 by a disabled, experimental ModelHost template on
 * upstream llama.cpp b12206 @ cf34d311332e (no Gufo fork identity, no
 * /ready probe). The drafter is the pinned dspark Q8_0 file kept
 * models-dir-relative so the engine boot command resolves it, and the
 * hosted rel is the pinned <repo>-<owner>/<rev8> models-root layout the
 * catalog row also carries. The runtime is pinned to
 * llama.cpp-cf34d311332e. The last cases guard the catalog rel, the
 * metadata name, the port and the z13-large-gpu residency group against a
 * second registration anywhere else in the templates dir.
 */
const TEMPLATES_DIR = resolve(import.meta.dir, "../../../../templates/workloads");
const FILE = "llamacpp-deepseek41-flash-iq1s-z13.yaml";
const NAME = "llamacpp-deepseek41-flash-iq1s";
const MODEL_REL =
  "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/UD-IQ1_S/DeepSeek-V4.1-Flash-1017-UD-IQ1_S-00001-of-00005.gguf";
const DRAFT_REL =
  "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/dspark/dspark-DeepSeek-V4.1-Flash-1017-Q8_0.gguf";
const RUNTIME_PREFIX = "/home/alex/strix-halo-bench/runtimes/llama.cpp-cf34d311332e/";
const DS_ROW = catalog.BUILTIN_CATALOG.find((m) => m.id === "deepseek41-flash-1017-ud-iq1s");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

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

function metadataName(doc: Record<string, unknown>): string | null {
  const name = asRecord(doc["metadata"])?.["name"];
  return typeof name === "string" ? name : null;
}

function hostedModelRels(doc: Record<string, unknown>): string[] {
  const hosted = asRecord(doc["spec"])?.["hostedModels"];
  if (!isUnknownArray(hosted)) return [];
  const rels: string[] = [];
  for (const entry of hosted) {
    const rel = asRecord(entry)?.["rel"];
    if (typeof rel === "string") rels.push(rel);
  }
  return rels;
}

function modelRunRel(doc: Record<string, unknown>): string | null {
  const target = asRecord(asRecord(doc["spec"])?.["target"]);
  if (target?.["kind"] !== "rel") return null;
  const value = target["value"];
  return typeof value === "string" ? value : null;
}

function docRels(doc: Record<string, unknown>): string[] {
  const kind = doc["kind"];
  if (kind === "ModelHost") return hostedModelRels(doc);
  if (kind === "ModelRun") {
    const rel = modelRunRel(doc);
    return rel === null ? [] : [rel];
  }
  return [];
}

interface ScannedTemplate {
  file: string;
  name: string | null;
  rels: string[];
}

function scanTemplates(): ScannedTemplate[] {
  const files = readdirSync(TEMPLATES_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const out: ScannedTemplate[] = [];
  for (const file of files) {
    const text = readFileSync(join(TEMPLATES_DIR, file), "utf8");
    for (const doc of parseAllDocuments(text)) {
      const js = doc.toJS() as unknown;
      if (!isRecord(js)) continue;
      out.push({ file, name: metadataName(js), rels: docRels(js) });
    }
  }
  return out;
}

interface TemplateDoc {
  file: string;
  doc: Record<string, unknown>;
}

function templateDocs(): TemplateDoc[] {
  const files = readdirSync(TEMPLATES_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const out: TemplateDoc[] = [];
  for (const file of files) {
    const text = readFileSync(join(TEMPLATES_DIR, file), "utf8");
    for (const parsed of parseAllDocuments(text)) {
      const js = parsed.toJS() as unknown;
      if (isRecord(js)) out.push({ file, doc: js });
    }
  }
  return out;
}

function modelHostNodePort(doc: Record<string, unknown>): {
  node: string | null;
  port: number | null;
} {
  const spec = asRecord(doc["spec"]);
  const node = spec?.["node"];
  const port = asRecord(spec?.["endpoint"])?.["port"];
  return {
    node: typeof node === "string" ? node : null,
    port: typeof port === "number" ? port : null,
  };
}

function residencyGroupLabel(doc: Record<string, unknown>): string | null {
  const labels = asRecord(asRecord(doc["metadata"])?.["labels"]);
  const group = labels?.["llamactl.io/residency-group"];
  return typeof group === "string" ? group : null;
}

function flagArgValue(args: readonly string[], flag: string): string {
  const idx = args.indexOf(flag);
  const value = idx >= 0 ? args[idx + 1] : undefined;
  if (value === undefined) {
    throw new Error(`expected ${flag} to be followed by a value`);
  }
  return value;
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

  test("registers the DeepSeek rel once and claims name, port and drafter nowhere else", () => {
    expect(loadTemplate()).not.toBeNull();
    const docs = scanTemplates();
    const entries = docs.flatMap((doc) =>
      doc.rels.map((rel) => ({ file: doc.file, name: doc.name, rel })),
    );
    const matches = entries
      .filter((entry) => entry.rel === MODEL_REL)
      .map((entry) => ({ file: entry.file, name: entry.name }));
    expect(matches).toEqual([{ file: FILE, name: NAME }]);
    const nameClashes = docs.filter((doc) => doc.file !== FILE && doc.name === NAME);
    expect(nameClashes).toEqual([]);
    const endpointClashes = templateDocs()
      .filter(({ file, doc }) => file !== FILE && doc["kind"] === "ModelHost")
      .map(({ file, doc }) => ({ file, ...modelHostNodePort(doc) }))
      .filter((entry) => entry.node === "z13" && entry.port === 8084);
    expect(endpointClashes).toEqual([]);
    const draftClashes = readdirSync(TEMPLATES_DIR)
      .filter((file) => file.endsWith(".yaml") && file !== FILE)
      .filter((file) => readFileSync(join(TEMPLATES_DIR, file), "utf8").includes(DRAFT_REL));
    expect(draftClashes).toEqual([]);
    const z13Rels = templateDocs()
      .filter(({ doc }) => doc["kind"] === "ModelHost" && modelHostNodePort(doc).node === "z13")
      .flatMap(({ doc }) => hostedModelRels(doc));
    expect(new Set(z13Rels).size).toBe(z13Rels.length);
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
  });
});
