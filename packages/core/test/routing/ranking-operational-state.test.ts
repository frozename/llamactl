/**
 * #518 (c) — operational availability in unified candidate ranking.
 * RankingSignals gains an operationalState(ad) callback reporting the
 * node-local lifecycle state of a candidate's workload ("draining" for
 * draining/unloading rows, "failed" for failed rows, undefined otherwise);
 * tierOf folds it into the drain/degraded tiers and an effectiveStage
 * overlay zeroes a failed candidate's quality points. The base ignores
 * the signal entirely, so every case fails by assertion — never by a
 * link or type error — and holds once the ranking consumes it.
 */
import { routingCapabilities, routingCatalog, routingRanking } from "@llamactl/core";
import { describe, expect, test } from "bun:test";

const MODEL = "rank/model";
const NOW = 1_000_000;

/** Operational states the fix reports; declared locally so the base —
 *  whose RankingSignals lacks operationalState — still typechecks. */
type OperationalAvailability = "draining" | "failed";

type OperationalSignals = routingRanking.RankingSignals & {
  operationalState?: (
    ad: routingCatalog.RouteAdvertisementV1,
  ) => OperationalAvailability | undefined;
};

type AdOverrides = Partial<routingCatalog.RouteAdvertisementV1>;

function rankAd(
  workload: string,
  priority: number,
  over: AdOverrides = {},
): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/local/${workload}`,
    deploymentId: `deploy/local/${workload}`,
    backendId: `backend/local/${workload}`,
    ownerNodeId: "local",
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
    priority,
    ...over,
  };
}

function candidatesFor(
  ads: readonly routingCatalog.RouteAdvertisementV1[],
): routingCatalog.RouteCandidate[] {
  const catalog = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: "local",
    now: NOW,
    advertisements: ads,
  });
  const candidates = routingCatalog.catalogCandidatesFor(catalog, MODEL);
  expect(candidates).toHaveLength(ads.length);
  return candidates;
}

function rankedFor(
  candidates: readonly routingCatalog.RouteCandidate[],
  signals: OperationalSignals,
): routingRanking.RankedCandidate[] {
  return routingRanking.rankRouteCandidates(candidates, { now: NOW, signals });
}

function entry(
  ranked: readonly routingRanking.RankedCandidate[],
  deploymentId: string,
): routingRanking.RankedCandidate | undefined {
  return ranked.find((r) => r.candidate.advertisement.deploymentId === deploymentId);
}

describe("#518 operational state in candidate ranking", () => {
  test("an operationally draining candidate ranks behind a later stable peer", () => {
    // Kills: tierOf ignoring signals.operationalState — the marked ad keeps
    // tier 0 and wins catalog order over the stable peer.
    const candidates = candidatesFor([rankAd("a", 0), rankAd("b", 1)]);
    const signals: OperationalSignals = {
      operationalState: (ad: routingCatalog.RouteAdvertisementV1) =>
        ad.deploymentId === "deploy/local/a" ? "draining" : undefined,
    };
    const picked = routingRanking.pickRouteCandidate(candidates, { now: NOW, signals });
    expect(picked?.advertisement.deploymentId).toBe("deploy/local/b");
    const ranked = rankedFor(candidates, signals);
    expect(entry(ranked, "deploy/local/a")?.tier).toBe(2);
    expect(entry(ranked, "deploy/local/b")?.tier).toBe(0);
    expect(entry(ranked, "deploy/local/b")?.score).toBe(3 * 30_000);
  });

  test("a failed candidate takes the degraded tier with zero quality points (effectiveStage health overlay)", () => {
    // Kills: failed not mapped to the degraded tier, and keeping the ad's
    // stage points (3) under the overlay — a would stay tier 0 / 90000 and
    // outrank the staged candidate.
    const candidates = candidatesFor([
      rankAd("a", 0),
      rankAd("b", 1, { qualification: { stage: "candidate" } }),
    ]);
    const signals: OperationalSignals = {
      operationalState: (ad: routingCatalog.RouteAdvertisementV1) =>
        ad.deploymentId === "deploy/local/a" ? "failed" : undefined,
    };
    const picked = routingRanking.pickRouteCandidate(candidates, { now: NOW, signals });
    expect(picked?.advertisement.deploymentId).toBe("deploy/local/b");
    const ranked = rankedFor(candidates, signals);
    const failed = entry(ranked, "deploy/local/a");
    expect(failed?.tier).toBe(1);
    expect(failed?.qualityPoints).toBe(0);
  });

  test("failed ranks ahead of draining, both behind an unaffected candidate", () => {
    // Kills: swapping the tier weights (draining -> 1, failed -> 2) and
    // treating both states the same — the order would not be [c, b, a].
    const candidates = candidatesFor([rankAd("a", 0), rankAd("b", 1), rankAd("c", 2)]);
    const states: Record<string, OperationalAvailability | undefined> = {
      "deploy/local/a": "draining",
      "deploy/local/b": "failed",
    };
    const signals: OperationalSignals = {
      operationalState: (ad: routingCatalog.RouteAdvertisementV1) => states[ad.deploymentId],
    };
    const ranked = rankedFor(candidates, signals);
    expect(ranked.map((r) => r.candidate.advertisement.deploymentId)).toEqual([
      "deploy/local/c",
      "deploy/local/b",
      "deploy/local/a",
    ]);
  });

  test("an undefined operational state and a draining ad flag compose", () => {
    // Kills: replacing ad.draining instead of OR-ing it (a would drop to
    // tier 0 and take the pick), and treating any truthy state as draining
    // ("ready" would mark d tier 2).
    const candidates = candidatesFor([
      rankAd("a", 0, { draining: true }),
      rankAd("b", 1),
      rankAd("c", 2),
      rankAd("d", 3),
    ]);
    const states: Record<string, OperationalAvailability | undefined> = {
      "deploy/local/b": "draining",
      "deploy/local/d": "ready" as never,
    };
    const signals: OperationalSignals = {
      operationalState: (ad: routingCatalog.RouteAdvertisementV1) => states[ad.deploymentId],
    };
    const picked = routingRanking.pickRouteCandidate(candidates, { now: NOW, signals });
    expect(picked?.advertisement.deploymentId).toBe("deploy/local/c");
    const ranked = rankedFor(candidates, signals);
    expect(entry(ranked, "deploy/local/a")?.tier).toBe(2);
    expect(entry(ranked, "deploy/local/b")?.tier).toBe(2);
    expect(entry(ranked, "deploy/local/d")?.tier).toBe(0);
    expect(
      ranked.filter((r) => r.tier === 2).map((r) => r.candidate.advertisement.deploymentId),
    ).toEqual(["deploy/local/a", "deploy/local/b"]);
  });
});
