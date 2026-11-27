import { describe, expect, test } from "bun:test";

import type { ClusterConfigPeer, LocalRoute, PeerSnapshot } from "../../src/workloadRuntime.js";

import { QUALIFICATION_LABEL } from "../../src/routing/capabilities.js";
import {
  buildRouteCatalog,
  catalogCandidatesFor,
  effectiveCandidate,
} from "../../src/routing/catalog.js";
import { listClusterRoutes } from "../../src/workloadRuntime.js";

const NOW = 1_760_000_000_000;
const MODEL = "org/glm.gguf";

const PEER_A: ClusterConfigPeer = { id: "peer-a", endpoint: "https://127.0.0.1:7843" };
const PEER_B: ClusterConfigPeer = { id: "peer-b", endpoint: "https://127.0.0.1:7844" };

function localRoute(
  workload: string,
  qualificationStage?: string,
  labels?: Record<string, string>,
): LocalRoute {
  return {
    workload,
    model: "shared",
    host: "127.0.0.1",
    port: 8080,
    engine: "llamacpp",
    kind: "ModelRun",
    pid: 4242,
    ...(qualificationStage !== undefined ? { qualificationStage } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
}

function peerSnapshot(labels?: Record<string, string>): PeerSnapshot {
  return {
    workloads: [
      {
        modelId: MODEL,
        port: 8080,
        ...(labels !== undefined ? { labels } : {}),
      },
    ],
    pressure: "NORMAL",
    fetchedAt: NOW,
  };
}

describe("#518 legacy degraded tier in the route catalog", () => {
  test("K1: a healthy local deployment wins a shared alias over a degraded one", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute("a-deg", "degraded"), localRoute("b-prod")],
      now: NOW,
    });

    const winner = effectiveCandidate(catalog, "shared");
    expect(winner?.advertisement.deploymentId).toContain("b-prod");
    expect(winner?.legacyWinner).toBe(true);
    const degraded = catalogCandidatesFor(catalog, "shared").find((candidate) =>
      candidate.advertisement.deploymentId.includes("a-deg"),
    );
    expect(degraded?.legacyWinner).toBe(false);
  });

  test("K2: a healthy peer candidate leads a degraded peer candidate", () => {
    const routes = listClusterRoutes(
      [],
      new Map<string, PeerSnapshot>([
        ["peer-a", peerSnapshot({ [QUALIFICATION_LABEL]: "degraded" })],
        ["peer-b", peerSnapshot()],
      ]),
      { peers: [PEER_A, PEER_B] },
      NOW,
    );
    const catalog = buildRouteCatalog({ routes, now: NOW });

    expect(
      catalogCandidatesFor(catalog, MODEL).map((candidate) => candidate.advertisement.ownerNodeId),
    ).toEqual(["peer-b", "peer-a"]);
  });

  test("K3: local candidates order healthy, degraded, then experimental", () => {
    const catalog = buildRouteCatalog({
      routes: [
        localRoute("a-exp", "experimental"),
        localRoute("b-deg", "degraded"),
        localRoute("c-prod"),
      ],
      now: NOW,
    });

    expect(
      catalogCandidatesFor(catalog, "shared").map(
        (candidate) => candidate.advertisement.deploymentId,
      ),
    ).toEqual(["deploy/local/c-prod", "deploy/local/b-deg", "deploy/local/a-exp"]);
  });

  test("K4: an explicit experimental label wins over a degraded stage", () => {
    const catalog = buildRouteCatalog({
      routes: [
        localRoute("a-exp-deg", "degraded", { [QUALIFICATION_LABEL]: "experimental" }),
        localRoute("b-deg", "degraded"),
      ],
      now: NOW,
    });

    const candidates = catalogCandidatesFor(catalog, "shared");
    expect(candidates.map((candidate) => candidate.advertisement.deploymentId)).toEqual([
      "deploy/local/b-deg",
      "deploy/local/a-exp-deg",
    ]);
    expect(candidates.map((candidate) => candidate.legacyWinner)).toEqual([true, false]);
  });
});
