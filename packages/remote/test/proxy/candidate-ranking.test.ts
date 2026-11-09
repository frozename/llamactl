/**
 * #518 — routing quality signals on the unified production proxy
 * (create-proxy.ts). Qualification stage, draining/cooldown state and
 * switch-cost-vs-quality-gain scoring reorder the eligible candidate
 * list; these pins drive createProxy with an injected two-advertisement
 * catalog plus a rankingSignals option and assert which ownerNodeId
 * acquireExecutor observes. RED until the ranking lands: the base picks
 * eligible.at(0) in catalog order, so node-a always wins.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BackendExecutor,
  type BackendExecutorDescription,
  createProxy,
} from "../../src/proxy/create-proxy.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const MODEL = "rank/model";
const NOW = 1_000_000;

type RankNode = "node-a" | "node-b";
type AdOverrides = Partial<routingCatalog.RouteAdvertisementV1>;

/** Shape of the rankingSignals option the fix adds to UnifiedProxyOptions. */
interface RankingSignals {
  /** deploymentIds currently resident on their owner node. */
  resident?: ReadonlySet<string>;
  expectedLoadMs?: (ad: routingCatalog.RouteAdvertisementV1) => number | undefined;
  drainMs?: (ad: routingCatalog.RouteAdvertisementV1) => number | undefined;
  cooldownUntil?: (ad: routingCatalog.RouteAdvertisementV1) => number | undefined;
}

let sandbox: string | undefined;

function fx(): string {
  if (sandbox === undefined) throw new Error("candidate-ranking fixture not started");
  return sandbox;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-candidate-ranking-"));
});

afterAll(() => {
  if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

function freshResolved(): ResolvedEnv {
  return resolveEnv({
    DEV_STORAGE: mkdtempSync(join(fx(), "dev-storage-")),
    LOCAL_AI_RUNTIME_DIR: mkdtempSync(join(fx(), "runtime-")),
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "/tmp",
  });
}

function rankAd(
  node: RankNode,
  priority: number,
  over: AdOverrides = {},
): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/${node}/w`,
    deploymentId: `deploy/${node}/w`,
    backendId: `backend/${node}/w`,
    ownerNodeId: node,
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

function chatReq(): Request {
  return new Request("http://agent.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  });
}

function recordingExecutor(id: string, calls: string[] = []): BackendExecutor {
  return {
    describe: (): BackendExecutorDescription => ({
      id,
      backendKinds: [],
      transports: [],
    }),
    execute: (envelope): Promise<Response> => {
      calls.push(envelope.publicModelId);
      return Promise.resolve(Response.json({ ok: true, executor: id }));
    },
    cancel: (): boolean => false,
    drain: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };
}

interface RankedOutcome {
  status: number;
  acquired: string[];
}

async function serveRanked(
  ads: readonly routingCatalog.RouteAdvertisementV1[],
  signals?: RankingSignals,
): Promise<RankedOutcome> {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: "local",
    now: NOW,
    advertisements: ads,
  });
  expect(routingCatalog.catalogCandidatesFor(cat, MODEL)).toHaveLength(2);
  const resolved = freshResolved();
  expect(openaiProxy.defaultTargetModelIds(resolved).has(MODEL)).toBe(false);
  const acquired: string[] = [];
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    now: () => NOW,
    resolved: () => resolved,
    catalog: () => cat,
    executor: recordingExecutor("default"),
    acquireExecutor: (candidate) => {
      const owner = candidate.advertisement.ownerNodeId;
      acquired.push(owner);
      return recordingExecutor(owner);
    },
    ...(signals !== undefined ? { rankingSignals: signals } : {}),
  });
  const response = await proxy.handleRequest(chatReq());
  return { status: response.status, acquired };
}

describe("unified proxy candidate ranking (#518)", () => {
  test("a production stage outranks a candidate stage", async () => {
    const { status, acquired } = await serveRanked([
      rankAd("node-a", 0, { qualification: { stage: "candidate" } }),
      rankAd("node-b", 1, { qualification: { stage: "production" } }),
    ]);
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("a degraded stage ranks below an unstaged peer", async () => {
    const { status, acquired } = await serveRanked([
      rankAd("node-a", 0, { qualification: { stage: "degraded" } }),
      rankAd("node-b", 1),
    ]);
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("a resident degraded candidate yields to a load-penalized unstaged peer on tier", async () => {
    // The peer alone carries the 600000 load cost, so only the degraded
    // tier ordering can put the peer first; score alone would rank the
    // resident degraded candidate (cost 0) above the penalized peer.
    const { status, acquired } = await serveRanked(
      [rankAd("node-a", 0, { qualification: { stage: "degraded" } }), rankAd("node-b", 1)],
      {
        resident: new Set(["deploy/node-a/w"]),
        expectedLoadMs: () => 600_000,
      },
    );
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("a draining deployment ranks below an unstaged peer", async () => {
    const { status, acquired } = await serveRanked([
      rankAd("node-a", 0, { draining: true }),
      rankAd("node-b", 1),
    ]);
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("resident switch cost outweighs the production-over-validated quality gain", async () => {
    const { status, acquired } = await serveRanked(
      [
        rankAd("node-a", 0, { qualification: { stage: "production" } }),
        rankAd("node-b", 1, { qualification: { stage: "validated" } }),
      ],
      {
        resident: new Set(["deploy/node-b/w"]),
        expectedLoadMs: (ad) => (ad.ownerNodeId === "node-a" ? 600_000 : undefined),
      },
    );
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("stage quality gain outweighs switch cost", async () => {
    const { status, acquired } = await serveRanked(
      [
        rankAd("node-a", 0, { qualification: { stage: "candidate" } }),
        rankAd("node-b", 1, { qualification: { stage: "production" } }),
      ],
      {
        resident: new Set(["deploy/node-a/w"]),
        expectedLoadMs: () => 10_000,
      },
    );
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("a candidate inside its cooldown window yields to its peer", async () => {
    const { status, acquired } = await serveRanked([rankAd("node-a", 0), rankAd("node-b", 1)], {
      resident: new Set(["deploy/node-a/w", "deploy/node-b/w"]),
      cooldownUntil: (ad) => (ad.ownerNodeId === "node-a" ? 1_120_000 : undefined),
    });
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("drain cost for a non-resident candidate flips the ranking", async () => {
    // node-a scores 90000 - 100000 drain = -10000 against node-b's 30000;
    // without the drain charge node-a's production stage would win at 90000.
    const { status, acquired } = await serveRanked(
      [
        rankAd("node-a", 0, { qualification: { stage: "production" } }),
        rankAd("node-b", 1, { qualification: { stage: "candidate" } }),
      ],
      {
        resident: new Set(["deploy/node-b/w"]),
        expectedLoadMs: () => 0,
        drainMs: (ad) => (ad.ownerNodeId === "node-a" ? 100_000 : undefined),
      },
    );
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("the default expected-load fallback prices non-resident activation", async () => {
    // node-a scores 90000 - 60000 default load = 30000; resident node-b
    // keeps its full 60000 validated score.
    const { status, acquired } = await serveRanked(
      [
        rankAd("node-a", 0, { qualification: { stage: "production" } }),
        rankAd("node-b", 1, { qualification: { stage: "validated" } }),
      ],
      { resident: new Set(["deploy/node-b/w"]) },
    );
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("stages below production rank below an unstaged peer on the unified path", async () => {
    const { status, acquired } = await serveRanked([
      rankAd("node-a", 0, { qualification: { stage: "validated" } }),
      rankAd("node-b", 1),
    ]);
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });
});

describe("unified proxy candidate ranking guards (#518)", () => {
  test("guard: catalog order decides when no ranking signal separates candidates", async () => {
    const { status, acquired } = await serveRanked([rankAd("node-a", 0), rankAd("node-b", 1)]);
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-a");
  });

  test("guard: an experimental candidate stays excluded on a pinned request", async () => {
    const { status, acquired } = await serveRanked([
      rankAd("node-a", 0, { qualification: { stage: "experimental" } }),
      rankAd("node-b", 1, { qualification: { stage: "degraded" } }),
    ]);
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("guard: equal stage and signals keep catalog order", async () => {
    const { status, acquired } = await serveRanked(
      [
        rankAd("node-a", 0, { qualification: { stage: "validated" } }),
        rankAd("node-b", 1, { qualification: { stage: "validated" } }),
      ],
      { expectedLoadMs: () => 1_000 },
    );
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-a");
  });

  test("guard: unknown residency adds no load cost", async () => {
    // Asymmetric charge: if the unknown-residency short-circuit were gone,
    // node-a alone would eat the 600000 load cost and lose to node-b.
    const { status, acquired } = await serveRanked(
      [
        rankAd("node-a", 0, { qualification: { stage: "production" } }),
        rankAd("node-b", 1, { qualification: { stage: "validated" } }),
      ],
      { expectedLoadMs: (ad) => (ad.ownerNodeId === "node-a" ? 600_000 : undefined) },
    );
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-a");
  });

  test("guard: drain is never charged to a resident candidate", async () => {
    const { status, acquired } = await serveRanked(
      [
        rankAd("node-a", 0, { qualification: { stage: "production" } }),
        rankAd("node-b", 1, { qualification: { stage: "validated" } }),
      ],
      {
        resident: new Set(["deploy/node-a/w", "deploy/node-b/w"]),
        drainMs: (ad) => (ad.ownerNodeId === "node-a" ? 100_000 : undefined),
      },
    );
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-a");
  });
});
