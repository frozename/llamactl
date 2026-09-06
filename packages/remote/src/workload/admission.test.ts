import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "./modelhost-schema.js";
import type { ModelRun } from "./schema.js";

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "../safe-fs.js";
import {
  type AdmissionInput,
  computeNodeBudget,
  defaultNodeBudgetGiB,
  estimateModelHostMemoryGiB,
  estimateWorkloadMemoryGiB,
  reservedForNodeBreakdown,
  sumReservedForNode,
} from "./admission.js";

const mkManifest = (
  name: string,
  opts: Partial<{ enabled: boolean; expectedMemoryGiB: number; node: string }> = {},
): ModelRun => ({
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name, labels: {}, annotations: {} },
  spec: {
    node: opts.node ?? "local",
    enabled: opts.enabled ?? true,
    target: { kind: "rel", value: "x.gguf" },
    extraArgs: [],
    workers: [],
    restartPolicy: "Always",
    gateway: false,
    allowExternalBind: false,
    timeoutSeconds: 60,
    resources:
      opts.expectedMemoryGiB !== undefined
        ? { expectedMemoryGiB: opts.expectedMemoryGiB }
        : undefined,
  },
});

const mkModelHost = (
  name: string,
  opts: Partial<{ expectedMemoryGiB: number; rel: string }> = {},
): ModelHostManifest => ({
  apiVersion: "llamactl/v1",
  kind: "ModelHost",
  metadata: { name },
  spec: {
    engine: "omlx",
    node: "local",
    enabled: true,
    binary: "/usr/bin/true",
    endpoint: { host: "127.0.0.1", port: 18094 },
    hostedModels: [{ rel: opts.rel ?? `${name}.gguf` }],
    extraArgs: [],
    restartPolicy: "Always",
    timeoutSeconds: 60,
    resources:
      opts.expectedMemoryGiB !== undefined
        ? { expectedMemoryGiB: opts.expectedMemoryGiB }
        : undefined,
  },
});

test("sumReservedForNode sums expectedMemoryGiB for enabled manifests on the node", () => {
  const all = [
    mkManifest("a", { expectedMemoryGiB: 8 }),
    mkManifest("b", { expectedMemoryGiB: 16 }),
    mkManifest("c", { expectedMemoryGiB: 4, enabled: false }),
    mkManifest("d", { expectedMemoryGiB: 2, node: "mac-mini" }),
  ];
  expect(sumReservedForNode(all, "local")).toBe(24);
});

test("reservedForNodeBreakdown only counts enabled manifests on the node and names each contributor", () => {
  const all = [
    mkManifest("granite41-8b", { expectedMemoryGiB: 8 }),
    mkManifest("gemma4-26b", { expectedMemoryGiB: 16 }),
    mkManifest("disabled-mlx", { expectedMemoryGiB: 18, enabled: false }),
    mkManifest("remote-only", { expectedMemoryGiB: 2, node: "mac-mini" }),
  ];
  const breakdown = reservedForNodeBreakdown(all, "local");
  expect(breakdown).toEqual([
    { name: "granite41-8b", expectedMemoryGiB: 8 },
    { name: "gemma4-26b", expectedMemoryGiB: 16 },
  ]);
  expect(sumReservedForNode(all, "local")).toBe(
    breakdown.reduce((sum, item) => sum + item.expectedMemoryGiB, 0),
  );
});

test("admission returns ok when within budget", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 36,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 8 })],
    incoming: mkManifest("b", { expectedMemoryGiB: 16 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.reservedAfter).toBe(24);
    expect(r.budget).toBe(36);
  }
});

test("admission returns over-budget when sum exceeds budget without force", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 16 })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reservedAfter).toBe(24);
});

test("admission over-budget reason attributes each contributor and names the levers", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 16 })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toContain("'b' (8.0 GiB)");
    expect(r.reason).toContain("'a' 16.0 GiB");
    expect(r.reason).toContain("Budget is 20.0 GiB");
    expect(r.reason).toContain("would reserve 24.0 GiB");
    expect(r.reason).toMatch(/--evict/);
    expect(r.reason).toContain("spec.budget.memoryGiB");
    expect(r.reason).toContain("does not bypass the budget");
  }
});

test("over-budget with disabled ModelHosts only counts the genuinely living contributor", () => {
  const living = [
    mkManifest("mlx-host-local", { expectedMemoryGiB: 12 }),
    mkManifest("disabled-a", { expectedMemoryGiB: 18, enabled: false }),
    mkManifest("disabled-b", { expectedMemoryGiB: 16, enabled: false }),
    mkManifest("disabled-c", { expectedMemoryGiB: 28, enabled: false }),
    mkManifest("disabled-d", { expectedMemoryGiB: 21, enabled: false }),
  ];
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: living,
    incoming: mkManifest("new-workload", { expectedMemoryGiB: 10 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reservedAfter).toBe(22);
    expect(r.reason).toContain("'mlx-host-local' 12.0 GiB");
    expect(r.reason).toContain("'new-workload' (10.0 GiB)");
    expect(r.reason).not.toContain("disabled-");
    expect(r.breakdown).toEqual([
      { name: "mlx-host-local", expectedMemoryGiB: 12 },
      { name: "new-workload", expectedMemoryGiB: 10 },
    ]);
  }
});

test("admission ok when force-admit set even if over budget", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 10,
    livingManifests: [],
    incoming: mkManifest("a", { expectedMemoryGiB: 30 }),
    forceAdmit: true,
  };
  expect(computeNodeBudget(input).ok).toBe(true);
});

test("defaultNodeBudgetGiB returns the manifest value when present, else 75% of physical RAM", () => {
  expect(defaultNodeBudgetGiB(48)).toBe(48);
  const auto = defaultNodeBudgetGiB();
  expect(auto).toBeGreaterThan(0);
});

test("estimateWorkloadMemoryGiB returns null for gateway workloads", () => {
  const m = mkManifest("a");
  m.spec.gateway = true;
  expect(estimateWorkloadMemoryGiB(m, resolveEnv({ LLAMA_CPP_MODELS: "/nonexistent" }))).toBe(null);
});

test("estimateWorkloadMemoryGiB returns null when file is missing", () => {
  expect(
    estimateWorkloadMemoryGiB(mkManifest("a"), resolveEnv({ LLAMA_CPP_MODELS: "/nonexistent" })),
  ).toBe(null);
});

test("estimateModelHostMemoryGiB uses expectedMemoryGiB before model-size fallback", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-admission-"));
  const modelsDir = join(tmp, "models");
  const rel = "mlx-community/big-model";
  const modelDir = join(modelsDir, rel);
  try {
    mkdirSync(modelDir, { recursive: true });
    const weights = join(modelDir, "weights.bin");
    writeFileSync(weights, "");
    truncateSync(weights, 23 * 1024 ** 3);
    expect(
      estimateModelHostMemoryGiB(mkModelHost("declared", { expectedMemoryGiB: 24, rel }), {
        ...resolveEnv({ LLAMA_CPP_MODELS: modelsDir }),
      }),
    ).toBe(24);
    expect(
      estimateModelHostMemoryGiB(mkModelHost("fallback", { rel }), {
        ...resolveEnv({ LLAMA_CPP_MODELS: modelsDir }),
      }),
    ).toBe(46);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
