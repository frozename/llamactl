// Shared helpers for the dynamic fleet models (docs/dynamic-fleet-models.md) doc tests.
//
// README: every new doc-test slice goes in its own file in this directory
// (named <issue>-<slug>.test.ts), importing what it needs from here. Never
// append a slice to the shared main test file: parallel slice PRs that all
// append to one file's tail conflict with each other every batch.

import { join, resolve } from "node:path";

import type { PromotionDecision } from "../../../src/qualification/promotion.js";
import type { ResidencyTransitionDecision } from "../../../src/residency/lifecycle.js";

import { BUILTIN_CATALOG } from "../../../src/catalog.js";
import { existsSync, readdirSync, readFileSync } from "../../../src/safe-fs.js";

export const REPO = resolve(import.meta.dir, "../../../../..");
export const DOC = join(REPO, "docs/dynamic-fleet-models.md");
const RESIDENCY_GROUP = "z13-large-gpu";

export const REFUSAL_REASONS = [
  "frozen",
  "pinned",
  "degraded",
  "terminal-stage",
  "no-thresholds",
  "insufficient-evidence",
  "below-threshold",
] as const satisfies readonly Extract<PromotionDecision, { kind: "none" }>["reason"][];

// Part of #522: residency lifecycle states slice
type TransitionRefusal = Extract<ResidencyTransitionDecision, { ok: false }>["reason"];
export const TRANSITION_REFUSALS = [
  "UnknownMember",
  "IllegalTransition",
  "UnknownGroup",
  "ExclusiveGroupOccupied",
] as const satisfies readonly TransitionRefusal[];
type MissingRefusal = Exclude<TransitionRefusal, (typeof TRANSITION_REFUSALS)[number]>;
export const ALL_REFUSALS_LISTED: [MissingRefusal] extends [never] ? true : false = true;

export function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export const doc = readOrEmpty(DOC);

interface WorkloadTemplate {
  file: string;
  text: string;
}

function loadWorkloadTemplates(): WorkloadTemplate[] {
  const dir = join(REPO, "templates/workloads");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }))
    .filter((t) => t.text.includes(`llamactl.io/residency-group: ${RESIDENCY_GROUP}`));
}

export const residencyTemplates = loadWorkloadTemplates();
export const exclusiveRows = BUILTIN_CATALOG.filter(
  (row) => row.residencyGroup === RESIDENCY_GROUP,
);

const GLM53_FAMILY = /^\s+family:\s*glm53\s*$/m;
export const RUNTIME_ARM = /^\s+(?:arm|llamactl\.io\/runtime-arm):\s*(\S+)\s*$/m;
export const WORKLOAD_NAME = /^metadata:\n\s+name:\s*(\S+)/m;
export const TEMPLATE_PORT = /^\s+port:\s*(\d+)\s*$/m;
const RUNBOOK_ROW = /^\|\s*`([^`]+)`\s*\|([^|]+)\|\s*(\d+)\s*\|/;

export interface RunbookRow {
  arm: string;
  port: string;
}

export function sectionBody(heading: RegExp): string | undefined {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^#{1,6} /.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
}

export function flat(text: string): string {
  return text.replaceAll(/\s+/g, " ");
}

// The text of the function that `signature` opens, up to its closing brace
// at the signature's indent; "" when the signature is missing or not unique.
export function enclosingBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1 || src.includes(signature, start + 1)) return "";
  const lineStart = src.lastIndexOf("\n", start) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart))?.[0] ?? "";
  const closers = new Set([`${indent}}`, `${indent}},`, `${indent}};`]);
  const lines = src.slice(start).split("\n");
  const end = lines.findIndex((line, i) => i > 0 && closers.has(line));
  return lines.slice(0, end === -1 ? lines.length : end + 1).join("\n");
}

export function runbookRows(section: string): Map<string, RunbookRow> {
  const rows = new Map<string, RunbookRow>();
  for (const line of section.split("\n")) {
    const match = RUNBOOK_ROW.exec(line);
    const name = match?.[1];
    const arm = match?.[2]?.trim();
    const port = match?.[3];
    if (name !== undefined && arm !== undefined && port !== undefined) {
      rows.set(name, { arm, port });
    }
  }
  return rows;
}

export const glmArmIds = residencyTemplates
  .filter((t) => GLM53_FAMILY.test(t.text))
  .map((t) => RUNTIME_ARM.exec(t.text)?.[1])
  .filter((arm): arm is string => arm !== undefined);
