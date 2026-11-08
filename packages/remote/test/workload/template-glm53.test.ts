import { catalog } from "@llamactl/core";
import { describe, expect, test } from "bun:test";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse, parseAllDocuments } from "yaml";

import { existsSync, readdirSync, readFileSync } from "../../src/safe-fs.js";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
  ModelHostSpecSchema,
} from "../../src/workload/modelhost-schema.js";

/**
 * Pins frozename/llamactl#515 (B-3): the gufo-glm53-exp manifest is committed
 * under templates/workloads as a disabled experimental ModelHost template.
 * The last case guards the GLM-5.3-Flash catalog rel against a second
 * registration anywhere else in the templates dir.
 */
const TEMPLATES_DIR = resolve(import.meta.dir, "../../../../templates/workloads");
const FILE = "gufo-glm53-exp-z13.yaml";
const DRAFT_MODEL_BASENAME = "incoai-dc77ff1c99ee-bf16.gguf";
const GLM_ROW = catalog.BUILTIN_CATALOG.find((m) => m.id === "glm53-flash-aj-iq2xxs");

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
    throw new Error("gufo-glm53-exp-z13.yaml must parse as a ModelHost manifest");
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

describe("gufo-glm53-exp-z13.yaml (#515)", () => {
  test("parses strictly as a ModelHost manifest", () => {
    const raw = loadTemplate();
    expect(raw).not.toBeNull();
    const manifest = ModelHostManifestSchema.safeParse(raw);
    expect(manifest.success).toBe(true);
    const record = isRecord(raw) ? raw : null;
    expect(record?.["kind"]).toBe("ModelHost");
    expect(ModelHostSpecSchema.safeParse(record?.["spec"]).success).toBe(true);
  });

  test("is committed disabled via an explicit enabled: false", () => {
    const { raw, manifest } = loadManifest();
    expect(manifest.spec.enabled).toBe(false);
    const spec = asRecord(isRecord(raw) ? raw["spec"] : undefined);
    expect(spec?.["enabled"]).toBe(false);
  });

  test("is named gufo-glm53-exp", () => {
    const { manifest } = loadManifest();
    expect(manifest.metadata.name).toBe("gufo-glm53-exp");
  });

  test("pins the z13 llamacpp identity, endpoint, memory and readiness", () => {
    const { manifest } = loadManifest();
    const spec = manifest.spec;
    expect(spec.node).toBe("z13");
    expect(spec.engine).toBe("llamacpp");
    expect(spec.restartPolicy).toBe("Never");
    expect(spec.resources?.expectedMemoryGiB).toBe(90);
    expect(spec.endpoint).toEqual({ host: "127.0.0.1", port: 8081 });
    expect(spec.binaryNames).toEqual(["llama-server-fork-pristine"]);
    expect(isAbsolute(spec.binary)).toBe(true);
    expect(spec.binaryNames?.includes(basename(spec.binary))).toBe(true);
    expect(spec.readiness?.path).toBe("/ready");
    expect(spec.readiness?.expectStatus).toBe(200);
  });

  test("hosts the glm53-flash-aj-iq2xxs catalog rel", () => {
    const { manifest } = loadManifest();
    expect(GLM_ROW).toBeDefined();
    if (GLM_ROW === undefined) return;
    expect(manifest.spec.hostedModels[0]?.rel).toBe(GLM_ROW.rel);
    const args = manifest.spec.extraArgs;
    const idx = args.indexOf("--served-model-name");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(basename(GLM_ROW.rel));
  });

  test("wires the dflash2 drafter with an absolute draft GGUF", () => {
    const { manifest } = loadManifest();
    const args = manifest.spec.extraArgs;
    const idx = args.indexOf("--speculative");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("dflash2");
    expect(
      args.some((token) => isAbsolute(token) && basename(token) === DRAFT_MODEL_BASENAME),
    ).toBe(true);
  });

  test("labels the host experimental on the z13-large-gpu residency group", () => {
    const { manifest } = loadManifest();
    expect(GLM_ROW).toBeDefined();
    if (GLM_ROW === undefined) return;
    const labels = manifest.metadata.labels;
    expect(labels?.["llamactl.io/qualification"]).toBe("experimental");
    expect(labels?.["llamactl.io/residency-group"]).toBe("z13-large-gpu");
    expect(labels?.["llamactl.io/residency-group"]).toBe(GLM_ROW.residencyGroup);
  });

  test("registers the GLM rel exactly once and claims the name nowhere else", () => {
    expect(loadTemplate()).not.toBeNull();
    expect(GLM_ROW).toBeDefined();
    if (GLM_ROW === undefined) return;
    const docs = scanTemplates();
    const entries = docs.flatMap((doc) =>
      doc.rels.map((rel) => ({ file: doc.file, name: doc.name, rel })),
    );
    const matches = entries
      .filter((entry) => entry.rel === GLM_ROW.rel)
      .map((entry) => ({ file: entry.file, name: entry.name }));
    expect(matches).toEqual([{ file: FILE, name: "gufo-glm53-exp" }]);
    const nameClashes = docs.filter((doc) => doc.file !== FILE && doc.name === "gufo-glm53-exp");
    expect(nameClashes).toEqual([]);
  });
});
