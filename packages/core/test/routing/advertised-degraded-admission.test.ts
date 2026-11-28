import { describe, expect, test } from "bun:test";

import type { RouteAdvertisementV1, RouteCatalog } from "../../src/routing/catalog.js";
import type { ClusterRoute, LocalRoute } from "../../src/workloadRuntime.js";

import { LEGACY_PROXY_CAPABILITIES } from "../../src/routing/capabilities.js";
import {
  addCatalogAdvertisement,
  buildRouteCatalog,
  catalogCandidatesFor,
  effectiveCandidate,
  knownRevision,
  routeCatalogToV1,
  selectCatalogCandidates,
  UNKNOWN_REVISION,
} from "../../src/routing/catalog.js";
import { pickRouteCandidate } from "../../src/routing/ranking.js";

const NOW = 1_000_000;
const MODEL = "late.gguf";

function ad(id: string, over: Partial<RouteAdvertisementV1> = {}): RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/ext-${id}`,
    deploymentId: `deploy/ext-${id}`,
    backendId: `backend/ext-${id}`,
    ownerNodeId: "node-x",
    publicModelIds: [MODEL],
    upstreamModelId: MODEL,
    backendKind: "local-model",
    transport: "worker-rpc",
    endpoint: "http://127.0.0.1:1",
    capabilities: LEGACY_PROXY_CAPABILITIES,
    modelRevision: UNKNOWN_REVISION,
    deploymentEpoch: UNKNOWN_REVISION,
    adapterRevision: UNKNOWN_REVISION,
    policyRevision: UNKNOWN_REVISION,
    weight: 1,
    draining: false,
    ...over,
  };
}

const degraded = { qualification: { stage: "degraded" } };

function localRoute(stage?: string): LocalRoute {
  return {
    workload: "a-local",
    model: MODEL,
    host: "127.0.0.1",
    port: 8080,
    engine: "llamacpp",
    kind: "ModelRun",
    pid: 4242,
    ...(stage !== undefined ? { qualificationStage: stage } : {}),
  };
}

function peerRoute(stage?: string): ClusterRoute {
  return {
    workload: "peer-w",
    model: MODEL,
    host: "127.0.0.1",
    port: 8080,
    engine: "llamacpp",
    kind: "ModelRun",
    isPeer: true,
    peerEndpoint: "https://127.0.0.1:7843",
    targetNodeId: "peer-a",
    ...(stage !== undefined ? { qualificationStage: stage } : {}),
  };
}

function candidateRouteIds(catalog: RouteCatalog): string[] {
  return catalogCandidatesFor(catalog, MODEL).map((candidate) => candidate.advertisement.routeId);
}

function degradedThenHealthyCatalog(): RouteCatalog {
  return buildRouteCatalog({
    routes: [],
    advertisements: [ad("deg", degraded), ad("healthy")],
    now: NOW,
  });
}

describe("#518 advertised degraded admission", () => {
  test("A1: a healthy advertisement is admitted over a degraded peer holder", () => {
    const catalog = buildRouteCatalog({
      routes: [peerRoute("degraded")],
      advertisements: [ad("healthy")],
      now: NOW,
    });

    const candidates = catalogCandidatesFor(catalog, MODEL);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.advertisement.routeId).toBe("route/ext-healthy");
    expect(effectiveCandidate(catalog, MODEL)?.advertisement.routeId).toBe("route/ext-healthy");
    expect(catalog.conflicts).toEqual([]);
    expect(
      candidates.find((candidate) => candidate.advertisement.routeId === "route/peer-a/peer-w")
        ?.legacyWinner,
    ).toBe(true);
  });

  test("A1b: a prioritized healthy advertisement leads a degraded local holder", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute("degraded")],
      advertisements: [ad("healthy", { priority: 1 })],
      now: NOW,
    });

    const candidates = catalogCandidatesFor(catalog, MODEL);
    expect(candidateRouteIds(catalog)).toEqual(["route/ext-healthy", "route/local/a-local"]);
    expect(effectiveCandidate(catalog, MODEL)?.advertisement.routeId).toBe("route/ext-healthy");
    expect(
      candidates.find((candidate) => candidate.advertisement.routeId === "route/local/a-local")
        ?.legacyWinner,
    ).toBe(true);
  });

  test("A2: a healthy advertisement is admitted after a degraded advertisement", () => {
    const catalog = degradedThenHealthyCatalog();

    expect(candidateRouteIds(catalog)).toEqual(["route/ext-healthy", "route/ext-deg"]);
    expect(catalog.conflicts).toEqual([]);
  });

  test("A3: a healthy replica ignores a divergent degraded replica holder", () => {
    const catalog = buildRouteCatalog({
      routes: [],
      advertisements: [
        ad("deg", {
          ...degraded,
          replicaGroup: "rg",
          modelRevision: knownRevision("rev-1"),
        }),
        ad("healthy", {
          replicaGroup: "rg",
          modelRevision: knownRevision("rev-2"),
        }),
      ],
      now: NOW,
    });

    expect(candidateRouteIds(catalog)).toEqual(["route/ext-healthy", "route/ext-deg"]);
    expect(
      catalog.conflicts.filter((conflict) => conflict.reason === "incompatible-replica"),
    ).toEqual([]);
  });

  test("A4: unified ranking picks the healthy advertisement over the degraded one", () => {
    const catalog = degradedThenHealthyCatalog();
    const selection = selectCatalogCandidates(catalog, MODEL, { pinned: true });

    expect(pickRouteCandidate(selection.eligible, { now: NOW })?.advertisement.routeId).toBe(
      "route/ext-healthy",
    );
  });

  test("A5: v1 alias bindings place the healthy advertisement before the degraded one", () => {
    const v1 = routeCatalogToV1(degradedThenHealthyCatalog());
    const bindings = v1.aliasBindings.filter((binding) => binding.publicId === MODEL);

    expect(bindings.find((binding) => binding.routeId === "route/ext-healthy")?.ordinal).toBe(0);
    expect(bindings.find((binding) => binding.routeId === "route/ext-deg")?.ordinal).toBe(1);
  });

  test("A6: a conflict against prioritized holders names the healthy holder first", () => {
    const catalog = buildRouteCatalog({ routes: [], now: NOW });
    const acceptedDeg = addCatalogAdvertisement(catalog, ad("deg", { ...degraded, priority: 1 }));
    expect(acceptedDeg).toEqual({ accepted: true });
    const acceptedH1 = addCatalogAdvertisement(catalog, ad("h1", { priority: 2 }));
    expect(acceptedH1).toEqual({ accepted: true });

    const result = addCatalogAdvertisement(catalog, ad("h2"));
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.rejection.reason).toBe("alias-conflict");
      expect(result.rejection.existingRouteId).toBe("route/ext-h1");
    }
  });

  test("G1: a degraded advertisement after a healthy one is still rejected", () => {
    const catalog = buildRouteCatalog({
      routes: [],
      advertisements: [ad("healthy"), ad("deg", degraded)],
      now: NOW,
    });

    expect(candidateRouteIds(catalog)).toEqual(["route/ext-healthy"]);
    expect(catalog.conflicts).toEqual([
      {
        alias: MODEL,
        existingRouteId: "route/ext-healthy",
        rejectedRouteId: "route/ext-deg",
        reason: "alias-conflict",
      },
    ]);
  });

  test("G2: a degraded advertisement after a degraded holder is still rejected", () => {
    const catalog = buildRouteCatalog({
      routes: [],
      advertisements: [ad("holder", degraded), ad("deg", degraded)],
      now: NOW,
    });

    expect(candidateRouteIds(catalog)).toEqual(["route/ext-holder"]);
    expect(catalog.conflicts).toEqual([
      {
        alias: MODEL,
        existingRouteId: "route/ext-holder",
        rejectedRouteId: "route/ext-deg",
        reason: "alias-conflict",
      },
    ]);
  });

  test("G3: an experimental advertisement after a degraded holder is still rejected", () => {
    const catalog = buildRouteCatalog({
      routes: [],
      advertisements: [
        ad("holder", degraded),
        ad("exp", { qualification: { stage: "experimental" } }),
      ],
      now: NOW,
    });

    expect(candidateRouteIds(catalog)).toEqual(["route/ext-holder"]);
    expect(catalog.conflicts).toEqual([
      {
        alias: MODEL,
        existingRouteId: "route/ext-holder",
        rejectedRouteId: "route/ext-exp",
        reason: "alias-conflict",
      },
    ]);
  });

  test("G4: a prioritized degraded advertisement still leads an experimental one", () => {
    const catalog = buildRouteCatalog({
      routes: [],
      advertisements: [
        ad("exp", { qualification: { stage: "experimental" }, priority: 1 }),
        ad("deg", { ...degraded, priority: 2 }),
      ],
      now: NOW,
    });

    expect(candidateRouteIds(catalog)).toEqual(["route/ext-deg", "route/ext-exp"]);
  });

  test("G5: a degraded local route stays authoritative over a healthy advertisement", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute("degraded")],
      advertisements: [ad("healthy")],
      now: NOW,
    });

    expect(candidateRouteIds(catalog)).toEqual(["route/local/a-local"]);
    expect(catalog.conflicts).toEqual([
      {
        alias: MODEL,
        existingRouteId: "route/local/a-local",
        rejectedRouteId: "route/ext-healthy",
        reason: "alias-conflict",
      },
    ]);
  });

  test("G6: a healthy advertisement is admitted over an experimental local route", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute("experimental")],
      advertisements: [ad("healthy")],
      now: NOW,
    });

    expect(candidateRouteIds(catalog)).toEqual(["route/ext-healthy", "route/local/a-local"]);
    expect(catalog.conflicts).toEqual([]);
  });
});
