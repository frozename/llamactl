// Part of #285 (DF-12): node policy examples
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ModelRun } from "../../../src/workload/schema.js";

import { computeNodeBudget, defaultNodeBudgetGiB } from "../../../src/workload/admission.js";
import { type NodeRun, NodeRunSchema } from "../../../src/workload/noderun-schema.js";
import { doc, expectPins, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

const TABLE_ROW_RE = /^\|\s*`([a-z0-9-]+)`\s*\|\s*([0-9.]+) GiB\s*\|\s*([0-9.]+) GiB\s*\|/gm;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

interface ParsedExample {
  raw: unknown;
  ok: boolean;
  data?: NodeRun;
  error?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseExampleBlock(block: string): ParsedExample {
  let raw: unknown;
  try {
    raw = parseYaml(block);
  } catch (error) {
    return { raw: undefined, ok: false, error: errorText(error) };
  }
  const result = NodeRunSchema.safeParse(raw);
  if (result.success) return { raw, ok: true, data: result.data };
  return { raw, ok: false, error: result.error.message };
}

function parseExampleBlocks(blocks: string[]): ParsedExample[] {
  return blocks.map(parseExampleBlock);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

const body = sectionBody(sectionRe("node policy examples")) ?? "";
const yamlBlocks = [...body.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
const parsedExamples = parseExampleBlocks(yamlBlocks);
const examples: NodeRun[] = parsedExamples.flatMap((parsed) =>
  parsed.data === undefined ? [] : [parsed.data],
);

describe("#285 node policy examples", () => {
  // Kills: a node-policy section that is missing or outside the documented rollout flow.
  test("placement: section sits between knobs and legacy cleanup", () => {
    expect(body, "node policy examples section body").not.toBe("");
    const lines = doc.split("\n");
    const examplesIndex = lines.indexOf("## Node policy examples");
    const knobsIndex = lines.indexOf("## NodeRun residency policy knobs");
    const cleanupIndex = lines.indexOf("## Cleanup of conflicting legacy launchers");
    expect(examplesIndex, "node policy examples heading").not.toBe(-1);
    expect(knobsIndex, "NodeRun residency policy knobs heading").not.toBe(-1);
    expect(cleanupIndex, "legacy cleanup heading").not.toBe(-1);
    expect(examplesIndex).toBeGreaterThan(knobsIndex);
    expect(examplesIndex).toBeLessThan(cleanupIndex);
  });

  // Kills: examples that drift from the NodeRun schema or smuggle undeclared keys.
  test("schema: three YAML blocks are minimal valid NodeRuns", () => {
    expect(yamlBlocks).toHaveLength(3);
    for (const parsed of parsedExamples) {
      expect(parsed.ok, parsed.error ?? "").toBe(true);
    }

    const allowedSpecKeys = new Set(["budget", "node", "residency"]);
    for (const parsed of parsedExamples) {
      const raw = parsed.raw;
      const specKeys = recordKeys(isRecord(raw) ? raw["spec"] : undefined);
      for (const key of specKeys) {
        expect(allowedSpecKeys.has(key), `spec key ${key}`).toBe(true);
      }
      const metadataKeys = recordKeys(isRecord(raw) ? raw["metadata"] : undefined);
      expect(metadataKeys).toEqual(["name"]);
    }

    const names = examples.map((example) => example.metadata.name);
    expect(new Set(names).size).toBe(names.length);
    for (const example of examples) {
      expect(example.metadata.name).toBe(example.spec.node);
      expect(example.spec.infra).toEqual([]);
    }

    const withBudget = examples.filter((example) => example.spec.budget !== undefined);
    const withoutBudget = examples.filter((example) => example.spec.budget === undefined);
    expect(withBudget).toHaveLength(1);
    expect(withoutBudget).toHaveLength(2);
    for (const example of withoutBudget) {
      expect(example.spec.budget).toBeUndefined();
      expect(typeof example.spec.residency?.safetyMarginRatio).toBe("number");
    }
  });

  // Kills: a safetyMarginRatio changed in the YAML without the table being updated.
  test("budget table arithmetic matches the examples", () => {
    const rows = [...body.matchAll(TABLE_ROW_RE)];
    expect(rows).toHaveLength(3);
    const rowNames = [...new Set(rows.map((row) => row[1] ?? ""))].sort();
    const exampleNames = [...new Set(examples.map((example) => example.metadata.name))].sort();
    expect(rowNames).toEqual(exampleNames);
    const memoryCells = rows.map((row) => Number(row[2] ?? ""));
    expect([...new Set(memoryCells)].sort((a, b) => a - b)).toEqual([16, 48, 128]);

    for (const row of rows) {
      const name = row[1] ?? "";
      const memoryCell = row[2] ?? "";
      const budgetCell = row[3] ?? "";
      const example = examples.find((candidate) => candidate.metadata.name === name);
      expect(example, `example for ${name}`).toBeDefined();
      if (example === undefined) continue;
      expect(Number(budgetCell), `budget for ${name}`).toBeCloseTo(
        defaultNodeBudgetGiB(
          example.spec.budget?.memoryGiB,
          Number(memoryCell) * 1024 ** 3,
          example.spec.residency,
        ),
        6,
      );
    }
  });

  // Kills: rollout examples that document the backstop without proving the admission behavior.
  test("control-only backstop uses the real admission decision", () => {
    const control = examples.find((example) => example.spec.budget !== undefined);
    const budget: number | null = control?.spec.budget?.memoryGiB ?? null;
    const nodeName = control?.spec.node ?? "control-missing";
    expect(budget).toBe(1);

    const mk = (expectedMemoryGiB?: number): ModelRun => ({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "probe", labels: {}, annotations: {} },
      spec: {
        node: nodeName,
        enabled: true,
        target: { kind: "rel", value: "x.gguf" },
        extraArgs: [],
        workers: [],
        restartPolicy: "Always",
        gateway: false,
        allowExternalBind: false,
        timeoutSeconds: 60,
        ...(expectedMemoryGiB === undefined ? {} : { resources: { expectedMemoryGiB } }),
      },
    });

    const admissionInput = {
      nodeName,
      nodeBudgetGiB: budget,
      livingManifests: [],
      incoming: mk(4),
      forceAdmit: false,
    };
    const r1 = computeNodeBudget(admissionInput);
    expect(r1.ok).toBe(false);
    expect(r1.ok ? "ok" : r1.kind).toBe("over-budget");
    const r2 = computeNodeBudget({ ...admissionInput, incoming: mk() });
    expect(r2.ok).toBe(true);
    const r3 = computeNodeBudget({ ...admissionInput, incoming: mk(4), forceAdmit: true });
    expect(r3.ok).toBe(true);

    expectPins(flat(body), "backstop", [
      "`computeNodeBudget`",
      "`over-budget`",
      "`spec.resources.expectedMemoryGiB`",
      "`llamactl.io/force-admit`",
      "backstop",
      "`defaultNodeBudgetGiB`",
    ]);
  });

  // Kills: copy-pasted operator secrets or site-specific network identity in the examples.
  test("examples avoid credentials and private addresses", () => {
    expect(IPV4_RE.test(body), "IPv4 address").toBe(false);
    expect(/\.local\b|\.lan\b/.test(body), "private DNS suffix").toBe(false);
    expect(
      /token|secret|password|apikey|bearer/i.test(yamlBlocks.join("\n")),
      "credential word",
    ).toBe(false);
    expectPins(flat(body), "placeholders", ["`metadata.name`", "`spec.node`"]);
  });

  // Kills: rollout prose that overstates hardware qualification or omits the opt-in wiring.
  test("scope honesty and wiring are explicit", () => {
    expectPins(flat(body), "scope", [
      "not hardware qualification",
      "BLOCKED",
      "`LLAMACTL_UNIFIED_PROXY=1`",
      "`llamactl apply -f",
      "`llamactl describe noderun",
    ]);
  });

  // Kills: the mac-mini deployment guide losing its pointer to the rollout examples.
  test("mac mini deployment guide points at the examples", () => {
    expect(readOrEmpty(join(REPO, "docs/deployment-mac-mini.md"))).toContain(
      "dynamic-residency.md#node-policy-examples",
    );
  });
});
