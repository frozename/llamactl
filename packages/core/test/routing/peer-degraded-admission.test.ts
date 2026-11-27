import { describe, expect, test } from "bun:test";

import type {
  ClusterConfigPeer,
  ClusterRoute,
  LocalRoute,
  PeerSnapshot,
} from "../../src/workloadRuntime.js";

import { isExperimentalRoute, QUALIFICATION_LABEL } from "../../src/routing/capabilities.js";
import { buildRouteCatalog, selectCatalogCandidates } from "../../src/routing/catalog.js";
import { rankRouteCandidates } from "../../src/routing/ranking.js";
import { listClusterRoutes } from "../../src/workloadRuntime.js";

const NOW = Date.now();
const MODEL = "org/glm.gguf";

const PEER_A: ClusterConfigPeer = { id: "peer-a", endpoint: "https://127.0.0.1:7843" };
const PEER_B: ClusterConfigPeer = { id: "peer-b", endpoint: "https://127.0.0.1:7844" };
const PEER_C: ClusterConfigPeer = { id: "peer-c", endpoint: "https://127.0.0.1:7845" };

function qualificationLabels(stage: string): Record<string, string> {
  return { [QUALIFICATION_LABEL]: stage };
}

function peerSnapshot(modelId: string, labels?: Record<string, string>): PeerSnapshot {
  return {
    workloads: [
      {
        modelId,
        port: 8080,
        ...(labels !== undefined ? { labels } : {}),
      },
    ],
    pressure: "NORMAL",
    fetchedAt: NOW,
  };
}

function snapshots(
  entries: readonly (readonly [string, PeerSnapshot])[],
): Map<string, PeerSnapshot> {
  return new Map(entries);
}

function peerOwners(routes: readonly ClusterRoute[]): string[] {
  return routes.flatMap((route) => ("isPeer" in route ? [route.targetNodeId] : []));
}

function localRoute(model: string, qualificationStage?: string): LocalRoute {
  return {
    workload: "local-host",
    model,
    host: "127.0.0.1",
    port: 8080,
    engine: "llamacpp",
    kind: "ModelRun",
    pid: 4242,
    ...(qualificationStage !== undefined ? { qualificationStage } : {}),
  };
}

describe("#518 peer degraded admission", () => {
  test("C1: a degraded peer label becomes a degraded route and advertisement stage", () => {
    // Kills: appendPeerRoutes not mapping the degraded label to a stage.
    const routes = listClusterRoutes(
      [],
      snapshots([["peer-a", peerSnapshot(MODEL, qualificationLabels("degraded"))]]),
      { peers: [PEER_A] },
      NOW,
    );
    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route.labels).toEqual(qualificationLabels("degraded"));
    expect(route.qualificationStage).toBe("degraded");

    const catalog = buildRouteCatalog({ routes, now: NOW });
    expect(catalog.deployments).toHaveLength(1);
    expect(catalog.deployments[0]?.qualification).toEqual({ stage: "degraded" });
  });

  test("C2: a degraded peer label never lifts an inherited experimental stage", () => {
    // Kills: an explicit degraded label beating an inherited experimental stage.
    const routes = listClusterRoutes(
      [],
      snapshots([["peer-a", peerSnapshot(MODEL, qualificationLabels("degraded"))]]),
      { peers: [PEER_A] },
      NOW,
      { stageByModel: new Map([[MODEL, "experimental"]]) },
    );
    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route.labels).toEqual(qualificationLabels("degraded"));
    expect(route.qualificationStage).toBe("experimental");
    expect(isExperimentalRoute(route)).toBe(true);
  });

  test("C3: a degraded first peer does not shadow a healthy peer in unified ranking", () => {
    // Kills: admitPeerRoute keeping its first-non-experimental-wins rule.
    const routes = listClusterRoutes(
      [],
      snapshots([
        ["peer-a", peerSnapshot(MODEL, qualificationLabels("degraded"))],
        ["peer-b", peerSnapshot(MODEL)],
      ]),
      { peers: [PEER_A, PEER_B] },
      NOW,
    );
    expect(peerOwners(routes)).toEqual(["peer-a", "peer-b"]);

    const catalog = buildRouteCatalog({ routes, now: NOW });
    const selection = selectCatalogCandidates(catalog, MODEL);
    const ranked = rankRouteCandidates(selection.eligible, { now: NOW });
    expect(ranked.map((entry) => entry.candidate.advertisement.ownerNodeId)).toEqual([
      "peer-b",
      "peer-a",
    ]);
    expect(ranked[0]?.candidate.advertisement.ownerNodeId).toBe("peer-b");
    expect(ranked[0]?.tier).toBe(0);
    expect(
      ranked.find((entry) => entry.candidate.advertisement.ownerNodeId === "peer-a")?.tier,
    ).toBe(1);
  });

  test("G1: a third healthy peer is skipped once a healthy peer holds the id", () => {
    // Kills: admitting every healthy peer after the experimental-only escape hatch.
    const routes = listClusterRoutes(
      [],
      snapshots([
        ["peer-a", peerSnapshot(MODEL, qualificationLabels("experimental"))],
        ["peer-b", peerSnapshot(MODEL)],
        ["peer-c", peerSnapshot(MODEL)],
      ]),
      { peers: [PEER_A, PEER_B, PEER_C] },
      NOW,
    );
    expect(peerOwners(routes)).toEqual(["peer-a", "peer-b"]);
  });

  test("G2: a degraded peer listed after a healthy peer is skipped", () => {
    // Kills: treating degraded as a second admissible class beside a healthy holder.
    const routes = listClusterRoutes(
      [],
      snapshots([
        ["peer-a", peerSnapshot(MODEL)],
        ["peer-b", peerSnapshot(MODEL, qualificationLabels("degraded"))],
      ]),
      { peers: [PEER_A, PEER_B] },
      NOW,
    );
    expect(peerOwners(routes)).toEqual(["peer-a"]);
  });

  test("G3: a non-experimental local route stays authoritative over every peer", () => {
    // Kills: a peer displacing or joining a non-experimental local route.
    const localStages: (string | undefined)[] = [undefined, "validated", "production", "degraded"];
    const peerLabelSets: (Record<string, string> | undefined)[] = [
      undefined,
      qualificationLabels("validated"),
    ];
    for (const stage of localStages) {
      for (const labels of peerLabelSets) {
        const routes = listClusterRoutes(
          [localRoute(MODEL, stage)],
          snapshots([["peer-a", peerSnapshot(MODEL, labels)]]),
          { peers: [PEER_A] },
          NOW,
        );
        const forModel = routes.filter((route) => route.model === MODEL);
        expect(forModel).toHaveLength(1);
        expect("isPeer" in forModel[0]!).toBe(false);
      }
    }
  });

  test("G4: a validated peer label still beats an inherited stage", () => {
    // Kills: validated losing its explicit-label precedence over inherited stages.
    const routes = listClusterRoutes(
      [],
      snapshots([["peer-a", peerSnapshot(MODEL, qualificationLabels("validated"))]]),
      { peers: [PEER_A] },
      NOW,
      { stageByModel: new Map([[MODEL, "experimental"]]) },
    );
    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route.labels).toEqual(qualificationLabels("validated"));
    expect("qualificationStage" in route).toBe(false);
    expect(route.qualificationStage).toBeUndefined();
    expect(isExperimentalRoute(route)).toBe(false);
  });
});
