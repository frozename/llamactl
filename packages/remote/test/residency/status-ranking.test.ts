// #519: the ranking status read-out (Part of #519).
// `buildResidencyStatus` gains a `ranking` section that reports the serving
// node's resident set, exclusive-group drain charges, cooldown charges and
// operational tiers exactly as the unified proxy's ranker sees them. Any
// nonzero ranking knob — `residentPreference`, `coldLoadPenaltyMs`,
// `switchCooldownSeconds` or `minResidencySeconds` — opens the section
// (every knob 0, or no residency, reports disabled), while `resident` and
// `drainCharged` stay empty when both resident knobs are 0. Off the
// serving node it is unavailable NotServingNode, while the unified proxy
// is off it is unavailable UnifiedProxyOff, and an absent, unreadable or
// lifecycle-unreadable store maps to StoreAbsent, StoreUnreadable or
// LifecycleUnreadable. When available it carries the resolved knobs plus
// the resident, drain-charged (`drainCharged`), cooldown-charged
// (`cooldownCharged`), drain-tier (`drainTier`) and degraded-tier
// (`degradedTier`) model lists, computed by `residencyRankingReadout` in
// residency-ranking.ts — the same mapping the live ranker consumes, so
// the read-out cannot diverge from it. At the pinned base the
// cooldown/tier fields and the widened gate do not exist, so the updated
// cases fail BY ASSERTION — never by an import or type error.
import { routingCapabilities, routingCatalog } from "@llamactl/core";
import { RESIDENCY_GROUPS, type ResidencyState } from "@llamactl/core/residency/lifecycle";
import { DEFAULT_PROFILE_SWITCH_TIMEOUTS } from "@llamactl/core/residency/planner";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeRun, NodeRunResidency } from "../../src/workload/noderun-schema.js";

import * as rankingMod from "../../src/proxy/residency-ranking.js";
import { buildResidencyStatus, type ResidencyStatus } from "../../src/residency/procedures.js";
import {
  openResidencyOperationStore,
  type ResidencyStateRecord,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";

// The ranking contract the assertions pin, described structurally so the
// file typechecks on both sides of the fix.
type RankingSection =
  | { status: "disabled"; scope: "serving-process" }
  | { status: "unavailable"; scope: "serving-process"; reason: string }
  | {
      status: "available";
      scope: "serving-process";
      advisory: true;
      residentPreference: number;
      coldLoadPenaltyMs: number;
      resident: string[];
      drainCharged: string[];
      cooldownCharged: { model: string; untilMs: number }[];
      drainTier: string[];
      degradedTier: string[];
      loadCredited: { model: string; expectedReadyAtMs: number }[];
    };

// The read-out residencyRankingReadout returns for an applicable policy:
// the resident model names and the drain-charged model names. Declared
// locally so the base typechecks; the fix may carry more fields.
type RankingReadout = {
  resident: string[];
  drainCharged: string[];
};

type ResidencyRankingReadoutFn = (input: {
  residency: NodeRunResidency | null | undefined;
  lifecycle: readonly ResidencyStateRecord[];
}) => RankingReadout | null;

const NODE = "n";
const NOW_MS = 1_000_000;
const GROUP = "z13-large-gpu";
const MODEL = "rank/model";

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-ranking-"));
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
  group: string | null = null,
): ResidencyStateRecord {
  return {
    model,
    group,
    state,
    ownerId: "o",
    incarnation: "i",
    fenceToken: 1,
    version: 1,
    updatedAtMs: NOW_MS,
  };
}

// The K7 fixture: b ready ungrouped, a ready in the exclusive group, c
// downloaded in the same group (charged the drain against a), d failed
// ungrouped. Inserted unsorted so an unsorted read-out fails.
const K7_LIFECYCLE: ResidencyStateRecord[] = [
  lifecycleRow("b", "ready"),
  lifecycleRow("a", "ready", GROUP),
  lifecycleRow("c", "downloaded", GROUP),
  lifecycleRow("d", "failed"),
];

const K7_RESIDENCY: NodeRunResidency = { residentPreference: 2, coldLoadPenaltyMs: 500 };

const K7_STORE: ResidencyStoreSnapshot = {
  path: "/p",
  present: true,
  nonterminal: [],
  lifecycle: K7_LIFECYCLE,
};

function buildStatus(input: {
  nodeRun?: NodeRun | undefined;
  store?: ResidencyStoreSnapshot;
  nowMs: number;
  servingNode?: string | null;
  unifiedProxy?: boolean;
}): ResidencyStatus {
  return buildResidencyStatus({
    node: NODE,
    nodeRun: input.nodeRun,
    budgetGiB: 10,
    budgetSource: "computed",
    store: input.store ?? { path: "/p", present: false },
    nowMs: input.nowMs,
    servingNode: input.servingNode === undefined ? NODE : input.servingNode,
    ...(input.unifiedProxy !== undefined ? { unifiedProxy: input.unifiedProxy } : {}),
  });
}

function rankingOf(built: unknown): RankingSection | undefined {
  return (built as { ranking?: RankingSection }).ranking;
}

// A minimal route advertisement for the ranker callbacks: they read only
// ownerNodeId and deploymentId, but the signal type wants the full shape.
function rankingAd(model: string): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/${NODE}/${model}`,
    deploymentId: `deploy/${NODE}/${model}`,
    backendId: `backend/${NODE}/${model}`,
    ownerNodeId: NODE,
    publicModelIds: [MODEL],
    upstreamModelId: MODEL,
    backendKind: "local-model",
    transport: "worker-rpc",
    endpoint: "http://127.0.0.1:1",
    capabilities: routingCapabilities.LEGACY_PROXY_CAPABILITIES,
    modelRevision: routingCatalog.UNKNOWN_REVISION,
    deploymentEpoch: routingCatalog.UNKNOWN_REVISION,
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
    priority: 0,
  };
}

function rankingReadoutExport(): ResidencyRankingReadoutFn | undefined {
  return (rankingMod as Record<string, unknown>)["residencyRankingReadout"] as
    | ResidencyRankingReadoutFn
    | undefined;
}

// Walk one model to `ready` through the fenced lifecycle transitions, the
// same store API status-lifecycle-readout.test.ts uses.
function seedReadyLifecycleRow(
  store: ReturnType<typeof openResidencyOperationStore>,
  fenceToken: number,
  model: string,
): void {
  const path = ["downloaded", "loading", "warming", "ready"] as const;
  let version = 0;
  for (const [index, to] of path.entries()) {
    const result = store.transitionResidencyState({
      fenceToken,
      model,
      to,
      expectedVersion: version,
      nowMs: 1_000 + index,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      version = result.record.version;
    }
  }
}

describe("buildResidencyStatus ranking (#519)", () => {
  test("K1: no NodeRun or only non-ranking knobs reports ranking disabled", () => {
    // Kills: the ranking section being omitted entirely, or the disabled
    // check removed (idleEvictSeconds is not a ranking knob and must not
    // enable it — any of residentPreference, coldLoadPenaltyMs,
    // switchCooldownSeconds or minResidencySeconds does).
    for (const nodeRun of [
      undefined,
      nodeRunManifest(),
      nodeRunManifest({}),
      nodeRunManifest({ idleEvictSeconds: 300 }),
    ]) {
      const built = buildStatus({ nodeRun, nowMs: NOW_MS });
      expect(rankingOf(built)).toEqual({ status: "disabled", scope: "serving-process" });
    }
  });

  test("K2: off the serving node the section is unavailable NotServingNode", () => {
    // Kills: the serving-node gate dropped (reporting this node's resident
    // set and drain charges for a peer).
    for (const servingNode of ["other", null] as const) {
      const built = buildStatus({
        nodeRun: nodeRunManifest({ residentPreference: 2 }),
        nowMs: NOW_MS,
        servingNode,
        unifiedProxy: true,
      });
      expect(rankingOf(built)).toEqual({
        status: "unavailable",
        scope: "serving-process",
        reason: "NotServingNode",
      });
    }
  });

  test("K3: with the unified proxy off the section is unavailable UnifiedProxyOff", () => {
    // Kills: the unified-proxy gate removed or inverted — the ranker only
    // consumes these signals under LLAMACTL_UNIFIED_PROXY=1.
    for (const unifiedProxy of [false, undefined] as const) {
      const built = buildStatus({
        nodeRun: nodeRunManifest({ residentPreference: 2 }),
        nowMs: NOW_MS,
        ...(unifiedProxy === undefined ? {} : { unifiedProxy }),
      });
      expect(rankingOf(built)).toEqual({
        status: "unavailable",
        scope: "serving-process",
        reason: "UnifiedProxyOff",
      });
    }
  });

  test("K4: an absent store is unavailable StoreAbsent, not an empty available", () => {
    // Kills: an absent store reported as available — the ranker emits {}
    // signals there (unknown residency), so the read-out must say so.
    const built = buildStatus({
      nodeRun: nodeRunManifest(K7_RESIDENCY),
      store: { path: "/p", present: false },
      nowMs: NOW_MS,
      unifiedProxy: true,
    });
    expect(rankingOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "StoreAbsent",
    });
  });

  test("K5: an unreadable store is unavailable StoreUnreadable", () => {
    // Kills: StoreUnreadable not mapped (collapsed into available-empty or
    // reported as StoreAbsent).
    const built = buildStatus({
      nodeRun: nodeRunManifest(K7_RESIDENCY),
      store: { path: "/p", present: true, error: "boom" },
      nowMs: NOW_MS,
      unifiedProxy: true,
    });
    expect(rankingOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "StoreUnreadable",
    });
  });

  test("K6: a lifecycle read failure is unavailable LifecycleUnreadable", () => {
    // Kills: a lifecycle read failure hidden (reported available) — the
    // resident and drain lists are computed from those rows.
    const built = buildStatus({
      nodeRun: nodeRunManifest(K7_RESIDENCY),
      store: { path: "/p", present: true, nonterminal: [], lifecycleError: "x" },
      nowMs: NOW_MS,
      unifiedProxy: true,
    });
    expect(rankingOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "LifecycleUnreadable",
    });
  });

  test("K7: the available section lists ready residents and drain-charged models sorted", () => {
    // Kills: the resident list or drain list computed wrongly or unsorted —
    // residents are the ready lifecycle rows' models, drain-charged the
    // non-ready rows whose exclusive group another member occupies.
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const built = buildStatus({
      nodeRun: nodeRunManifest(K7_RESIDENCY),
      store: K7_STORE,
      nowMs: NOW_MS,
      unifiedProxy: true,
    });
    expect(rankingOf(built)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      residentPreference: 2,
      coldLoadPenaltyMs: 500,
      resident: ["a", "b"],
      drainCharged: ["c"],
      cooldownCharged: [],
      drainTier: [],
      degradedTier: ["d"],
      loadCredited: [],
    });
  });

  test("K8: the read-out matches the live ranker signals and the pure readout", () => {
    // Kills: the read-out diverging from residencyRankingInputs — the
    // resident set and drain charge the status reports must be exactly
    // what the ranker applies.
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const readoutFn = rankingReadoutExport();
    expect(typeof readoutFn).toBe("function");
    if (readoutFn === undefined) return;

    const { signals } = rankingMod.residencyRankingInputs({
      residency: K7_RESIDENCY,
      store: K7_STORE,
      nodeId: NODE,
      nodeName: NODE,
    });
    const readout = readoutFn({ residency: K7_RESIDENCY, lifecycle: K7_LIFECYCLE });
    expect(readout).not.toBeNull();
    if (readout === null) return;
    for (const m of ["a", "b", "c", "d"]) {
      expect(signals.resident?.has(`deploy/${NODE}/${m}`) ?? false).toBe(
        readout.resident.includes(m),
      );
      expect(signals.drainMs?.(rankingAd(m)) === DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs).toBe(
        readout.drainCharged.includes(m),
      );
    }

    // The pure readout applies when any ranking knob is nonzero.
    expect(readoutFn({ residency: {}, lifecycle: K7_LIFECYCLE })).toBeNull();
    expect(
      readoutFn({ residency: { switchCooldownSeconds: 60 }, lifecycle: K7_LIFECYCLE }),
    ).not.toBeNull();
  });
});

describe("residencyStatus ranking router wiring (#519)", () => {
  test("R1: residencyStatus reports the ranking section on the serving node", async () => {
    // Kills: the router path missing the section or the unified-proxy flag.
    const writer = openResidencyOperationStore({ path: storePath });
    try {
      const fence = writer.claimOwnership({ ownerId: "t", incarnation: "i" });
      seedReadyLifecycleRow(writer, fence.fenceToken, "m");
    } finally {
      writer.close();
    }
    saveNodeRun(nodeRunManifest({ coldLoadPenaltyMs: 250 }), tmp);
    process.env["LLAMACTL_NODE_NAME"] = NODE;
    process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
    try {
      const res = await router.createCaller({}).residencyStatus({ node: NODE });
      const ranking = (res as Record<string, unknown>)["ranking"] as
        | { status?: string; resident?: string[]; coldLoadPenaltyMs?: number }
        | undefined;
      expect(ranking?.status).toBe("available");
      expect(ranking?.resident).toEqual(["m"]);
      expect(ranking?.coldLoadPenaltyMs).toBe(250);
    } finally {
      Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
      Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
    }
  });

  test("R2: without LLAMACTL_UNIFIED_PROXY the section reports UnifiedProxyOff", async () => {
    // Kills: the router not forwarding the unified-proxy flag — the same
    // NodeRun and store must report UnifiedProxyOff when the flag is unset.
    const writer = openResidencyOperationStore({ path: storePath });
    try {
      const fence = writer.claimOwnership({ ownerId: "t", incarnation: "i" });
      seedReadyLifecycleRow(writer, fence.fenceToken, "m");
    } finally {
      writer.close();
    }
    saveNodeRun(nodeRunManifest({ coldLoadPenaltyMs: 250 }), tmp);
    process.env["LLAMACTL_NODE_NAME"] = NODE;
    Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
    try {
      const res = await router.createCaller({}).residencyStatus({ node: NODE });
      const ranking = (res as Record<string, unknown>)["ranking"] as
        | { status?: string; reason?: string }
        | undefined;
      expect(ranking?.status).toBe("unavailable");
      expect(ranking?.reason).toBe("UnifiedProxyOff");
    } finally {
      Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
    }
  });
});
