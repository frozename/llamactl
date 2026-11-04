// Pins admission rules the existing suite left uncovered: alias-aware node
// accounting, budget edge arithmetic, and on-disk memory estimates.
// Part of frozename/llamactl#335.
import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "../../src/safe-fs.js";
import {
  type AdmissionInput,
  computeNodeBudget,
  defaultNodeBudgetGiB,
  estimateModelHostMemoryGiB,
  estimateWorkloadMemoryGiB,
  reservedForNodeBreakdown,
} from "../../src/workload/admission.js";

const mkManifest = (
  name: string,
  opts: Partial<{
    enabled: boolean;
    expectedMemoryGiB: number;
    node: string;
    target: ModelRun["spec"]["target"];
  }> = {},
): ModelRun => ({
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name, labels: {}, annotations: {} },
  spec: {
    node: opts.node ?? "local",
    enabled: opts.enabled ?? true,
    target: opts.target ?? { kind: "rel", value: "x.gguf" },
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

const writeSized = (path: string, gib: number): void => {
  writeFileSync(path, "");
  truncateSync(path, gib * 1024 ** 3);
};

test("computeNodeBudget charges living reservations found through an alias-aware sameNode", () => {
  const input: AdmissionInput = {
    nodeName: "mac-mini",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 16, node: "mac-mini.lan" })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
    sameNode: (other) => other === "mac-mini" || other === "mac-mini.lan",
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("over-budget");
  if (!r.ok && r.kind === "over-budget") {
    expect(r.reservedAfter).toBe(24);
    expect(r.breakdown).toEqual([
      { name: "a", expectedMemoryGiB: 16 },
      { name: "b", expectedMemoryGiB: 8 },
    ]);
  }
});

test("over-budget reason names alias-matched contributors instead of (none)", () => {
  const input: AdmissionInput = {
    nodeName: "mac-mini",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 16, node: "mac-mini.lan" })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
    sameNode: (other) => other === "mac-mini" || other === "mac-mini.lan",
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toContain("'a' 16.0 GiB");
    expect(r.reason).not.toContain("(none)");
  }
});

test("admission admits a reservation that exactly equals the budget", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 24,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 16 })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.reservedAfter).toBe(24);
    expect(r.budget).toBe(24);
  }
});

test("a non-finite budget is refused as unknown-budget, never admitted as unlimited", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: Number.POSITIVE_INFINITY,
    livingManifests: [],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("unknown-budget");
  if (!r.ok && r.kind === "unknown-budget") expect(r.reservedAfter).toBe(8);
});

test("unknown-budget reason names the budget levers and the force-admit escape hatch", () => {
  const input: AdmissionInput = {
    nodeName: "gpu-1",
    nodeBudgetGiB: null,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 4, node: "gpu-1" })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("unknown-budget");
  if (!r.ok && r.kind === "unknown-budget") {
    expect(r.reason).toContain("budget is unknown");
    expect(r.reason).toContain("declared reservations after this workload: 12.0 GiB");
    expect(r.reason).toContain("llamactl node test gpu-1");
    expect(r.reason).toContain("llamactl.io/force-admit annotation is the explicit escape hatch");
  }
});

test("force-admit against an unknown budget admits with a null budget", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: null,
    livingManifests: [],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: true,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.budget).toBe(null);
    expect(r.reservedAfter).toBe(8);
  }
});

test("over-budget reason with no living contributors reads to existing: (none)", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 4,
    livingManifests: [],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("over-budget");
  if (!r.ok && r.kind === "over-budget") expect(r.reason).toContain("to existing: (none)");
});

test("non-force callers get workload-level levers and no --evict hint", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 16 })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
    supportsForceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("over-budget");
  if (!r.ok && r.kind === "over-budget") {
    expect(r.reason).toContain("removing or disabling other workloads");
    expect(r.reason).not.toMatch(/--evict/);
  }
});

test("invalid-reservation lists every offender, living and incoming", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: Number.NaN })],
    incoming: mkManifest("b", { expectedMemoryGiB: -1 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("invalid-reservation");
  if (!r.ok && r.kind === "invalid-reservation") {
    expect(r.invalid).toEqual([
      { name: "a", expectedMemoryGiB: Number.NaN },
      { name: "b", expectedMemoryGiB: -1 },
    ]);
    expect(r.reason).toContain("'a' (NaN)");
    expect(r.reason).toContain("'b' (-1)");
  }
});

test("reservedForNodeBreakdown honours a custom sameNode matcher", () => {
  const all = [
    mkManifest("box-a", { expectedMemoryGiB: 4, node: "box" }),
    mkManifest("box-b", { expectedMemoryGiB: 6, node: "box-alias" }),
    mkManifest("other", { expectedMemoryGiB: 2, node: "other" }),
  ];
  expect(reservedForNodeBreakdown(all, "box", (other) => other.startsWith("box"))).toEqual([
    { name: "box-a", expectedMemoryGiB: 4 },
    { name: "box-b", expectedMemoryGiB: 6 },
  ]);
});

test("reservedForNodeBreakdown omits zero and absent reservations", () => {
  const all = [
    mkManifest("zero", { expectedMemoryGiB: 0 }),
    mkManifest("absent"),
    mkManifest("five", { expectedMemoryGiB: 5 }),
  ];
  expect(reservedForNodeBreakdown(all, "local")).toEqual([{ name: "five", expectedMemoryGiB: 5 }]);
});

test("defaultNodeBudgetGiB keeps an explicit zero manifest budget", () => {
  expect(defaultNodeBudgetGiB(0)).toBe(0);
  expect(defaultNodeBudgetGiB(0, 124 * 1024 ** 3)).toBe(0);
});

test("defaultNodeBudgetGiB falls back to host RAM for non-finite or negative memBytes", () => {
  const hostGiB = totalmem() / 1024 ** 3;
  expect(defaultNodeBudgetGiB(undefined, Number.POSITIVE_INFINITY)).toBe(hostGiB * 0.75);
  expect(defaultNodeBudgetGiB(undefined, -1)).toBe(hostGiB * 0.75);
});

test("estimateWorkloadMemoryGiB charges an existing rel file with 10% headroom", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-admission-rules-"));
  const modelsDir = join(tmp, "models");
  try {
    mkdirSync(modelsDir, { recursive: true });
    writeSized(join(modelsDir, "model.gguf"), 10);
    const manifest = mkManifest("a", { target: { kind: "rel", value: "model.gguf" } });
    const resolved = resolveEnv({ LLAMA_CPP_MODELS: modelsDir });
    expect(estimateWorkloadMemoryGiB(manifest, resolved)).toBeCloseTo(11, 6);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("estimateWorkloadMemoryGiB returns null for an alias target even when a namesake file exists", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-admission-rules-"));
  const modelsDir = join(tmp, "models");
  try {
    mkdirSync(modelsDir, { recursive: true });
    writeSized(join(modelsDir, "best"), 1);
    const manifest = mkManifest("a", { target: { kind: "alias", value: "best" } });
    const resolved = resolveEnv({ LLAMA_CPP_MODELS: modelsDir });
    expect(estimateWorkloadMemoryGiB(manifest, resolved)).toBe(null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("estimateModelHostMemoryGiB honours a declared zero over the weights fallback", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-admission-rules-"));
  const modelsDir = join(tmp, "models");
  try {
    mkdirSync(modelsDir, { recursive: true });
    const rel = "host-model";
    writeSized(join(modelsDir, rel), 4);
    const manifest = mkModelHost("declared-zero", { expectedMemoryGiB: 0, rel });
    const resolved = resolveEnv({ LLAMA_CPP_MODELS: modelsDir });
    expect(estimateModelHostMemoryGiB(manifest, resolved)).toBe(0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("estimateModelHostMemoryGiB doubles the size of a single weights file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-admission-rules-"));
  const modelsDir = join(tmp, "models");
  try {
    mkdirSync(modelsDir, { recursive: true });
    const rel = "single.gguf";
    writeSized(join(modelsDir, rel), 3);
    const manifest = mkModelHost("single", { rel });
    const resolved = resolveEnv({ LLAMA_CPP_MODELS: modelsDir });
    expect(estimateModelHostMemoryGiB(manifest, resolved)).toBe(6);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("estimateModelHostMemoryGiB sums a weights directory recursively", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-admission-rules-"));
  const modelsDir = join(tmp, "models");
  try {
    mkdirSync(modelsDir, { recursive: true });
    mkdirSync(join(modelsDir, "dir", "sub", "deeper"), { recursive: true });
    writeSized(join(modelsDir, "dir", "a"), 1);
    writeSized(join(modelsDir, "dir", "sub", "b"), 2);
    writeSized(join(modelsDir, "dir", "sub", "deeper", "c"), 1);
    const manifest = mkModelHost("dir-host", { rel: "dir" });
    const resolved = resolveEnv({ LLAMA_CPP_MODELS: modelsDir });
    expect(estimateModelHostMemoryGiB(manifest, resolved)).toBe(8);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("estimateModelHostMemoryGiB returns null when the rel path is missing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-admission-rules-"));
  const modelsDir = join(tmp, "models");
  try {
    mkdirSync(modelsDir, { recursive: true });
    const manifest = mkModelHost("ghost", { rel: "gone.gguf" });
    const resolved = resolveEnv({ LLAMA_CPP_MODELS: modelsDir });
    expect(estimateModelHostMemoryGiB(manifest, resolved)).toBe(null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("estimateModelHostMemoryGiB returns null when hostedModels is empty", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-admission-rules-"));
  const modelsDir = join(tmp, "models");
  try {
    mkdirSync(modelsDir, { recursive: true });
    const manifest = mkModelHost("empty-host", { rel: "x.gguf" });
    manifest.spec.hostedModels = [];
    const resolved = resolveEnv({ LLAMA_CPP_MODELS: modelsDir });
    expect(estimateModelHostMemoryGiB(manifest, resolved)).toBe(null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
