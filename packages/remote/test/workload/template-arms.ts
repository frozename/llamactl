import { expect } from "bun:test";
import { join, resolve } from "node:path";
import { parse, parseAllDocuments } from "yaml";

import { existsSync, readdirSync, readFileSync } from "../../src/safe-fs.js";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
} from "../../src/workload/modelhost-schema.js";

export const TEMPLATES_DIR = resolve(import.meta.dir, "../../../../templates/workloads");

const RESIDENCY_GROUP = "z13-large-gpu";

export interface ArmEntry {
  file: string;
  name: string | null;
  node: string | null;
  port: number | null;
  enabled: unknown;
  group: string | null;
}

export interface TemplateDoc {
  file: string;
  text: string;
  doc: Record<string, unknown>;
}

export interface LoadedModelHostTemplate {
  raw: unknown;
  manifest: ModelHostManifest;
  text: string;
  header: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function metadataName(doc: Record<string, unknown>): string | null {
  const name = asRecord(doc["metadata"])?.["name"];
  return typeof name === "string" ? name : null;
}

export function hostedModelRels(doc: Record<string, unknown>): string[] {
  const hosted = asRecord(doc["spec"])?.["hostedModels"];
  if (!isUnknownArray(hosted)) return [];
  const rels: string[] = [];
  for (const entry of hosted) {
    const rel = asRecord(entry)?.["rel"];
    if (typeof rel === "string") rels.push(rel);
  }
  return rels;
}

export function modelHostNodePort(doc: Record<string, unknown>): {
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

export function residencyGroupLabel(doc: Record<string, unknown>): string | null {
  const labels = asRecord(asRecord(doc["metadata"])?.["labels"]);
  const group = labels?.["llamactl.io/residency-group"];
  return typeof group === "string" ? group : null;
}

export function templateDocs(): TemplateDoc[] {
  const files = readdirSync(TEMPLATES_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const out: TemplateDoc[] = [];
  for (const file of files) {
    const text = readFileSync(join(TEMPLATES_DIR, file), "utf8");
    for (const parsed of parseAllDocuments(text)) {
      const js = parsed.toJS() as unknown;
      if (isRecord(js)) out.push({ file, text, doc: js });
    }
  }
  return out;
}

function armEntry(file: string, doc: Record<string, unknown>): ArmEntry {
  const { node, port } = modelHostNodePort(doc);
  return {
    file,
    name: metadataName(doc),
    node,
    port,
    enabled: asRecord(doc["spec"])?.["enabled"],
    group: residencyGroupLabel(doc),
  };
}

export function carriers(
  pred: (doc: Record<string, unknown>, file: string, text: string) => boolean,
): ArmEntry[] {
  const out: ArmEntry[] = [];
  for (const { file, text, doc } of templateDocs()) {
    if (doc["kind"] !== "ModelHost") continue;
    if (!pred(doc, file, text)) continue;
    out.push(armEntry(file, doc));
  }
  return out;
}

export function modelRunsTargetingRel(rel: string): string[] {
  const out: string[] = [];
  for (const { file, doc } of templateDocs()) {
    if (doc["kind"] !== "ModelRun") continue;
    const target = asRecord(asRecord(doc["spec"])?.["target"]);
    if (target?.["kind"] === "rel" && target["value"] === rel) out.push(file);
  }
  return out;
}

export function fileClaimingName(name: string): string[] {
  const out: string[] = [];
  for (const { file, doc } of templateDocs()) {
    if (metadataName(doc) === name) out.push(file);
  }
  return out;
}

export function filesClaimingNodePort(node: string, port: number): string[] {
  const out: string[] = [];
  for (const { file, doc } of templateDocs()) {
    if (doc["kind"] !== "ModelHost") continue;
    const candidate = modelHostNodePort(doc);
    if (candidate.node === node && candidate.port === port) out.push(file);
  }
  return out;
}

export function templateHeader(text: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("#")) break;
    lines.push(line);
  }
  return lines.join("\n").toLowerCase();
}

function expectMinCount(entries: readonly ArmEntry[], minCount: number): void {
  const offenders =
    entries.length >= minCount
      ? []
      : [`expected at least ${String(minCount)} arm carriers, found ${String(entries.length)}`];
  expect(offenders).toEqual([]);
}

function expectAllDisabled(entries: readonly ArmEntry[]): void {
  const offenders = entries.filter((entry) => entry.enabled !== false).map((entry) => entry.file);
  expect(offenders).toEqual([]);
}

function expectAllInGroup(entries: readonly ArmEntry[]): void {
  const offenders = entries
    .filter((entry) => entry.group !== RESIDENCY_GROUP)
    .map((entry) => entry.file);
  expect(offenders).toEqual([]);
}

function expectDistinctNames(entries: readonly ArmEntry[]): void {
  const offenders = new Set<string>();
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (entry.name === null) {
      offenders.add(entry.file);
      continue;
    }
    const prior = seen.get(entry.name);
    if (prior === undefined) {
      seen.set(entry.name, entry.file);
    } else {
      offenders.add(entry.file);
      offenders.add(prior);
    }
  }
  expect([...offenders].sort()).toEqual([]);
}

function expectDistinctNodePorts(entries: readonly ArmEntry[]): void {
  const offenders = new Set<string>();
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.node, entry.port]);
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, entry.file);
    } else {
      offenders.add(entry.file);
      offenders.add(prior);
    }
  }
  expect([...offenders].sort()).toEqual([]);
}

export function expectArmGroup(entries: readonly ArmEntry[], minCount = 1): void {
  expectMinCount(entries, minCount);
  expectAllDisabled(entries);
  expectAllInGroup(entries);
  expectDistinctNames(entries);
  expectDistinctNodePorts(entries);
}

export function loadModelHostTemplate(file: string): LoadedModelHostTemplate {
  const path = join(TEMPLATES_DIR, file);
  expect(existsSync(path)).toBe(true);
  const text = readFileSync(path, "utf8");
  const raw = parse(text) as unknown;
  const result = ModelHostManifestSchema.safeParse(raw);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`${file} must parse as a ModelHost manifest`);
  }
  return { raw, manifest: result.data, text, header: templateHeader(text) };
}
