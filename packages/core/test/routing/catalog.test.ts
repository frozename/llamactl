/**
 * P0.2 (#130) — route catalog + capability contracts.
 * Pins candidate retention under alias collisions, legacy unqualified
 * alias precedence, advertised-alias conflict/replica rules, capability
 * filtering with typed rejections, and the no-secrets invariant.
 */
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RouteCapabilities } from "../../src/routing/capabilities.js";
import type { RouteAdvertisementV1 } from "../../src/routing/catalog.js";
import type { ClusterRoute, LocalRoute } from "../../src/workloadRuntime.js";

import {
  checkRouteCapabilities,
  deriveRequestFeatures,
  filterCandidatesByCapabilities,
} from "../../src/routing/capabilities.js";
import {
  addCatalogAdvertisement,
  buildRouteCatalog,
  catalogCandidatesFor,
  effectiveCandidate,
  knownRevision,
  RouteAdvertisementV1Schema,
  serializeRouteCatalog,
  UNKNOWN_REVISION,
} from "../../src/routing/catalog.js";
import { readdirSync, readFileSync } from "../../src/safe-fs.js";
import { listClusterRoutes } from "../../src/workloadRuntime.js";

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

function peerRoute(over: Partial<Extract<ClusterRoute, { isPeer: true }>> = {}): ClusterRoute {
  return {
    workload: "peer1:peer.gguf",
    model: "peer.gguf",
    host: "10.0.0.9",
    port: 443,
    engine: "llamacpp",
    kind: "ModelRun",
    isPeer: true,
    peerEndpoint: "https://10.0.0.9:443",
    token: "PEER-TOKEN-SECRET",
    certificate: "PEER-CERT-SECRET",
    targetNodeId: "peer1",
    revision: "boot-1",
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

describe("route catalog candidate retention", () => {
  test("two deployments exposing the same alias stay two candidates", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute({ workload: "wl-a" }), localRoute({ workload: "wl-b" })],
      nodeId: "node1",
    });
    const candidates = catalogCandidatesFor(catalog, "shared.gguf");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.legacyWinner).toBe(true);
    expect(candidates[1]!.legacyWinner).toBe(false);
    expect(candidates[0]!.advertisement.deploymentId).not.toBe(
      candidates[1]!.advertisement.deploymentId,
    );
    expect(catalog.deployments).toHaveLength(2);
  });

  test("a peer route is a transport location, not a distinct backend kind", () => {
    const catalog = buildRouteCatalog({ routes: [peerRoute()], nodeId: "node1" });
    const candidates = catalogCandidatesFor(catalog, "peer.gguf");
    expect(candidates).toHaveLength(1);
    const ad = candidates[0]!.advertisement;
    expect(ad.ownerNodeId).toBe("peer1");
    expect(ad.backendKind).toBe("local-model");
    expect(ad.endpoint).toBe("https://10.0.0.9:443");
    expect(ad.modelRevision).toEqual({ status: "known", value: "boot-1" });
  });

  test("a ModelHost's aliases all map to one deployment", () => {
    const catalog = buildRouteCatalog({
      routes: [
        localRoute({ kind: "ModelHost", engine: "omlx", model: "mlx-community/Q-4bit" }),
        localRoute({ kind: "ModelHost", engine: "omlx", model: "Q-4bit" }),
      ],
      nodeId: "node1",
    });
    expect(catalog.deployments).toHaveLength(1);
    expect(catalogCandidatesFor(catalog, "mlx-community/Q-4bit")).toHaveLength(1);
    expect(catalogCandidatesFor(catalog, "Q-4bit")).toHaveLength(1);
    expect(catalog.deployments[0]!.publicModelIds).toEqual(["mlx-community/Q-4bit", "Q-4bit"]);
  });
});

describe("legacy alias precedence", () => {
  test("ModelRun wins over ModelHost for the same alias regardless of name", () => {
    const catalog = buildRouteCatalog({
      routes: [
        localRoute({ workload: "a-host", kind: "ModelHost", engine: "omlx" }),
        localRoute({ workload: "z-run", kind: "ModelRun" }),
      ],
      nodeId: "node1",
    });
    const winner = effectiveCandidate(catalog, "shared.gguf");
    expect(winner?.advertisement.deploymentId).toContain("z-run");
    expect(catalogCandidatesFor(catalog, "shared.gguf")).toHaveLength(2);
  });

  test("workload-name order breaks ties within a kind", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute({ workload: "wl-b" }), localRoute({ workload: "wl-a" })],
      nodeId: "node1",
    });
    const winner = effectiveCandidate(catalog, "shared.gguf");
    expect(winner?.advertisement.deploymentId).toContain("wl-a");
  });

  test("a local route beats a peer advertising the same model", () => {
    const snapshot = {
      workloads: [{ modelId: "dup.gguf", port: 9, revision: "r" }],
      pressure: "NORMAL" as const,
      fetchedAt: Date.now(),
    };
    const routes = listClusterRoutes(
      [localRoute({ model: "dup.gguf" })],
      new Map([["peer1", snapshot]]),
      { peers: [{ id: "peer1", endpoint: "https://10.0.0.9:443" }] },
    );
    const catalog = buildRouteCatalog({ routes, nodeId: "node1" });
    const candidates = catalogCandidatesFor(catalog, "dup.gguf");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.advertisement.ownerNodeId).toBe("node1");
  });
});

describe("advertised alias conflicts", () => {
  test("a conflicting new alias is rejected without a replica group or priority", () => {
    const catalog = buildRouteCatalog({ routes: [localRoute()], nodeId: "node1" });
    const result = addCatalogAdvertisement(
      catalog,
      advertised({ publicModelIds: ["shared.gguf"] }),
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.reason).toBe("alias-conflict");
    expect(catalogCandidatesFor(catalog, "shared.gguf")).toHaveLength(1);
    expect(catalog.conflicts).toHaveLength(1);
  });

  test("replica group accepted only for a compatible serving identity", () => {
    const catalog = buildRouteCatalog({ routes: [], nodeId: "node1" });
    expect(
      addCatalogAdvertisement(catalog, advertised({ publicModelIds: ["svc"], replicaGroup: "g1" }))
        .accepted,
    ).toBe(true);
    const replica = advertised({
      routeId: "route/ext-2",
      deploymentId: "deploy/ext-2",
      backendId: "backend/ext-2",
      publicModelIds: ["svc"],
      replicaGroup: "g1",
    });
    expect(addCatalogAdvertisement(catalog, replica).accepted).toBe(true);
    expect(catalogCandidatesFor(catalog, "svc")).toHaveLength(2);

    const wrongUpstream = advertised({
      routeId: "route/ext-3",
      deploymentId: "deploy/ext-3",
      backendId: "backend/ext-3",
      publicModelIds: ["svc"],
      replicaGroup: "g1",
      upstreamModelId: "hf.co/org/other-model",
    });
    const r3 = addCatalogAdvertisement(catalog, wrongUpstream);
    expect(r3.accepted).toBe(false);
    if (!r3.accepted) expect(r3.rejection.reason).toBe("incompatible-replica");

    const wrongRevision = advertised({
      routeId: "route/ext-4",
      deploymentId: "deploy/ext-4",
      backendId: "backend/ext-4",
      publicModelIds: ["svc"],
      replicaGroup: "g1",
      modelRevision: knownRevision("rev-2"),
    });
    expect(addCatalogAdvertisement(catalog, wrongRevision).accepted).toBe(false);

    const unknownRevision = advertised({
      routeId: "route/ext-5",
      deploymentId: "deploy/ext-5",
      backendId: "backend/ext-5",
      publicModelIds: ["svc"],
      replicaGroup: "g1",
      modelRevision: UNKNOWN_REVISION,
    });
    expect(addCatalogAdvertisement(catalog, unknownRevision).accepted).toBe(false);
    expect(catalogCandidatesFor(catalog, "svc")).toHaveLength(2);
  });

  test("an explicit priority accepts a conflicting alternative without disturbing precedence", () => {
    const catalog = buildRouteCatalog({ routes: [localRoute()], nodeId: "node1" });
    const alt = advertised({ publicModelIds: ["shared.gguf"], priority: 5 });
    expect(addCatalogAdvertisement(catalog, alt).accepted).toBe(true);
    const candidates = catalogCandidatesFor(catalog, "shared.gguf");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.source).toBe("legacy");
    expect(candidates[0]!.legacyWinner).toBe(true);
    expect(candidates[1]!.advertisement.priority).toBe(5);
  });

  test("a replica group cannot hijack an alias owned by another group", () => {
    const catalog = buildRouteCatalog({ routes: [], nodeId: "node1" });
    addCatalogAdvertisement(catalog, advertised({ publicModelIds: ["svc"], replicaGroup: "g1" }));
    const intruder = advertised({
      routeId: "route/ext-2",
      deploymentId: "deploy/ext-2",
      backendId: "backend/ext-2",
      publicModelIds: ["svc"],
      replicaGroup: "g2",
    });
    const res = addCatalogAdvertisement(catalog, intruder);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.rejection.reason).toBe("alias-conflict");
  });

  test("an advertisement listing several aliases is atomic", () => {
    const catalog = buildRouteCatalog({ routes: [localRoute()], nodeId: "node1" });
    const res = addCatalogAdvertisement(
      catalog,
      advertised({ publicModelIds: ["fresh-alias", "shared.gguf"] }),
    );
    expect(res.accepted).toBe(false);
    expect(catalogCandidatesFor(catalog, "fresh-alias")).toHaveLength(0);
    expect(catalog.deployments).toHaveLength(1);
  });
});

describe("model identity", () => {
  test("slash-containing ids are never split", () => {
    const catalog = buildRouteCatalog({
      routes: [localRoute({ model: "via-node1/model.gguf" })],
      nodeId: "node1",
      advertisements: [
        advertised({
          publicModelIds: ["org/model-x"],
          upstreamModelId: "hf.co/org/model-x:Q4_K_M",
        }),
      ],
    });
    expect(catalogCandidatesFor(catalog, "org/model-x")).toHaveLength(1);
    expect(catalogCandidatesFor(catalog, "org")).toHaveLength(0);
    expect(catalogCandidatesFor(catalog, "model-x")).toHaveLength(0);
    const ad = catalogCandidatesFor(catalog, "org/model-x")[0]!.advertisement;
    expect(ad.upstreamModelId).toBe("hf.co/org/model-x:Q4_K_M");
    expect(catalogCandidatesFor(catalog, "via-node1/model.gguf")).toHaveLength(1);
  });
});

describe("capability derivation", () => {
  test("a plain chat body requires text only", () => {
    const f = deriveRequestFeatures({
      operation: "generate",
      ingressProtocol: "openai-chat",
      stream: false,
      nativeBody: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    expect(f.modalities).toEqual(["text"]);
    expect(f.tools).toBe(false);
    expect(f.structuredOutput).toBe(false);
  });

  test("image content parts require the image modality", () => {
    const f = deriveRequestFeatures({
      operation: "generate",
      ingressProtocol: "openai-chat",
      stream: false,
      nativeBody: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
            ],
          },
        ],
      },
    });
    expect(f.modalities).toContain("image");
    expect(f.modalities).toContain("text");
  });

  test("tools and response_format json_schema are detected", () => {
    const f = deriveRequestFeatures({
      operation: "generate",
      ingressProtocol: "openai-chat",
      stream: true,
      nativeBody: {
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
        response_format: { type: "json_schema", json_schema: { name: "s", schema: {} } },
      },
    });
    expect(f.tools).toBe(true);
    expect(f.structuredOutput).toBe(true);
    expect(f.stream).toBe(true);
  });

  test("anthropic tool declarations and image blocks are detected", () => {
    const f = deriveRequestFeatures({
      operation: "generate",
      ingressProtocol: "anthropic-messages",
      stream: false,
      nativeBody: {
        tools: [{ name: "t", input_schema: {} }],
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
          },
        ],
      },
    });
    expect(f.tools).toBe(true);
    expect(f.modalities).toContain("image");
  });
});

describe("capability filtering", () => {
  const required = {
    operation: "generate" as const,
    protocol: "openai-chat" as const,
    stream: false,
    modalities: ["text" as const],
    tools: false,
    structuredOutput: false,
    session: false,
    cancellation: true,
  };

  test("operation not offered rejects with a typed reason", () => {
    const r = checkRouteCapabilities(
      { ...required, operation: "embed" },
      fullCapabilities({ operations: ["generate"] }),
    );
    expect(r?.reason).toBe("unsupported-operation");
    if (r?.reason === "unsupported-operation") expect(r.operation).toBe("embed");
  });

  test("protocol not offered rejects with a typed reason", () => {
    const r = checkRouteCapabilities(
      { ...required, protocol: "anthropic-messages" },
      fullCapabilities({ protocols: ["openai-chat"] }),
    );
    expect(r?.reason).toBe("unsupported-protocol");
  });

  test("a stream request against a non-streaming backend rejects", () => {
    const r = checkRouteCapabilities(
      { ...required, stream: true },
      fullCapabilities({ streaming: "none" }),
    );
    expect(r?.reason).toBe("unsupported-streaming");
  });

  test("a stream request accepts a buffered backend", () => {
    const r = checkRouteCapabilities(
      { ...required, stream: true },
      fullCapabilities({ streaming: "buffered" }),
    );
    expect(r).toBeNull();
  });

  test("image modality against a text-only backend rejects", () => {
    const r = checkRouteCapabilities(
      { ...required, modalities: ["text", "image"] },
      fullCapabilities({ modalities: ["text"] }),
    );
    expect(r?.reason).toBe("unsupported-modality");
    if (r?.reason === "unsupported-modality") expect(r.modality).toBe("image");
  });

  test("tools, structured output, sessions, cancellation and token counting each type their rejection", () => {
    expect(
      checkRouteCapabilities({ ...required, tools: true }, fullCapabilities({ tools: false }))
        ?.reason,
    ).toBe("unsupported-tools");
    expect(
      checkRouteCapabilities(
        { ...required, structuredOutput: true },
        fullCapabilities({ structuredOutput: false }),
      )?.reason,
    ).toBe("unsupported-structured-output");
    expect(
      checkRouteCapabilities({ ...required, session: true }, fullCapabilities({ sessions: false }))
        ?.reason,
    ).toBe("unsupported-session");
    expect(
      checkRouteCapabilities(required, fullCapabilities({ cancellation: false }))?.reason,
    ).toBe("unsupported-cancellation");
    expect(
      checkRouteCapabilities(
        { ...required, operation: "count-tokens" },
        fullCapabilities({ tokenCounting: false }),
      )?.reason,
    ).toBe("unsupported-token-counting");
  });

  test("filter partitions eligible candidates from typed rejections", () => {
    const candidates = [
      { id: "a", capabilities: fullCapabilities({ tools: false }) },
      { id: "b", capabilities: fullCapabilities({ tools: true }) },
    ];
    const { eligible, rejected } = filterCandidatesByCapabilities(
      { ...required, tools: true },
      candidates,
      (c) => c.capabilities,
    );
    expect(eligible.map((c) => c.id)).toEqual(["b"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.candidate.id).toBe("a");
    expect(rejected[0]!.rejection.reason).toBe("unsupported-tools");
  });
});

describe("serialized catalog output", () => {
  test("carries no secret-bearing fields from peer routes or advertisements", () => {
    const catalog = buildRouteCatalog({
      routes: [peerRoute(), localRoute()],
      nodeId: "node1",
      advertisements: [advertised()],
    });
    const json = serializeRouteCatalog(catalog);
    expect(json).not.toContain("PEER-TOKEN-SECRET");
    expect(json).not.toContain("PEER-CERT-SECRET");
    const parsed = JSON.parse(json) as { deployments: RouteAdvertisementV1[] };
    expect(parsed.deployments.length).toBeGreaterThanOrEqual(2);
  });

  test("advertisement endpoints reject embedded credentials", () => {
    expect(
      RouteAdvertisementV1Schema.safeParse(
        advertised({ endpoint: "https://user:pass@api.example.com/v1" }),
      ).success,
    ).toBe(false);
  });
});

describe("core stays adapter-free", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else if (entry.name.endsWith(".ts")) yield p;
    }
  }

  test("no file under packages/core/src imports remote, tRPC or electron", () => {
    const banned = /^(?:@llamactl\/remote|@trpc(?:\/|$)|electron(?:\/|$)|.*\/electron)$/;
    const specifier = /(?:from|require|import)\s*(?:\(\s*)?["']([^"']+)["']/g;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(specifier)) {
        const spec = match[1];
        if (spec && banned.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
