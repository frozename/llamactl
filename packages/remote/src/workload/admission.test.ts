import type {
  ManagedAdmissionClaim,
  ManagedAdmissionDecision,
} from "@llamactl/core/residency/admission";

import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { ModelHostManifest } from "./modelhost-schema.js";
import type { ModelRun } from "./schema.js";

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "../safe-fs.js";
import {
  type AdmissionInput,
  computeNodeBudget,
  createTargetAdmissionAuthority,
  declaredModelHostMemoryGiB,
  defaultNodeBudgetGiB,
  estimateModelHostMemoryGiB,
  estimateWorkloadMemoryGiB,
  reservedForNodeBreakdown,
  sumReservedForNode,
} from "./admission.js";
import { listAnyWorkloadsForAdmission } from "./store.js";

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
  opts: Partial<{
    expectedMemoryGiB: number;
    residentGiB: number;
    diskBackedGiB: number;
    rel: string;
  }> = {},
): ModelHostManifest => {
  const resources:
    | {
        expectedMemoryGiB?: number;
        residentGiB?: number;
        diskBackedGiB?: number;
      }
    | undefined =
    opts.expectedMemoryGiB !== undefined ||
    opts.residentGiB !== undefined ||
    opts.diskBackedGiB !== undefined
      ? {
          ...(opts.expectedMemoryGiB !== undefined
            ? { expectedMemoryGiB: opts.expectedMemoryGiB }
            : {}),
          ...(opts.residentGiB !== undefined ? { residentGiB: opts.residentGiB } : {}),
          ...(opts.diskBackedGiB !== undefined ? { diskBackedGiB: opts.diskBackedGiB } : {}),
        }
      : undefined;
  return {
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
      resources,
    },
  };
};

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
  if (!r.ok && r.kind === "over-budget") expect(r.reservedAfter).toBe(24);
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
    expect(r.reason).toContain("llamactl.io/force-admit");
    expect(r.reason).not.toContain("does not bypass");
  }
});

test("computeNodeBudget maps an invalid incoming reservation to a structured refusal", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 16 })],
    incoming: mkManifest("b", { expectedMemoryGiB: Number.NaN }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.kind).toBe("invalid-reservation");
    expect(r.reason).toContain("'b'");
  }
});

test("over-budget reason omits force-admit guidance when the caller cannot honor it", () => {
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
  if (!r.ok) {
    expect(r.reason).toContain("Budget is 20.0 GiB");
    expect(r.reason).not.toContain("force-admit");
  }
});

test("unknown-budget reason omits force-admit guidance when the caller cannot honor it", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: null,
    livingManifests: [],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
    supportsForceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toContain("budget is unknown");
    expect(r.reason).not.toContain("force-admit");
  }
});

test("invalid-reservation reason omits force-admit guidance when the caller cannot honor it", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: Number.NaN })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
    supportsForceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.kind).toBe("invalid-reservation");
    expect(r.reason).toContain("'a'");
    expect(r.reason).not.toContain("force-admit");
  }
});

test("computeNodeBudget maps a NaN living reservation to a structured refusal naming the offender", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: Number.NaN })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.kind).toBe("invalid-reservation");
    expect(r.reason).toContain("'a'");
  }
});

test("computeNodeBudget maps a negative living reservation to a structured refusal", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: -4 })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.kind).toBe("invalid-reservation");
    expect(r.reason).toContain("'a'");
  }
});

test("computeNodeBudget maps a negative-infinity living reservation to a structured refusal", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: Number.NEGATIVE_INFINITY })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.kind).toBe("invalid-reservation");
    expect(r.reason).toContain("'a'");
  }
});

test("computeNodeBudget force-admit cannot launder an invalid living reservation", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: Number.NaN })],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: true,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.kind).toBe("invalid-reservation");
    expect(r.reason).toContain("'a'");
    expect(r.reason).toContain("does not launder");
  }
});

test("computeNodeBudget treats a zero and an absent living reservation as valid non-contributors", () => {
  const input: AdmissionInput = {
    nodeName: "local",
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest("a", { expectedMemoryGiB: 0 }), mkManifest("legacy")],
    incoming: mkManifest("b", { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.reservedAfter).toBe(8);
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
  if (!r.ok) expect(r.kind).toBe("over-budget");
  if (!r.ok && r.kind === "over-budget") {
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

test("defaultNodeBudgetGiB sizes from the node's reported memory when the manifest is silent", () => {
  const hostGiB = totalmem() / 1024 ** 3;
  expect(defaultNodeBudgetGiB(undefined, 124 * 1024 ** 3)).toBe(93);
  expect(defaultNodeBudgetGiB(48, 124 * 1024 ** 3)).toBe(48);
  expect(defaultNodeBudgetGiB(undefined, null)).toBe(hostGiB * 0.75);
  expect(defaultNodeBudgetGiB(undefined, 0)).toBe(hostGiB * 0.75);
  expect(defaultNodeBudgetGiB(undefined, NaN)).toBe(hostGiB * 0.75);
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

// #277 C-2: spec.resources gains residentGiB (memory charged at admission) and
// diskBackedGiB (weights on disk, not resident). A streamed model declares both
// instead of expectedMemoryGiB; the estimator charges the larger of residentGiB
// and expectedMemoryGiB and must not fall back to the 2x weights heuristic when
// only disk-backed size is known.
test("estimateModelHostMemoryGiB charges a declared residentGiB for a streamed model", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-resident-"));
  const modelsDir = join(tmp, "models");
  const rel = "mlx-community/streamed-weights";
  const modelDir = join(modelsDir, rel);
  try {
    mkdirSync(modelDir, { recursive: true });
    const weights = join(modelDir, "weights.bin");
    writeFileSync(weights, "");
    truncateSync(weights, 60 * 1024 ** 3);
    const resolved = { ...resolveEnv({ LLAMA_CPP_MODELS: modelsDir }) };
    const estimate = estimateModelHostMemoryGiB(
      mkModelHost("streamed", { residentGiB: 100, diskBackedGiB: 103, rel }),
      resolved,
    );
    expect(estimate).toBe(100);
    if (estimate === null) return;
    const admit = computeNodeBudget({
      nodeName: "local",
      nodeBudgetGiB: 110,
      livingManifests: [],
      incoming: mkManifest("streamed", { expectedMemoryGiB: estimate }),
      forceAdmit: false,
    });
    expect(admit.ok).toBe(true);
    if (admit.ok) expect(admit.reservedAfter).toBe(100);
    // Control: the same weights without memory declarations still hit the 2x
    // fallback, which is exactly what the declared fields exist to replace.
    const control = estimateModelHostMemoryGiB(mkModelHost("control", { rel }), resolved);
    expect(control).toBe(120);
    if (control === null) return;
    const controlAdmit = computeNodeBudget({
      nodeName: "local",
      nodeBudgetGiB: 110,
      livingManifests: [],
      incoming: mkManifest("control", { expectedMemoryGiB: control }),
      forceAdmit: false,
    });
    expect(controlAdmit.ok).toBe(false);
    if (!controlAdmit.ok) expect(controlAdmit.kind).toBe("over-budget");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("declaredModelHostMemoryGiB charges the larger of residentGiB and expectedMemoryGiB", () => {
  expect(declaredModelHostMemoryGiB(mkModelHost("both-max"))).toBe(null);
  expect(declaredModelHostMemoryGiB(mkModelHost("expected-max", { expectedMemoryGiB: 24 }))).toBe(
    24,
  );
  expect(declaredModelHostMemoryGiB(mkModelHost("resident-max", { residentGiB: 12 }))).toBe(12);
  expect(
    declaredModelHostMemoryGiB(
      mkModelHost("both-small-resident", { expectedMemoryGiB: 24, residentGiB: 10 }),
    ),
  ).toBe(24);
  expect(
    declaredModelHostMemoryGiB(
      mkModelHost("both-large-resident", { expectedMemoryGiB: 24, residentGiB: 30 }),
    ),
  ).toBe(30);
  expect(
    declaredModelHostMemoryGiB(
      mkModelHost("disk-only-max", { residentGiB: 5, diskBackedGiB: 103 }),
    ),
  ).toBe(5);
  expect(declaredModelHostMemoryGiB(mkModelHost("disk-never-charged", { diskBackedGiB: 40 }))).toBe(
    null,
  );
});

test("estimateModelHostMemoryGiB charges the larger of residentGiB and expectedMemoryGiB", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-resident-max-"));
  const modelsDir = join(tmp, "models");
  const rel = "mlx-community/max-weights";
  const modelDir = join(modelsDir, rel);
  try {
    mkdirSync(modelDir, { recursive: true });
    const weights = join(modelDir, "weights.bin");
    writeFileSync(weights, "");
    truncateSync(weights, 23 * 1024 ** 3);
    const resolved = { ...resolveEnv({ LLAMA_CPP_MODELS: modelsDir }) };
    expect(
      estimateModelHostMemoryGiB(
        mkModelHost("smaller-resident", { expectedMemoryGiB: 24, residentGiB: 10, rel }),
        resolved,
      ),
    ).toBe(24);
    expect(
      estimateModelHostMemoryGiB(
        mkModelHost("larger-resident", { expectedMemoryGiB: 24, residentGiB: 30, rel }),
        resolved,
      ),
    ).toBe(30);
    expect(
      estimateModelHostMemoryGiB(mkModelHost("resident-only", { residentGiB: 12, rel }), resolved),
    ).toBe(12);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("declared diskBackedGiB without residentGiB never applies the 2x weights fallback", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-diskbacked-"));
  const modelsDir = join(tmp, "models");
  const rel = "mlx-community/diskbacked-weights";
  const modelDir = join(modelsDir, rel);
  try {
    mkdirSync(modelDir, { recursive: true });
    const weights = join(modelDir, "weights.bin");
    writeFileSync(weights, "");
    truncateSync(weights, 60 * 1024 ** 3);
    const resolved = { ...resolveEnv({ LLAMA_CPP_MODELS: modelsDir }) };
    expect(
      estimateModelHostMemoryGiB(mkModelHost("disk-only", { diskBackedGiB: 103, rel }), resolved),
    ).toBe(null);
    expect(
      estimateModelHostMemoryGiB(
        mkModelHost("disk-and-expected", { diskBackedGiB: 103, expectedMemoryGiB: 30, rel }),
        resolved,
      ),
    ).toBe(30);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("listAnyWorkloadsForAdmission charges residentGiB for ModelHost incumbents", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-incumbent-"));
  const workloadsDir = join(tmp, "workloads");
  const modelsDir = join(tmp, "models-empty");
  try {
    mkdirSync(workloadsDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });
    const hostManifest = (
      name: string,
      rel: string,
      resources: Record<string, number>,
    ): Record<string, unknown> => ({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name },
      spec: {
        engine: "omlx",
        node: "local",
        enabled: true,
        binary: "/usr/bin/true",
        endpoint: { host: "127.0.0.1", port: 18094 },
        hostedModels: [{ rel }],
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
        resources,
      },
    });
    // Raw YAML on purpose: saveModelHost would re-parse through the schema and
    // drop the not-yet-declared memory fields before they ever hit disk.
    writeFileSync(
      join(workloadsDir, "mlx-host-resident.yaml"),
      stringifyYaml(
        hostManifest("mlx-host-resident", "mlx-community/ghost-resident", {
          expectedMemoryGiB: 24,
          residentGiB: 10,
          diskBackedGiB: 40,
        }),
      ),
    );
    writeFileSync(
      join(workloadsDir, "mlx-host-expected.yaml"),
      stringifyYaml(
        hostManifest("mlx-host-expected", "mlx-community/ghost-expected", {
          expectedMemoryGiB: 24,
        }),
      ),
    );

    const declared = new Map(
      listAnyWorkloadsForAdmission(workloadsDir).map((m) => [m.metadata.name, m]),
    );
    expect(declared.get("mlx-host-resident")?.spec.resources?.expectedMemoryGiB).toBe(24);
    expect(declared.get("mlx-host-expected")?.spec.resources?.expectedMemoryGiB).toBe(24);

    const estimated = new Map(
      listAnyWorkloadsForAdmission(workloadsDir, resolveEnv({ LLAMA_CPP_MODELS: modelsDir })).map(
        (m) => [m.metadata.name, m],
      ),
    );
    expect(estimated.get("mlx-host-resident")?.spec.resources?.expectedMemoryGiB).toBe(24);
    expect(estimated.get("mlx-host-expected")?.spec.resources?.expectedMemoryGiB).toBe(24);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E-1: tryClaim charges living claims with the ledger, deduplicated by runtimeKey", () => {
  const authority = createTargetAdmissionAuthority();
  const living: ManagedAdmissionClaim[] = [
    {
      claimId: "store:x",
      runtimeKey: "x",
      specDigest: "d-x",
      state: "resident",
      allocationGiB: 8,
      kind: "ModelRun",
    },
  ];
  const claim = (
    runtimeKey: string,
    budgetGiB: number,
    extraLiving: ManagedAdmissionClaim[] = [],
  ): ManagedAdmissionDecision =>
    authority.tryClaim({
      targetIdentity: "t",
      runtimeKey,
      specDigest: `d-${runtimeKey}`,
      kind: "ModelRun",
      allocationGiB: 8,
      budgetGiB,
      living: [...living, ...extraLiving],
    }).decision;

  // 8 GiB living + 8 GiB incoming on a 12 GiB budget refuses.
  expect(claim("a", 12)).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
  // On 16 GiB it admits and charges living + incoming = 16.
  expect(claim("a", 16)).toMatchObject({ kind: "admit", committedGiB: 16 });
  // The admitted "a" stays pending in the ledger: living x(8) + pending a(8)
  // + incoming b(8) = 24 > 20 refuses even though each pair would fit.
  expect(claim("b", 20)).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
  // A living projection of "a" must not double-charge the ledger claim:
  // deduplicated, x(8) + a(8) + incoming c(8) = 24 <= 28 admits.
  const dup: ManagedAdmissionClaim = {
    claimId: "store:a",
    runtimeKey: "a",
    specDigest: "d-a",
    state: "resident",
    allocationGiB: 8,
    kind: "ModelRun",
  };
  expect(claim("c", 28, [dup])).toMatchObject({ kind: "admit", committedGiB: 24 });
});

test("two resident-declared hosts cannot both be admitted on a 32 GiB node", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-tight-node-"));
  const workloadsDir = join(tmp, "workloads");
  try {
    mkdirSync(workloadsDir, { recursive: true });
    const hostManifest = (
      name: string,
      rel: string,
      resources: Record<string, number>,
    ): Record<string, unknown> => ({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name },
      spec: {
        engine: "omlx",
        node: "local",
        enabled: true,
        binary: "/usr/bin/true",
        endpoint: { host: "127.0.0.1", port: 18094 },
        hostedModels: [{ rel }],
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
        resources,
      },
    });
    writeFileSync(
      join(workloadsDir, "host-a.yaml"),
      stringifyYaml(hostManifest("host-a", "ghost-a", { residentGiB: 20 })),
    );
    writeFileSync(
      join(workloadsDir, "host-b.yaml"),
      stringifyYaml(hostManifest("host-b", "ghost-b", { residentGiB: 14 })),
    );

    const projections = listAnyWorkloadsForAdmission(workloadsDir);
    expect(sumReservedForNode(projections, "local")).toBe(34);

    const [incumbent, incoming] = projections;
    if (!incumbent || !incoming) throw new Error("expected two projected ModelRuns");
    const admit = computeNodeBudget({
      nodeName: "local",
      nodeBudgetGiB: 32,
      livingManifests: [incumbent],
      incoming,
      forceAdmit: false,
    });
    expect(admit.ok).toBe(false);
    if (!admit.ok) expect(admit.kind).toBe("over-budget");
    if (!admit.ok && admit.kind === "over-budget") expect(admit.reservedAfter).toBe(34);

    const loose = computeNodeBudget({
      nodeName: "local",
      nodeBudgetGiB: 40,
      livingManifests: [incumbent],
      incoming,
      forceAdmit: false,
    });
    expect(loose.ok).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
