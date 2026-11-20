// #519: the switchGates status read-out (Part of #519).
// `buildResidencyStatus` gains a `switchGates` section that reports the
// NodeRun switch knobs against the serving node's store: when the node's last
// succeeded `profile-switch:<node>` operation finished (the snapshot's
// lastSucceededAtMs), whether the switch cooldown is still active, and — when
// minResidencySeconds is set — per ready lifecycle row whether the resident is
// still inside its minimum residency. The section is advisory only — status,
// never enforcement. At the pinned base the section does not exist, so every
// case fails BY ASSERTION on the structural probe — never by import or type
// error.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeRun, NodeRunResidency } from "../../src/workload/noderun-schema.js";

import { buildResidencyStatus, type ResidencyStatus } from "../../src/residency/procedures.js";
import {
  openResidencyOperationStore,
  type ResidencyOperationOutcome,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";

// The switchGates contract the assertions pin, described structurally so the
// file typechecks on both sides of the fix.
type SwitchGatesWorkload = {
  workload: string;
  readySinceMs: number;
  minResidencyUntilMs: number;
  held: boolean;
};

type SwitchGatesSection =
  | { status: "disabled"; scope: "serving-process" }
  | { status: "unavailable"; scope: "serving-process"; reason: string }
  | {
      status: "available";
      scope: "serving-process";
      advisory: true;
      switchCooldownSeconds: number;
      minResidencySeconds: number;
      lastSwitchAtMs: number | null;
      cooldownUntilMs: number | null;
      cooldownActive: boolean;
      workloads: SwitchGatesWorkload[];
    };

const NODE = "n";
const NOW_MS = 1_000_000;

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-switch-gates-"));
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

function lifecycleRow(
  model: string,
  state: ResidencyState,
  updatedAtMs: number,
): ResidencyStateRecord {
  return {
    model,
    group: null,
    state,
    ownerId: "o",
    incarnation: "i",
    fenceToken: 1,
    version: 1,
    updatedAtMs,
  };
}

function buildStatus(input: {
  nodeRun?: NodeRun | undefined;
  store?: ResidencyStoreSnapshot;
  nowMs: number;
  servingNode?: string | null;
}): ResidencyStatus {
  return buildResidencyStatus({
    node: NODE,
    nodeRun: input.nodeRun,
    budgetGiB: 10,
    budgetSource: "computed",
    store: input.store ?? { path: "/p", present: false },
    nowMs: input.nowMs,
    servingNode: input.servingNode === undefined ? NODE : input.servingNode,
  });
}

function switchGatesOf(built: unknown): SwitchGatesSection | undefined {
  return (built as { switchGates?: SwitchGatesSection }).switchGates;
}

type SeedOperation = {
  operationId: string;
  model: string;
  beginMs: number;
  finishMs?: number;
  outcome?: ResidencyOperationOutcome;
};

function seedOperation(
  store: ResidencyOperationStore,
  fenceToken: number,
  op: SeedOperation,
): void {
  const begun = store.beginOperation({
    fenceToken,
    operationId: op.operationId,
    model: op.model,
    targetState: "ready",
    desiredRevision: 0,
    reservationGiB: 0,
    nowMs: op.beginMs,
  });
  expect(begun.ok).toBe(true);
  if (!begun.ok || op.finishMs === undefined || op.outcome === undefined) {
    return;
  }
  const finished = store.finishOperation({
    fenceToken,
    operationId: op.operationId,
    expectedVersion: begun.record.version,
    nowMs: op.finishMs,
    outcome: op.outcome,
  });
  expect(finished).toEqual({ ok: true });
}

describe("buildResidencyStatus switchGates (#519)", () => {
  test("G1: no NodeRun or both switch knobs unset reports switchGates disabled", () => {
    // Kills: the switchGates section being omitted entirely, or the disabled
    // check removed (idleEvictSeconds alone must not enable it either).
    for (const nodeRun of [
      undefined,
      nodeRunManifest(),
      nodeRunManifest({}),
      nodeRunManifest({ switchCooldownSeconds: 0, minResidencySeconds: 0 }),
      nodeRunManifest({ idleEvictSeconds: 300 }),
    ]) {
      const built = buildStatus({ nodeRun, nowMs: NOW_MS });
      expect(switchGatesOf(built)).toEqual({ status: "disabled", scope: "serving-process" });
    }
  });

  test("G2: off the serving node the section is unavailable NotServingNode", () => {
    // Kills: the serving-node gate dropped (applying this node's policy and
    // store rows to a peer).
    for (const servingNode of [null, "other"] as const) {
      const built = buildStatus({
        nodeRun: nodeRunManifest({ switchCooldownSeconds: 600 }),
        nowMs: NOW_MS,
        servingNode,
      });
      expect(switchGatesOf(built)).toEqual({
        status: "unavailable",
        scope: "serving-process",
        reason: "NotServingNode",
      });
    }
  });

  test("G3: an unreadable store maps to StoreUnreadable", () => {
    // Kills: StoreUnreadable not mapped (collapsed into available-empty or a
    // different reason).
    const built = buildStatus({
      nodeRun: nodeRunManifest({ switchCooldownSeconds: 600 }),
      store: { path: "/p", present: true, error: "boom" },
      nowMs: NOW_MS,
    });
    expect(switchGatesOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "StoreUnreadable",
    });
  });

  test("G4: the cooldown reads lastSwitchAtMs from profile-switch:<node> only", () => {
    // Kills: cooldown measured from the wrong key, from any recorded key, or
    // not at all.
    const expected: SwitchGatesSection = {
      status: "available",
      scope: "serving-process",
      advisory: true,
      switchCooldownSeconds: 600,
      minResidencySeconds: 0,
      lastSwitchAtMs: 900_000,
      cooldownUntilMs: 1_500_000,
      cooldownActive: true,
      workloads: [],
    };
    const residency = nodeRunManifest({ switchCooldownSeconds: 600, minResidencySeconds: 0 });
    const own = buildStatus({
      nodeRun: residency,
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lastSucceededAtMs: { "profile-switch:n": 900_000 },
        lifecycle: [],
      },
      nowMs: NOW_MS,
    });
    expect(switchGatesOf(own)).toEqual(expected);
    const other = buildStatus({
      nodeRun: residency,
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lastSucceededAtMs: { "profile-switch:n": 900_000, "profile-switch:other": 999_999 },
        lifecycle: [],
      },
      nowMs: NOW_MS,
    });
    expect(switchGatesOf(other)).toEqual(expected);
  });

  test("G5: cooldownActive flips at the exact cooldownUntilMs boundary", () => {
    // Kills: `<` vs `<=` at the boundary — at nowMs === lastSwitch + window the
    // cooldown is over.
    const build = (lastSwitchAtMs: number): SwitchGatesSection | undefined =>
      switchGatesOf(
        buildStatus({
          nodeRun: nodeRunManifest({ switchCooldownSeconds: 600 }),
          store: {
            path: "/p",
            present: true,
            nonterminal: [],
            lastSucceededAtMs: { "profile-switch:n": lastSwitchAtMs },
            lifecycle: [],
          },
          nowMs: NOW_MS,
        }),
      );
    expect(build(400_000)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      switchCooldownSeconds: 600,
      minResidencySeconds: 0,
      lastSwitchAtMs: 400_000,
      cooldownUntilMs: 1_000_000,
      cooldownActive: false,
      workloads: [],
    });
    expect(build(400_001)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      switchCooldownSeconds: 600,
      minResidencySeconds: 0,
      lastSwitchAtMs: 400_001,
      cooldownUntilMs: 1_000_001,
      cooldownActive: true,
      workloads: [],
    });
  });

  test("G6: no recorded or non-finite switch reports null timestamps, inactive", () => {
    // Kills: a missing switch treated as active (epoch/0 cooldownUntilMs), or a
    // non-finite recorded value leaking through.
    const expected: SwitchGatesSection = {
      status: "available",
      scope: "serving-process",
      advisory: true,
      switchCooldownSeconds: 600,
      minResidencySeconds: 0,
      lastSwitchAtMs: null,
      cooldownUntilMs: null,
      cooldownActive: false,
      workloads: [],
    };
    const residency = nodeRunManifest({ switchCooldownSeconds: 600 });
    const stores: ResidencyStoreSnapshot[] = [
      { path: "/p", present: true, nonterminal: [], lifecycle: [] },
      {
        path: "/p",
        present: true,
        nonterminal: [],
        lastSucceededAtMs: { "profile-switch:other": 999_999 },
        lifecycle: [],
      },
      {
        path: "/p",
        present: true,
        nonterminal: [],
        lastSucceededAtMs: { "profile-switch:n": Number.NaN },
        lifecycle: [],
      },
      {
        path: "/p",
        present: true,
        nonterminal: [],
        lastSucceededAtMs: { "profile-switch:n": Number.POSITIVE_INFINITY },
        lifecycle: [],
      },
    ];
    for (const store of stores) {
      const built = buildStatus({ nodeRun: residency, store, nowMs: NOW_MS });
      expect(switchGatesOf(built)).toEqual(expected);
    }
  });

  test("G7: minResidencySeconds lists ready rows with held flags, sorted by model", () => {
    // Kills: min-residency rows not built, or built from non-ready rows; a
    // missing Math.min(nowMs, readySince) clamp; unsorted output.
    const built = buildStatus({
      nodeRun: nodeRunManifest({ minResidencySeconds: 300 }),
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lifecycle: [
          lifecycleRow("d", "ready", 2_000_000),
          lifecycleRow("c", "draining", 990_000),
          lifecycleRow("b", "ready", 600_000),
          lifecycleRow("a", "ready", 800_000),
        ],
      },
      nowMs: NOW_MS,
    });
    expect(switchGatesOf(built)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      switchCooldownSeconds: 0,
      minResidencySeconds: 300,
      lastSwitchAtMs: null,
      cooldownUntilMs: null,
      cooldownActive: false,
      workloads: [
        { workload: "a", readySinceMs: 800_000, minResidencyUntilMs: 1_100_000, held: true },
        { workload: "b", readySinceMs: 600_000, minResidencyUntilMs: 900_000, held: false },
        { workload: "d", readySinceMs: 2_000_000, minResidencyUntilMs: 1_300_000, held: true },
      ],
    });
  });

  test("G8: a lifecycle read failure is LifecycleUnreadable only when min-residency reads it", () => {
    // Kills: a lifecycle read failure hidden (reported available) or applied
    // when the knob that needs the rows is off.
    const held = buildStatus({
      nodeRun: nodeRunManifest({ minResidencySeconds: 300 }),
      store: { path: "/p", present: true, nonterminal: [], lifecycleError: "x" },
      nowMs: NOW_MS,
    });
    expect(switchGatesOf(held)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "LifecycleUnreadable",
    });
    const cooldownOnly = buildStatus({
      nodeRun: nodeRunManifest({ switchCooldownSeconds: 600 }),
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lastSucceededAtMs: { "profile-switch:n": 900_000 },
        lifecycleError: "x",
      },
      nowMs: NOW_MS,
    });
    expect(switchGatesOf(cooldownOnly)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      switchCooldownSeconds: 600,
      minResidencySeconds: 0,
      lastSwitchAtMs: 900_000,
      cooldownUntilMs: 1_500_000,
      cooldownActive: true,
      workloads: [],
    });
  });

  test("G9: an absent store is available with null switch fields and no rows", () => {
    // Kills: an absent store treated as unreadable or as a recorded switch.
    const expected: SwitchGatesSection = {
      status: "available",
      scope: "serving-process",
      advisory: true,
      switchCooldownSeconds: 600,
      minResidencySeconds: 0,
      lastSwitchAtMs: null,
      cooldownUntilMs: null,
      cooldownActive: false,
      workloads: [],
    };
    const cooldown = buildStatus({
      nodeRun: nodeRunManifest({ switchCooldownSeconds: 600 }),
      store: { path: "/p", present: false },
      nowMs: NOW_MS,
    });
    expect(switchGatesOf(cooldown)).toEqual(expected);
    const residency = buildStatus({
      nodeRun: nodeRunManifest({ minResidencySeconds: 300 }),
      store: { path: "/p", present: false },
      nowMs: NOW_MS,
    });
    expect(switchGatesOf(residency)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      switchCooldownSeconds: 0,
      minResidencySeconds: 300,
      lastSwitchAtMs: null,
      cooldownUntilMs: null,
      cooldownActive: false,
      workloads: [],
    });
  });
});

describe("residencyStatus switchGates router wiring (#519)", () => {
  test("R1: residencyStatus forwards the recorded switch into switchGates", async () => {
    // Kills: the router path missing the section. The router reads the real
    // Date.now(), so the seeded finish must be recent — the fixed timestamps
    // store-last-switch uses would read cooldownActive false here.
    const finishMs = Date.now() - 1_000;
    const beginMs = finishMs - 100;
    const writer = openResidencyOperationStore({ path: storePath });
    try {
      const fence = writer.claimOwnership({ ownerId: "t", incarnation: "i" });
      seedOperation(writer, fence.fenceToken, {
        operationId: "op-switch-n",
        model: "profile-switch:n",
        beginMs,
        finishMs,
        outcome: "succeeded",
      });
    } finally {
      writer.close();
    }
    saveNodeRun(nodeRunManifest({ switchCooldownSeconds: 3600 }), tmp);
    process.env["LLAMACTL_NODE_NAME"] = NODE;
    try {
      const res = await router.createCaller({}).residencyStatus({ node: NODE });
      expect(switchGatesOf(res)).toEqual({
        status: "available",
        scope: "serving-process",
        advisory: true,
        switchCooldownSeconds: 3600,
        minResidencySeconds: 0,
        lastSwitchAtMs: finishMs,
        cooldownUntilMs: finishMs + 3_600_000,
        cooldownActive: true,
        workloads: [],
      });
    } finally {
      Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
    }
  });
});
