/**
 * Pin route catalog v1 alias bindings, ordinals and conflicts.
 * Verifies header copy, per-alias ordinals, priority/replicaGroup carry,
 * conflict passthrough, and schema/serialization agreement.
 */
import { describe, expect, test } from "bun:test";

import type { RouteCapabilities } from "../../src/routing/capabilities.js";
import type { RouteAdvertisementV1 } from "../../src/routing/catalog.js";
import type { LocalRoute } from "../../src/workloadRuntime.js";

import {
  addCatalogAdvertisement,
  buildRouteCatalog,
  knownRevision,
  routeCatalogToV1,
  RouteCatalogV1Schema,
  serializeRouteCatalog,
  UNKNOWN_REVISION,
} from "../../src/routing/catalog.js";

function localRoute(over: Partial<LocalRoute> = {}): LocalRoute {
  return {
    workload: "wl-a",
    model: "shared.gguf",
    host: "127.0.0.1",
    port: 8080,
    engine: "llamacpp",
    kind: "ModelRun",
    pid: 4242,
    ...over,
  };
}

function fullCapabilities(over: Partial<RouteCapabilities> = {}): RouteCapabilities {
  return {
    operations: ["generate", "embed", "count-tokens"],
    protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
    streaming: "sse",
    modalities: ["text", "image"],
    tools: true,
    structuredOutput: true,
    tokenCounting: true,
    cancellation: true,
    sessions: true,
    ...over,
  };
}

function advertised(over: Partial<RouteAdvertisementV1> = {}): RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: "route/ext-1",
    deploymentId: "deploy/ext-1",
    backendId: "backend/ext-1",
    ownerNodeId: "worker-1",
    publicModelIds: ["ext-model"],
    upstreamModelId: "hf.co/org/ext-model",
    backendKind: "cloud-api",
    transport: "cloud-direct",
    endpoint: "https://api.example.com/v1",
    capabilities: fullCapabilities(),
    modelRevision: knownRevision("rev-1"),
    deploymentEpoch: knownRevision("epoch-1"),
    adapterRevision: UNKNOWN_REVISION,
    policyRevision: UNKNOWN_REVISION,
    weight: 1,
    draining: false,
    ...over,
  };
}

describe("route catalog v1 — header copy", () => {
  test("buildRouteCatalog header fields are copied to v1", () => {
    const v1 = routeCatalogToV1(
      buildRouteCatalog({
        routes: [],
        nodeId: "node1",
        now: 1000,
        ttlMs: 5000,
        catalogVersion: "cat-fixed",
        configRevision: knownRevision("cfg-1"),
      }),
    );
    expect(v1).toEqual({
      schemaVersion: 1,
      catalogVersion: "cat-fixed",
      configRevision: { status: "known", value: "cfg-1" },
      generatedAt: 1000,
      expiresAt: 6000,
      deployments: [],
      aliasBindings: [],
      conflicts: [],
    });
  });
});

describe("route catalog v1 — per-alias ordinals and legacy routeIds", () => {
  test("bindings carry publicId, routeId and ordinal; no legacy keys", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute({ workload: "wl-a" }), localRoute({ workload: "wl-b" })],
      nodeId: "node1",
    });
    const v1 = routeCatalogToV1(catalog);
    const bindings = v1.aliasBindings;

    expect(bindings).toHaveLength(2);
    expect(Object.keys(bindings[0]!)).toEqual(["publicId", "routeId", "ordinal"]);
    expect(Object.keys(bindings[1]!)).toEqual(["publicId", "routeId", "ordinal"]);

    expect(bindings[0]!).toEqual({
      publicId: "shared.gguf",
      routeId: "route/node1/wl-a",
      ordinal: 0,
    });
    expect(bindings[1]!).toEqual({
      publicId: "shared.gguf",
      routeId: "route/node1/wl-b",
      ordinal: 1,
    });
  });
});

describe("route catalog v1 — ordinals restart per alias, follow Map order", () => {
  test("one workload serving two aliases gives ordinal 0 each, sorted by alias", () => {
    const catalog = buildRouteCatalog({
      routes: [
        localRoute({ workload: "wl-a", model: "z-alias" }),
        localRoute({ workload: "wl-a", model: "a-alias" }),
      ],
      nodeId: "node1",
    });
    const v1 = routeCatalogToV1(catalog);
    const bindings = v1.aliasBindings;

    expect(bindings).toHaveLength(2);
    const publicIds = bindings.map((b) => b.publicId);
    expect(publicIds).toEqual(["a-alias", "z-alias"]);
    expect(bindings[0]!).toEqual({
      publicId: "a-alias",
      routeId: "route/node1/wl-a",
      ordinal: 0,
    });
    expect(bindings[1]!).toEqual({
      publicId: "z-alias",
      routeId: "route/node1/wl-a",
      ordinal: 0,
    });
  });
});

describe("route catalog v1 — priority is carried including 0", () => {
  test("a priority-0 binding has no replicaGroup key", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute()],
      nodeId: "node1",
      advertisements: [
        advertised({
          routeId: "route/ext-1",
          publicModelIds: ["shared.gguf"],
          priority: 0,
        }),
      ],
    });
    const v1 = routeCatalogToV1(catalog);
    const bindings = v1.aliasBindings;

    expect(bindings).toHaveLength(2);
    expect(bindings[0]!).toEqual({
      publicId: "shared.gguf",
      routeId: "route/node1/wl-a",
      ordinal: 0,
    });
    expect(bindings[1]!).toEqual({
      publicId: "shared.gguf",
      routeId: "route/ext-1",
      ordinal: 1,
      priority: 0,
    });
    expect(Object.keys(bindings[1]!)).toEqual(["publicId", "routeId", "ordinal", "priority"]);
  });
});

describe("route catalog v1 — replicaGroup is carried", () => {
  test("two advertisements with the same replicaGroup both accepted, no priority key", () => {
    const catalog = buildRouteCatalog({ routes: [], nodeId: "node1" });
    addCatalogAdvertisement(catalog, advertised({ replicaGroup: "rg-1" }));
    addCatalogAdvertisement(catalog, {
      ...advertised({
        routeId: "route/ext-2",
        deploymentId: "deploy/ext-2",
        backendId: "backend/ext-2",
      }),
      replicaGroup: "rg-1",
    });
    const v1 = routeCatalogToV1(catalog);
    const bindings = v1.aliasBindings;

    expect(bindings).toHaveLength(2);
    expect(bindings[0]!).toEqual({
      publicId: "ext-model",
      routeId: "route/ext-1",
      ordinal: 0,
      replicaGroup: "rg-1",
    });
    expect(bindings[1]!).toEqual({
      publicId: "ext-model",
      routeId: "route/ext-2",
      ordinal: 1,
      replicaGroup: "rg-1",
    });
    expect(Object.keys(bindings[0]!)).toEqual(["publicId", "routeId", "ordinal", "replicaGroup"]);
    expect(Object.keys(bindings[1]!)).toEqual(["publicId", "routeId", "ordinal", "replicaGroup"]);
  });
});

describe("route catalog v1 — conflicts pass through, rejected routes get no binding", () => {
  test("an alias-conflict is in v1.conflicts and the rejected routeId appears nowhere", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute()],
      nodeId: "node1",
      advertisements: [advertised({ publicModelIds: ["shared.gguf"] })],
    });
    const v1 = routeCatalogToV1(catalog);

    expect(v1.conflicts).toEqual([
      {
        alias: "shared.gguf",
        existingRouteId: "route/node1/wl-a",
        rejectedRouteId: "route/ext-1",
        reason: "alias-conflict",
      },
    ]);

    const bindingRouteIds = v1.aliasBindings.map((b) => b.routeId);
    expect(bindingRouteIds).not.toContain("route/ext-1");

    const deploymentRouteIds = v1.deployments.map((d) => d.routeId);
    expect(deploymentRouteIds).not.toContain("route/ext-1");
  });
});

describe("route catalog v1 — schema and serialization agreement", () => {
  test("RouteCatalogV1Schema.parse(v1) equals v1 and serializeRouteCatalog agrees", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute()],
      nodeId: "node1",
      advertisements: [
        advertised({
          routeId: "route/ext-1",
          publicModelIds: ["shared.gguf"],
          priority: 0,
        }),
      ],
    });
    const v1 = routeCatalogToV1(catalog);

    const parsed = RouteCatalogV1Schema.parse(v1);
    expect(parsed).toEqual(v1);

    expect(serializeRouteCatalog(catalog)).toBe(JSON.stringify(v1));
  });
});
