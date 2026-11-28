// #519: knob-scope warnings on `residencyStatus`. A persisted NodeRun that
// sets budget or residency while metadata.name differs from spec.node is
// already rejected by apply, but pre-existing manifests can still be on disk;
// status surfaces them as warnings whenever they are selected by name or name
// the queried node in spec.node. At the pinned base the field does not exist,
// so the KS cases fail BY ASSERTION — never by an import or type error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeRun, NodeRunResidency } from "../../src/workload/noderun-schema.js";

import { buildResidencyStatus } from "../../src/residency/procedures.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { nodeRunKnobScopeMismatch } from "../../src/workload/noderun-schema.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-knob-scope-"));
  storePath = join(tmp, "operations.sqlite");
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: storePath,
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  tmp = "";
});

function nodeRunManifest(options: {
  name: string;
  node: string;
  residency?: NodeRunResidency;
  budget?: { memoryGiB: number };
}): NodeRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name: options.name, labels: {} },
    spec: {
      node: options.node,
      infra: [],
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
      ...(options.residency !== undefined ? { residency: options.residency } : {}),
    },
  };
}

function buildStatus(node: string, nodeRuns?: NodeRun[]): unknown {
  const nodeRun = nodeRuns?.find((candidate) => candidate.metadata.name === node);
  return buildResidencyStatus({
    node,
    nodeRun,
    ...(nodeRuns !== undefined ? { nodeRuns } : {}),
    budgetGiB: 24,
    budgetSource: "computed",
    store: { path: storePath, present: false },
    servingNode: null,
    nowMs: 1_000_000,
  } as unknown as Parameters<typeof buildResidencyStatus>[0]);
}

function knobScopeWarningsOf(built: unknown): string[] | undefined {
  return (built as { knobScopeWarnings?: string[] }).knobScopeWarnings;
}

function mismatch(manifest: NodeRun): string {
  const warning = nodeRunKnobScopeMismatch(manifest);
  if (warning === null) throw new Error("test fixture must be knob-scope mismatched");
  return warning;
}

describe("residencyStatus knobScopeWarnings (#519)", () => {
  test("KS1: a mis-scoped NodeRun targeting the queried node warns when no NodeRun has its name", () => {
    const infra = nodeRunManifest({
      name: "gpu1-infra",
      node: "gpu1",
      residency: { minResidencySeconds: 30 },
    });

    const built = buildStatus("gpu1", [infra]);

    expect(knobScopeWarningsOf(built)).toEqual([mismatch(infra)]);
  });

  test("KS2: the selected NodeRun warns when its name and node differ", () => {
    const selected = nodeRunManifest({
      name: "gpu1",
      node: "gpu2",
      budget: { memoryGiB: 16 },
    });

    const built = buildStatus("gpu1", [selected]);

    expect(knobScopeWarningsOf(built)).toEqual([mismatch(selected)]);
  });

  test("KS3: a NodeRun named for another node warns when it targets the queried node", () => {
    const misScoped = nodeRunManifest({
      name: "gpu1",
      node: "gpu2",
      budget: { memoryGiB: 16 },
    });

    const built = buildStatus("gpu2", [misScoped]);

    expect(knobScopeWarningsOf(built)).toEqual([mismatch(misScoped)]);
  });

  test("KS4: warnings sort by NodeRun metadata.name", () => {
    const z = nodeRunManifest({
      name: "z-gpu1",
      node: "gpu1",
      residency: { minResidencySeconds: 30 },
    });
    const a = nodeRunManifest({
      name: "a-gpu1",
      node: "gpu1",
      residency: { minResidencySeconds: 30 },
    });

    const built = buildStatus("gpu1", [z, a]);

    expect(knobScopeWarningsOf(built)).toEqual([mismatch(a), mismatch(z)]);
  });

  test("KS5: the router reports a mis-scoped persisted NodeRun targeting the queried node", async () => {
    const manifest = nodeRunManifest({
      name: "gpu1-infra",
      node: "gpu1",
      residency: { switchCooldownSeconds: 60 },
    });
    saveNodeRun(manifest, tmp);

    const res = await router.createCaller({}).residencyStatus({ node: "gpu1" });

    expect(res.nodeRun.present).toBe(false);
    expect(knobScopeWarningsOf(res)).toEqual([mismatch(manifest)]);
  });

  test("G1: a correctly scoped NodeRun with residency emits no warnings key", () => {
    const scoped = nodeRunManifest({
      name: "gpu1",
      node: "gpu1",
      residency: { minResidencySeconds: 30 },
    });

    const built = buildStatus("gpu1", [scoped]);

    expect("knobScopeWarnings" in (built as object)).toBe(false);
  });

  test("G2: an infra-only NodeRun may differ in name without a warnings key", () => {
    const infraOnly = nodeRunManifest({ name: "gpu1-infra", node: "gpu1" });

    const built = buildStatus("gpu1", [infraOnly]);

    expect("knobScopeWarnings" in (built as object)).toBe(false);
  });

  test("G3: a mis-scoped NodeRun unrelated to the queried node emits no warnings key", () => {
    const unrelated = nodeRunManifest({
      name: "gpu3-infra",
      node: "gpu3",
      residency: { minResidencySeconds: 30 },
    });

    const built = buildStatus("gpu1", [unrelated]);

    expect("knobScopeWarnings" in (built as object)).toBe(false);
  });

  test("G4: omitting nodeRuns emits no warnings key", () => {
    const built = buildStatus("gpu1");

    expect("knobScopeWarnings" in (built as object)).toBe(false);
  });

  test("G5: the router emits no warnings key for a correctly scoped NodeRun", async () => {
    const scoped = nodeRunManifest({
      name: "gpu1",
      node: "gpu1",
      residency: { minResidencySeconds: 30 },
    });
    saveNodeRun(scoped, tmp);

    const res = await router.createCaller({}).residencyStatus({ node: "gpu1" });

    expect(res.nodeRun.present).toBe(true);
    expect("knobScopeWarnings" in res).toBe(false);
  });
});
