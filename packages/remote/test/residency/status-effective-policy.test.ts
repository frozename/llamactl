// #519: the effective-policy read-out on `residencyStatus`. The status
// payload gains an `effectivePolicy` section listing every core residency
// knob in the fixed policy order, with the value after resolution against
// the defaults and `defaulted` recording whether the NodeRun supplied a
// valid override. At the pinned base the section does not exist, so every
// case fails BY ASSERTION — never by an import or type error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeRun, NodeRunResidency } from "../../src/workload/noderun-schema.js";

import { buildResidencyStatus } from "../../src/residency/procedures.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";

type Knob =
  | "idleEvictSeconds"
  | "minResidencySeconds"
  | "switchCooldownSeconds"
  | "safetyMarginRatio"
  | "residentPreference"
  | "coldLoadPenaltyMs";
type KnobEntry = { name: Knob; value: number; defaulted: boolean };
type EffectivePolicySection = { knobs: KnobEntry[] };

const ALL: Knob[] = [
  "idleEvictSeconds",
  "minResidencySeconds",
  "switchCooldownSeconds",
  "safetyMarginRatio",
  "residentPreference",
  "coldLoadPenaltyMs",
];
const DEFAULTS: Record<Knob, number> = {
  idleEvictSeconds: 0,
  minResidencySeconds: 0,
  switchCooldownSeconds: 0,
  safetyMarginRatio: 0.75,
  residentPreference: 0,
  coldLoadPenaltyMs: 0,
};

function entries(values: Record<Knob, number>, defaulted: readonly Knob[]): KnobEntry[] {
  return ALL.map((name) => ({
    name,
    value: values[name],
    defaulted: defaulted.includes(name),
  }));
}

const NODE = "n";

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-effective-policy-"));
  storePath = join(tmp, "residency-state", "operations.sqlite");
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

function nodeRunManifest(residency?: NodeRunResidency): NodeRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name: NODE, labels: {} },
    spec: {
      node: NODE,
      infra: [],
      ...(residency !== undefined ? { residency } : {}),
    },
  };
}

function effectivePolicyOf(built: unknown): EffectivePolicySection | undefined {
  return (built as { effectivePolicy?: EffectivePolicySection }).effectivePolicy;
}

describe("residencyStatus effectivePolicy (#519)", () => {
  test("EP1: without a NodeRun every knob reports its default", () => {
    const built = buildResidencyStatus({
      node: "n",
      nodeRun: undefined,
      budgetGiB: 10,
      budgetSource: "computed",
      store: { path: "/p", present: false },
      nowMs: 1_000_000,
    });
    expect(built.policy).toEqual({ present: false });
    expect(effectivePolicyOf(built)).toEqual({ knobs: entries(DEFAULTS, ALL) });
  });

  test("EP2: valid overrides are resolved and only unset knobs are defaulted", () => {
    const residency = { minResidencySeconds: 120, safetyMarginRatio: 0.6 };
    const built = buildResidencyStatus({
      node: "n",
      nodeRun: nodeRunManifest(residency),
      budgetGiB: 10,
      budgetSource: "computed",
      store: { path: "/p", present: false },
      nowMs: 1_000_000,
    });
    expect(built.policy).toEqual({ present: true, residency });
    expect(effectivePolicyOf(built)).toEqual({
      knobs: entries({ ...DEFAULTS, minResidencySeconds: 120, safetyMarginRatio: 0.6 }, [
        "idleEvictSeconds",
        "switchCooldownSeconds",
        "residentPreference",
        "coldLoadPenaltyMs",
      ]),
    });
  });

  test("EP3: all six knobs report their overrides in policy order", () => {
    const residency = {
      idleEvictSeconds: 600,
      minResidencySeconds: 30,
      switchCooldownSeconds: 90,
      safetyMarginRatio: 0.5,
      residentPreference: 2,
      coldLoadPenaltyMs: 1500,
    };
    const built = buildResidencyStatus({
      node: "n",
      nodeRun: nodeRunManifest(residency),
      budgetGiB: 10,
      budgetSource: "computed",
      store: { path: "/p", present: false },
      nowMs: 1_000_000,
    });
    expect(effectivePolicyOf(built)).toEqual({ knobs: entries(residency, []) });
  });

  test("EP4: explicit zeros count as overrides, not defaults", () => {
    const built = buildResidencyStatus({
      node: "n",
      nodeRun: nodeRunManifest({ switchCooldownSeconds: 0, residentPreference: 0 }),
      budgetGiB: 10,
      budgetSource: "computed",
      store: { path: "/p", present: false },
      nowMs: 1_000_000,
    });
    expect(effectivePolicyOf(built)).toEqual({
      knobs: entries(DEFAULTS, [
        "idleEvictSeconds",
        "minResidencySeconds",
        "safetyMarginRatio",
        "coldLoadPenaltyMs",
      ]),
    });
  });

  test("EP5: a resolver-rejected value falls back to the default and stays defaulted", () => {
    const nodeRun: NodeRun = {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: NODE, labels: {} },
      spec: {
        node: NODE,
        infra: [],
        residency: { safetyMarginRatio: 1.5 },
      },
    };
    const built = buildResidencyStatus({
      node: "n",
      nodeRun,
      budgetGiB: 10,
      budgetSource: "computed",
      store: { path: "/p", present: false },
      nowMs: 1_000_000,
    });
    expect(effectivePolicyOf(built)).toEqual({ knobs: entries(DEFAULTS, ALL) });
  });

  test("EP6: the router resolves effectivePolicy from the queried node's NodeRun", async () => {
    saveNodeRun(nodeRunManifest({ idleEvictSeconds: 300 }), tmp);
    const res = await router.createCaller({}).residencyStatus({ node: NODE });
    const section = effectivePolicyOf(res);
    expect((section?.knobs ?? []).find((k) => k.name === "idleEvictSeconds")).toEqual({
      name: "idleEvictSeconds",
      value: 300,
      defaulted: false,
    });
    expect((section?.knobs ?? []).filter((k) => k.defaulted).map((k) => k.name)).toEqual([
      "minResidencySeconds",
      "switchCooldownSeconds",
      "safetyMarginRatio",
      "residentPreference",
      "coldLoadPenaltyMs",
    ]);

    const other = await router.createCaller({}).residencyStatus({ node: "other" });
    expect(effectivePolicyOf(other)).toEqual({ knobs: entries(DEFAULTS, ALL) });
  });
});
