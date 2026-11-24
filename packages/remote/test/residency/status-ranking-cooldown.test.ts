// #519: the ranking status read-out's cooldown and tier fields.
// `residencyRankingReadout` widens its gate from the two resident knobs to
// every ranking knob and gains `cooldownCharged` (the active switch-cooldown
// and min-residency charges), `drainTier` and `degradedTier` (the
// operational-state marks); `buildRankingSnapshot` forwards the node name,
// lastSucceededAtMs and nowMs so the charges resolve exactly as the live
// ranker prices them. At the pinned base the widened gate and the new
// fields do not exist, so every non-guard case fails BY ASSERTION — never
// by an import or type error. Hermetic: plain store snapshots, a fixed
// NOW_MS and the declared-exclusive z13-large-gpu group; no store, network
// or process is touched.
import { routingCapabilities, routingCatalog } from "@llamactl/core";
import { RESIDENCY_GROUPS, type ResidencyState } from "@llamactl/core/residency/lifecycle";
import { DEFAULT_PROFILE_SWITCH_TIMEOUTS } from "@llamactl/core/residency/planner";
import { describe, expect, test } from "bun:test";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../../src/residency/store.js";
import type { NodeRun, NodeRunResidency } from "../../src/workload/noderun-schema.js";

import * as rankingMod from "../../src/proxy/residency-ranking.js";
import { buildResidencyStatus, type ResidencyStatus } from "../../src/residency/procedures.js";

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
// the resident model names, the drain-charged model names, the active
// cooldown charges and the operational tiers. The cooldown/tier fields
// are optional so a base read-out (which lacks them) still typechecks;
// every read of them goes through `?? []`.
type RankingReadout = {
  residentPreference: number;
  coldLoadPenaltyMs: number;
  resident: string[];
  drainCharged: string[];
  cooldownCharged?: { model: string; untilMs: number }[];
  drainTier?: string[];
  degradedTier?: string[];
};

type ResidencyRankingReadoutFn = (input: {
  residency: NodeRunResidency | null | undefined;
  lifecycle: readonly ResidencyStateRecord[];
  nodeName?: string;
  lastSucceededAtMs?: Readonly<Record<string, number>>;
  nowMs?: number;
}) => RankingReadout | null;

type RankingSignals = ReturnType<typeof rankingMod.residencyRankingInputs>["signals"];

const NODE = "n";
const NOW_MS = 1_000_000;
const GROUP = "z13-large-gpu";
const MODEL = "rank/model";
const SWITCH: Readonly<Record<string, number>> = { "profile-switch:n": NOW_MS - 10_000 };

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

// The cooldownCharged read-out must equal the ranker's cooldownUntil
// signal exactly: a model is listed iff its signal value is still in the
// future, and untilMs is that signal value verbatim.
function expectCooldownParity(signals: RankingSignals, readout: RankingReadout): void {
  for (const m of ["a", "b", "c", "d", "e", "f", "g"]) {
    const until = signals.cooldownUntil?.(rankingAd(m)) ?? -Infinity;
    const charge = (readout.cooldownCharged ?? []).find((entry) => entry.model === m);
    expect(until > NOW_MS).toBe(charge !== undefined);
    if (charge !== undefined) {
      expect(charge.untilMs).toBe(until);
    }
  }
}

// a ready in the exclusive group (ready 20s ago), c downloaded in the
// same group — the min-residency hold charges c until a's ready-since
// plus the window.
const HOLD_LIFECYCLE: ResidencyStateRecord[] = [
  lifecycleRow("a", "ready", GROUP, NOW_MS - 20_000),
  lifecycleRow("c", "downloaded", GROUP),
];

// One row per model: a ready in the exclusive group, c downloaded in the
// same group, b ready ungrouped, e draining, f unloading, d failed and g
// ready.
const FULL_LIFECYCLE: ResidencyStateRecord[] = [
  lifecycleRow("a", "ready", GROUP, NOW_MS - 20_000),
  lifecycleRow("c", "downloaded", GROUP),
  lifecycleRow("b", "ready"),
  lifecycleRow("e", "draining"),
  lifecycleRow("f", "unloading"),
  lifecycleRow("d", "failed"),
  lifecycleRow("g", "ready"),
];

const FULL_STORE: ResidencyStoreSnapshot = {
  path: "/p",
  present: true,
  nonterminal: [],
  lastSucceededAtMs: SWITCH,
  lifecycle: FULL_LIFECYCLE,
};

const FULL_RESIDENCY: NodeRunResidency = {
  switchCooldownSeconds: 60,
  minResidencySeconds: 120,
  residentPreference: 1,
};

const SWITCH_ONLY_RESIDENCY: NodeRunResidency = { switchCooldownSeconds: 60 };

describe("buildResidencyStatus ranking cooldown and tiers (#519)", () => {
  test("RC1: a switch cooldown alone reports cooldownCharged in the section", () => {
    // Kills: the readout gate still being residentPreference===0 &&
    // coldLoadPenaltyMs===0; resident or drainCharged listed when the
    // ranker emits no resident set; procedures.ts not passing the node
    // name, lastSucceededAtMs or nowMs.
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const built = buildStatus({
      nodeRun: nodeRunManifest({ switchCooldownSeconds: 60 }),
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lastSucceededAtMs: SWITCH,
        lifecycle: [
          lifecycleRow("a", "ready", GROUP),
          lifecycleRow("c", "downloaded", GROUP),
          lifecycleRow("b", "ready"),
        ],
      },
      nowMs: NOW_MS,
    });
    expect(rankingOf(built)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      residentPreference: 0,
      coldLoadPenaltyMs: 0,
      resident: [],
      drainCharged: [],
      cooldownCharged: [{ model: "c", untilMs: NOW_MS + 50_000 }],
      drainTier: [],
      degradedTier: [],
      loadCredited: [],
    });
  });

  test("RC2: a min-residency hold alone reports cooldownCharged", () => {
    // Kills: the min-residency hold left out of the read-out.
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const built = buildStatus({
      nodeRun: nodeRunManifest({ minResidencySeconds: 120 }),
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lifecycle: HOLD_LIFECYCLE,
      },
      nowMs: NOW_MS,
    });
    const ranking = rankingOf(built);
    expect(ranking?.status).toBe("available");
    if (ranking?.status !== "available") return;
    expect(ranking.cooldownCharged).toEqual([{ model: "c", untilMs: NOW_MS + 100_000 }]);
    expect(ranking.resident).toEqual([]);
  });

  test("RC3: switch cooldown and min-residency compose to the later charge", () => {
    // Kills: composition by min, or by the switch cooldown alone — c is
    // charged until the later of the two instants.
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const built = buildStatus({
      nodeRun: nodeRunManifest({ switchCooldownSeconds: 60, minResidencySeconds: 120 }),
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lastSucceededAtMs: SWITCH,
        lifecycle: HOLD_LIFECYCLE,
      },
      nowMs: NOW_MS,
    });
    const ranking = rankingOf(built);
    expect(ranking?.status).toBe("available");
    if (ranking?.status !== "available") return;
    expect(ranking.cooldownCharged).toEqual([{ model: "c", untilMs: NOW_MS + 100_000 }]);
  });

  test("RC4: an expired min-residency hold reports no cooldown charge", () => {
    // Kills: listing expired charges that the ranker prices at
    // max(0, until-now) = 0.
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const built = buildStatus({
      nodeRun: nodeRunManifest({ minResidencySeconds: 120 }),
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lifecycle: [
          lifecycleRow("a", "ready", GROUP, NOW_MS - 200_000),
          lifecycleRow("c", "downloaded", GROUP),
        ],
      },
      nowMs: NOW_MS,
    });
    const ranking = rankingOf(built);
    expect(ranking?.status).toBe("available");
    if (ranking?.status !== "available") return;
    expect(ranking.cooldownCharged).toEqual([]);
  });

  test("RC5: drainTier and degradedTier list the operational marks sorted", () => {
    // Kills: the operational marks left out or unsorted — both lists are
    // inserted out of order, so a no-sort implementation fails.
    const built = buildStatus({
      nodeRun: nodeRunManifest({ residentPreference: 1 }),
      store: {
        path: "/p",
        present: true,
        nonterminal: [],
        lifecycle: [
          lifecycleRow("f", "unloading"),
          lifecycleRow("e", "draining"),
          lifecycleRow("h", "failed"),
          lifecycleRow("d", "failed"),
          lifecycleRow("g", "ready"),
        ],
      },
      nowMs: NOW_MS,
    });
    const ranking = rankingOf(built);
    expect(ranking?.status).toBe("available");
    if (ranking?.status !== "available") return;
    expect(ranking.drainTier).toEqual(["e", "f"]);
    expect(ranking.degradedTier).toEqual(["d", "h"]);
    expect(ranking.resident).toEqual(["g"]);
    expect(ranking.cooldownCharged).toEqual([]);
  });

  test("RC6: non-ranking knobs still report the section disabled", () => {
    // Guard: passes on base too — idleEvictSeconds is not a ranking knob.
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

  test("RC7: the read-out matches every live ranker signal with all knobs set", () => {
    // Kills: the read-out diverging from residencyRankingInputs — resident,
    // drain-charged, cooldown-charged and both operational tiers must equal
    // the live signals; a cooldown-only residency must still open the
    // read-out.
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const readoutFn = rankingReadoutExport();
    expect(typeof readoutFn).toBe("function");
    if (readoutFn === undefined) return;

    const { signals } = rankingMod.residencyRankingInputs({
      residency: FULL_RESIDENCY,
      store: FULL_STORE,
      nodeId: NODE,
      nodeName: NODE,
    });
    const readout = readoutFn({
      residency: FULL_RESIDENCY,
      lifecycle: FULL_LIFECYCLE,
      nodeName: NODE,
      lastSucceededAtMs: SWITCH,
      nowMs: NOW_MS,
    });
    expect(readout).not.toBeNull();
    if (readout === null) return;
    for (const m of ["a", "b", "c", "d", "e", "f", "g"]) {
      const ad = rankingAd(m);
      expect(signals.resident?.has(`deploy/${NODE}/${m}`) ?? false).toBe(
        readout.resident.includes(m),
      );
      expect(signals.drainMs?.(ad) === DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs).toBe(
        readout.drainCharged.includes(m),
      );
      expect(signals.operationalState?.(ad) === "draining").toBe(
        (readout.drainTier ?? []).includes(m),
      );
      expect(signals.operationalState?.(ad) === "failed").toBe(
        (readout.degradedTier ?? []).includes(m),
      );
    }
    expectCooldownParity(signals, readout);
    expect(
      readoutFn({ residency: SWITCH_ONLY_RESIDENCY, lifecycle: FULL_LIFECYCLE }),
    ).not.toBeNull();
  });

  test("RC8: a cooldown-only policy reports charges without resident or drain lists", () => {
    // Kills: resident or drain lists reported where the ranker applies no
    // load or drain cost; the disabled precheck not following the widened
    // gate (an absent store must report StoreAbsent, not disabled).
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const readoutFn = rankingReadoutExport();
    expect(typeof readoutFn).toBe("function");
    if (readoutFn === undefined) return;

    const { signals } = rankingMod.residencyRankingInputs({
      residency: SWITCH_ONLY_RESIDENCY,
      store: FULL_STORE,
      nodeId: NODE,
      nodeName: NODE,
    });
    expect(signals.resident).toBeUndefined();
    expect(signals.drainMs).toBeUndefined();
    const readout = readoutFn({
      residency: SWITCH_ONLY_RESIDENCY,
      lifecycle: FULL_LIFECYCLE,
      nodeName: NODE,
      lastSucceededAtMs: SWITCH,
      nowMs: NOW_MS,
    });
    expect(readout).not.toBeNull();
    if (readout === null) return;
    expect(readout.resident).toEqual([]);
    expect(readout.drainCharged).toEqual([]);
    expectCooldownParity(signals, readout);

    const built = buildStatus({
      nodeRun: nodeRunManifest(SWITCH_ONLY_RESIDENCY),
      nowMs: NOW_MS,
    });
    expect(rankingOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "StoreAbsent",
    });
  });
});
