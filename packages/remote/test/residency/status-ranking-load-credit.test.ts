// #519: the ranking status read-out's load-credit field.
// `residencyRankingReadout` gains `loadCredited` — the sorted
// { model, expectedReadyAtMs } entries the live inFlightLoadSignal
// would credit at nowMs: only `loading`/`warming` lifecycle rows with
// updatedAtMs < nowMs < updatedAtMs + defaultExpectedLoadMs, and only
// when residentPreference or coldLoadPenaltyMs is nonzero (the ranker
// emits no expectedLoadMs otherwise). The residencyStatus ranking
// section forwards the same list at the status nowMs. At the pinned
// base the field does not exist, so every case fails BY ASSERTION —
// never by an import or type error. Hermetic: plain store snapshots
// and a fixed NOW_MS; no store, network or process is touched.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { routingCapabilities, routingCatalog, routingRanking } from "@llamactl/core";
import { describe, expect, test } from "bun:test";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../../src/residency/store.js";
import type { NodeRun, NodeRunResidency } from "../../src/workload/noderun-schema.js";

import * as rankingMod from "../../src/proxy/residency-ranking.js";
import { buildResidencyStatus, type ResidencyStatus } from "../../src/residency/procedures.js";

// The ranking contract the assertions pin, described structurally so
// the file typechecks on both sides of the fix.
type LoadCredit = { model: string; expectedReadyAtMs: number };

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
      cooldownCharged?: { model: string; untilMs: number }[];
      drainTier?: string[];
      degradedTier?: string[];
      loadCredited?: LoadCredit[];
    };

// The read-out residencyRankingReadout returns for an applicable
// policy: the resident model names, the drain-charged model names, the
// active cooldown charges, the operational tiers and the load credits.
// The newer fields are optional so a base read-out (which lacks them)
// still typechecks; every read of them is a direct property access.
type RankingReadout = {
  residentPreference: number;
  coldLoadPenaltyMs: number;
  resident: string[];
  drainCharged: string[];
  cooldownCharged?: { model: string; untilMs: number }[];
  drainTier?: string[];
  degradedTier?: string[];
  loadCredited?: LoadCredit[];
};

type ResidencyRankingReadoutFn = (input: {
  residency: NodeRunResidency | null | undefined;
  lifecycle: readonly ResidencyStateRecord[];
  nodeName?: string;
  lastSucceededAtMs?: Readonly<Record<string, number>>;
  nowMs?: number;
}) => RankingReadout | null;

const NODE = "n";
const NOW_MS = 1_000_000;
const MODEL = "rank/model";
const DEFAULT_LOAD_MS = routingRanking.DEFAULT_RANKING_WEIGHTS.defaultExpectedLoadMs;

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
  updatedAtMs: number = NOW_MS,
): ResidencyStateRecord {
  return {
    model,
    group,
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
}): ResidencyStatus {
  return buildResidencyStatus({
    node: NODE,
    nodeRun: input.nodeRun,
    budgetGiB: 10,
    budgetSource: "computed",
    store: input.store ?? { path: "/p", present: false },
    nowMs: input.nowMs,
    servingNode: NODE,
    unifiedProxy: true,
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

// One row per case the credit rule separates: a loading 20s ago (the
// only credited row), b warming 70s ago (overdue), c ready, d warming
// 5s in the future, e downloaded, f loading exactly one default expected
// load ago — the window's upper bound, which gets no credit — and g
// warming stamped exactly at nowMs, the window's lower bound: the
// read-out must not list it (elapsed is not strictly positive) while the
// live signal still charges it the full default.
const LOAD_LIFECYCLE: ResidencyStateRecord[] = [
  lifecycleRow("a", "loading", null, NOW_MS - 20_000),
  lifecycleRow("b", "warming", null, NOW_MS - 70_000),
  lifecycleRow("c", "ready"),
  lifecycleRow("d", "warming", null, NOW_MS + 5_000),
  lifecycleRow("e", "downloaded"),
  lifecycleRow("f", "loading", null, NOW_MS - DEFAULT_LOAD_MS),
  lifecycleRow("g", "warming", null, NOW_MS),
];

const LOAD_STORE: ResidencyStoreSnapshot = {
  path: "/p",
  present: true,
  nonterminal: [],
  lifecycle: LOAD_LIFECYCLE,
};

const A_LOADING_STORE: ResidencyStoreSnapshot = {
  path: "/p",
  present: true,
  nonterminal: [],
  lifecycle: [lifecycleRow("a", "loading", null, NOW_MS - 20_000)],
};

describe("residency ranking load-credit read-out (#519)", () => {
  test("LC1: only rows the live signal credits are listed", () => {
    // Kills: the loadCredited field missing; overdue, future,
    // fully-elapsed (upper bound) or other-state rows being listed; the
    // lower-bound row g stamped exactly at nowMs being listed (elapsed
    // <= 0 must reject it); expectedReadyAtMs not being updatedAtMs +
    // defaultExpectedLoadMs.
    const readoutFn = rankingReadoutExport();
    expect(typeof readoutFn).toBe("function");
    if (readoutFn === undefined) return;
    const readout = readoutFn({
      residency: { coldLoadPenaltyMs: 500 },
      lifecycle: LOAD_LIFECYCLE,
      nowMs: NOW_MS,
    });
    expect(readout).not.toBeNull();
    if (readout === null) return;
    expect(readout.loadCredited).toEqual([{ model: "a", expectedReadyAtMs: NOW_MS + 40_000 }]);
    const creditedModels = (readout.loadCredited ?? []).map((entry) => entry.model);
    expect(creditedModels).not.toContain("g");
  });

  test("LC2: loadCredited sorts by model and keeps warming rows", () => {
    // Kills: unsorted output (z is inserted before m), or warming rows
    // dropped so only loading rows are listed.
    const readoutFn = rankingReadoutExport();
    expect(typeof readoutFn).toBe("function");
    if (readoutFn === undefined) return;
    const readout = readoutFn({
      residency: { residentPreference: 1 },
      lifecycle: [
        lifecycleRow("z", "warming", null, NOW_MS - 1_000),
        lifecycleRow("m", "loading", null, NOW_MS - 30_000),
      ],
      nowMs: NOW_MS,
    });
    expect(readout).not.toBeNull();
    if (readout === null) return;
    expect(readout.loadCredited).toEqual([
      { model: "m", expectedReadyAtMs: NOW_MS + 30_000 },
      { model: "z", expectedReadyAtMs: NOW_MS + 59_000 },
    ]);
  });

  test("LC3: loadCredited matches the live inFlightLoadSignal exactly", () => {
    // Kills: the read-out diverging from inFlightLoadSignal — a listed
    // entry whose remaining load differs from the signal, an unlisted
    // row the signal still credits below the default, the window's upper
    // bound loosened (`elapsed >= default` mutated to `>`), which would
    // credit the fully-elapsed row f zero on the live path and list it
    // in the read-out, and the lower bound loosened (`since >= nowMs`
    // mutated to `>`), which drops the row g stamped exactly at nowMs to
    // no charge instead of the full default.
    const readoutFn = rankingReadoutExport();
    expect(typeof readoutFn).toBe("function");
    if (readoutFn === undefined) return;

    const { signals } = rankingMod.residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 500 },
      store: LOAD_STORE,
      nodeId: NODE,
      now: () => NOW_MS,
    });
    const readout = readoutFn({
      residency: { coldLoadPenaltyMs: 500 },
      lifecycle: LOAD_LIFECYCLE,
      nowMs: NOW_MS,
    });
    expect(readout).not.toBeNull();
    if (readout === null) return;
    const credited = readout.loadCredited;
    expect(credited).toBeDefined();
    if (credited === undefined) return;
    expect(credited.length).toBeGreaterThan(0);
    expect(credited).toEqual([{ model: "a", expectedReadyAtMs: NOW_MS + 40_000 }]);

    const expectedLoadMs = signals.expectedLoadMs;
    expect(typeof expectedLoadMs).toBe("function");
    if (expectedLoadMs === undefined) return;
    // The lower-bound row g (stamped exactly at nowMs) is not listed, but
    // the live signal must still charge it the full default. A strict
    // equality is required: the lenient check below would accept the
    // mutant's undefined.
    expect(expectedLoadMs(rankingAd("g"))).toBe(DEFAULT_LOAD_MS);
    for (const entry of credited) {
      expect(expectedLoadMs(rankingAd(entry.model))).toBe(entry.expectedReadyAtMs - NOW_MS);
    }
    for (const model of ["b", "c", "d", "e", "f"]) {
      const result = expectedLoadMs(rankingAd(model));
      expect(result === undefined || result === DEFAULT_LOAD_MS, model).toBe(true);
    }
  });

  test("LC4: a cooldown-only policy reports an empty loadCredited", () => {
    // Kills: gating loadCredited on rankingKnobsActive instead of the
    // resident knobs — the ranker emits no expectedLoadMs when
    // residentPreference and coldLoadPenaltyMs are both 0, even with a
    // nonzero switchCooldownSeconds.
    const readoutFn = rankingReadoutExport();
    expect(typeof readoutFn).toBe("function");
    if (readoutFn === undefined) return;
    const readout = readoutFn({
      residency: { switchCooldownSeconds: 30 },
      lifecycle: [lifecycleRow("a", "loading", null, NOW_MS - 20_000)],
      nowMs: NOW_MS,
    });
    expect(readout).not.toBeNull();
    if (readout === null) return;
    expect(readout.loadCredited).toEqual([]);
  });

  test("LC5: the ranking section forwards loadCredited at the status nowMs", () => {
    // Kills: rankingAvailable not forwarding the field, or
    // buildRankingSnapshot ignoring the status nowMs — the second call
    // 50s later must report the same row overdue.
    const built = buildStatus({
      nodeRun: nodeRunManifest({ residentPreference: 1 }),
      store: A_LOADING_STORE,
      nowMs: NOW_MS,
    });
    const ranking = rankingOf(built);
    expect(ranking?.status).toBe("available");
    if (ranking?.status !== "available") return;
    expect(ranking.loadCredited).toEqual([{ model: "a", expectedReadyAtMs: NOW_MS + 40_000 }]);

    const later = buildStatus({
      nodeRun: nodeRunManifest({ residentPreference: 1 }),
      store: A_LOADING_STORE,
      nowMs: NOW_MS + 50_000,
    });
    const laterRanking = rankingOf(later);
    expect(laterRanking?.status).toBe("available");
    if (laterRanking?.status !== "available") return;
    expect(laterRanking.loadCredited).toEqual([]);
  });
});
