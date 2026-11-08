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
 * Pins frozename/llamactl#515 (D-3, rel fix in C-3): the MiMo-V2.6-Flash MOPD
 * BPW2.5 GGUF is served on z13 by a disabled, experimental ModelHost template
 * on upstream llama.cpp b12206 @ cf34d311332e (no Gufo fork identity, no
 * /ready probe). The drafter file is pinned and stays a models-dir-relative
 * path so the engine boot command resolves it, and the hosted rel is the
 * pinned models-root layout the catalog row also carries. The runtime is
 * pinned to llama.cpp-cf34d311332e. --spec-type draft-dflash + -md replace
 * the old -md-only wiring. The last cases guard the catalog rel, the
 * metadata name and the z13-large-gpu residency group against a second
 * registration anywhere else in the templates dir.
 */
const TEMPLATES_DIR = resolve(import.meta.dir, "../../../../templates/workloads");
const FILE = "llamacpp-mimo26-flash-bpw25-z13.yaml";
const NAME = "llamacpp-mimo26-flash-bpw25";
const MODEL_REL =
  "MiMo-V2.6-Flash-MOPD-GGUF-AesSedai/b6e95d58/BPW2.5/MiMo-V2.6-Flash-MOPD-BPW2.5-00001-of-00003.gguf";
const DRAFT_REL =
  "MiMo-V2.6-Flash-MOPD-GGUF-ggml-org/c9d86979/dflash/dflash-MiMo-V2.6-Flash-MOPD-Q8_0.gguf";
const DRAFT_DIR = "MiMo-V2.6-Flash-MOPD-GGUF-ggml-org/c9d86979/dflash/";
const RUNTIME_PREFIX = "/home/alex/strix-halo-bench/runtimes/llama.cpp-cf34d311332e/";
const MIMO_ROW = catalog.BUILTIN_CATALOG.find((m) => m.id === "mimo26-flash-mopd-bpw25");

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
    throw new Error("llamacpp-mimo26-flash-bpw25-z13.yaml must parse as a ModelHost manifest");
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
    const idx = args.indexOf("--served-model-name");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(basename(MODEL_REL));
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

  test("registers the MiMo rel once and claims name and port nowhere else", () => {
    expect(loadTemplate()).not.toBeNull();
    expect(MIMO_ROW).toBeDefined();
    if (MIMO_ROW === undefined) return;
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
      .filter((entry) => entry.node === "z13" && entry.port === 8083);
    expect(endpointClashes).toEqual([]);
    const draftClashes = readdirSync(TEMPLATES_DIR)
      .filter((file) => file.endsWith(".yaml") && file !== FILE)
      .filter((file) => readFileSync(join(TEMPLATES_DIR, file), "utf8").includes(DRAFT_REL));
    expect(draftClashes).toEqual([]);
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
  });
});
