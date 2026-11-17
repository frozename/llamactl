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
import type { LocalRoute } from "@llamactl/core/workloadRuntime";

import {
  openaiProxy,
  residencyAdmission,
  routingCapabilities,
  routingCatalog,
  routingRanking,
} from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BackendExecutionContext,
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

/** ResidencyPolicy knobs the #519 fix threads into candidate ranking. */
type PolicyKnobs = Partial<residencyAdmission.ResidencyPolicy>;

/** Shape of the residencyPolicy option the fix adds to UnifiedProxyOptions. */
type ProxyResidencyPolicy = PolicyKnobs | null | (() => PolicyKnobs | null | undefined);

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

function rankedProxy(
  ads: readonly routingCatalog.RouteAdvertisementV1[],
  signals?: RankingSignals,
  residencyPolicy?: ProxyResidencyPolicy,
  executorFor: (id: string) => BackendExecutor = (id) => recordingExecutor(id),
): { proxy: ReturnType<typeof createProxy>; acquired: string[] } {
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
    executor: executorFor("default"),
    acquireExecutor: (candidate) => {
      const owner = candidate.advertisement.ownerNodeId;
      acquired.push(owner);
      return executorFor(owner);
    },
    ...(signals !== undefined ? { rankingSignals: signals } : {}),
    ...(residencyPolicy !== undefined ? { residencyPolicy } : {}),
  });
  return { proxy, acquired };
}

async function serveRanked(
  ads: readonly routingCatalog.RouteAdvertisementV1[],
  signals?: RankingSignals,
  residencyPolicy?: ProxyResidencyPolicy,
): Promise<RankedOutcome> {
  const { proxy, acquired } = rankedProxy(ads, signals, residencyPolicy);
  const response = await proxy.handleRequest(chatReq());
  return { status: response.status, acquired };
}

interface RankedRow {
  owner: string;
  switchCostMs: number;
  score: number;
}

interface RankFixture {
  name: string;
  ads: routingCatalog.RouteAdvertisementV1[];
  signals: RankingSignals | undefined;
  owner: string;
  table: RankedRow[];
}

const F1: RankFixture = {
  name: "production outranks candidate",
  ads: [
    rankAd("node-a", 0, { qualification: { stage: "candidate" } }),
    rankAd("node-b", 1, { qualification: { stage: "production" } }),
  ],
  signals: undefined,
  owner: "node-b",
  table: [
    { owner: "node-b", switchCostMs: 0, score: 90_000 },
    { owner: "node-a", switchCostMs: 0, score: 30_000 },
  ],
};

const F2: RankFixture = {
  name: "degraded below unstaged",
  ads: [rankAd("node-a", 0, { qualification: { stage: "degraded" } }), rankAd("node-b", 1)],
  signals: undefined,
  owner: "node-b",
  table: [
    { owner: "node-b", switchCostMs: 0, score: 90_000 },
    { owner: "node-a", switchCostMs: 0, score: 0 },
  ],
};

const F3: RankFixture = {
  name: "default expected-load fallback",
  ads: [
    rankAd("node-a", 0, { qualification: { stage: "production" } }),
    rankAd("node-b", 1, { qualification: { stage: "validated" } }),
  ],
  signals: { resident: new Set(["deploy/node-b/w"]) },
  owner: "node-b",
  table: [
    { owner: "node-b", switchCostMs: 0, score: 60_000 },
    { owner: "node-a", switchCostMs: 60_000, score: 30_000 },
  ],
};

const F4: RankFixture = {
  name: "drain",
  ads: [
    rankAd("node-a", 0, { qualification: { stage: "production" } }),
    rankAd("node-b", 1, { qualification: { stage: "candidate" } }),
  ],
  signals: {
    resident: new Set(["deploy/node-b/w"]),
    expectedLoadMs: () => 0,
    drainMs: (ad) => (ad.ownerNodeId === "node-a" ? 100_000 : undefined),
  },
  owner: "node-b",
  table: [
    { owner: "node-b", switchCostMs: 0, score: 30_000 },
    { owner: "node-a", switchCostMs: 100_000, score: -10_000 },
  ],
};

const F5: RankFixture = {
  name: "cooldown",
  ads: [rankAd("node-a", 0), rankAd("node-b", 1)],
  signals: {
    resident: new Set(["deploy/node-a/w", "deploy/node-b/w"]),
    cooldownUntil: (ad) => (ad.ownerNodeId === "node-a" ? 1_120_000 : undefined),
  },
  owner: "node-b",
  table: [
    { owner: "node-b", switchCostMs: 0, score: 90_000 },
    { owner: "node-a", switchCostMs: 120_000, score: -30_000 },
  ],
};

const F6: RankFixture = {
  name: "equal stage",
  ads: [
    rankAd("node-a", 0, { qualification: { stage: "validated" } }),
    rankAd("node-b", 1, { qualification: { stage: "validated" } }),
  ],
  signals: { expectedLoadMs: () => 1_000 },
  owner: "node-a",
  table: [
    { owner: "node-a", switchCostMs: 0, score: 60_000 },
    { owner: "node-b", switchCostMs: 0, score: 60_000 },
  ],
};

const F7: RankFixture = {
  name: "resident flip fixture",
  ads: [
    rankAd("node-a", 0, { qualification: { stage: "production" } }),
    rankAd("node-b", 1, { qualification: { stage: "validated" } }),
  ],
  signals: {
    resident: new Set(["deploy/node-b/w"]),
    expectedLoadMs: () => 0,
  },
  owner: "node-a",
  table: [
    { owner: "node-a", switchCostMs: 0, score: 90_000 },
    { owner: "node-b", switchCostMs: 0, score: 60_000 },
  ],
};

const FIXTURES: readonly RankFixture[] = [F1, F2, F3, F4, F5, F6, F7];

const PROXY_VARIANTS: readonly (ProxyResidencyPolicy | undefined)[] = [
  undefined,
  {},
  { ...residencyAdmission.DEFAULT_RESIDENCY_POLICY },
  null,
  (): null => null,
  (): undefined => undefined,
  { coldLoadPenaltyMs: -1_000_000 },
  { residentPreference: -5 },
];

const CORE_VARIANTS: readonly (PolicyKnobs | null | undefined)[] = [
  undefined,
  {},
  { ...residencyAdmission.DEFAULT_RESIDENCY_POLICY },
  null,
  { coldLoadPenaltyMs: -1_000_000 },
  { residentPreference: -5 },
  { coldLoadPenaltyMs: Number.NaN, residentPreference: Number.NaN },
  { coldLoadPenaltyMs: Number.POSITIVE_INFINITY },
];

function rankCore(
  ads: readonly routingCatalog.RouteAdvertisementV1[],
  signals: RankingSignals | undefined,
  policy?: PolicyKnobs | null,
): RankedRow[] {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: "local",
    now: NOW,
    advertisements: ads,
  });
  const ranked = routingRanking.rankRouteCandidates(
    routingCatalog.catalogCandidatesFor(cat, MODEL),
    {
      now: NOW,
      ...(signals !== undefined ? { signals } : {}),
      ...(policy !== undefined ? { policy } : {}),
    },
  );
  return ranked.map((entry) => ({
    owner: entry.candidate.advertisement.ownerNodeId,
    switchCostMs: entry.switchCostMs + 0,
    score: entry.score + 0,
  }));
}

describe("unified proxy residency policy ranking knobs (Part of #519)", () => {
  test("coldLoadPenaltyMs charges a non-resident candidate when residency is known", async () => {
    // Kills: not adding the penalty to loadCostMs, or also charging it to
    // the resident candidate (a 50000 vs b 20000, so node-a still wins).
    const { status, acquired } = await serveRanked(F7.ads, F7.signals, {
      coldLoadPenaltyMs: 40_000,
    });
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("a residencyPolicy getter supplies the knobs to ranking", async () => {
    // Kills: ignoring the getter form of residencyPolicy, or treating it as
    // () => null (F7 would stay on node-a).
    const { status, acquired } = await serveRanked(F7.ads, F7.signals, () => ({
      coldLoadPenaltyMs: 40_000,
    }));
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("the residencyPolicy getter is re-read on every request", async () => {
    // Kills: reading the getter once at createProxy time and caching the
    // result (the second request would stay on node-a).
    let policy: PolicyKnobs | null = null;
    const { proxy, acquired } = rankedProxy(F7.ads, F7.signals, () => policy);
    const first = await proxy.handleRequest(chatReq());
    expect(first.status).toBe(200);
    expect(acquired.at(-1)).toBe("node-a");
    policy = { coldLoadPenaltyMs: 40_000 };
    const second = await proxy.handleRequest(chatReq());
    expect(second.status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("residentPreference rewards a resident candidate in quality points", async () => {
    // Kills: dropping the resident bonus, or applying it to every candidate
    // (a 135000 > 105000).
    const { status, acquired } = await serveRanked(F7.ads, F7.signals, {
      residentPreference: 1.5,
    });
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("core ranking carries the penalty in switchCostMs and the bonus in score", () => {
    // Kills: the penalty in score but not in switchCostMs, or the bonus in
    // ms rather than quality points (1.5 instead of 45000).
    expect(
      rankCore(F7.ads, F7.signals, { coldLoadPenaltyMs: 40_000, residentPreference: 1.5 }),
    ).toEqual([
      { owner: "node-b", switchCostMs: 0, score: 105_000 },
      { owner: "node-a", switchCostMs: 40_000, score: 50_000 },
    ]);
  });

  test("the default policy yields the #518 decisions (proxy)", async () => {
    // Kills: ranking merging opts.policy without resolveResidencyPolicy
    // validation. An unvalidated -1_000_000 penalty flips F3 and F4 to
    // node-a, and an unvalidated -5 preference flips F3 and F4 to node-a.
    // Also kills a default large enough to flip F7: DEFAULT
    // coldLoadPenaltyMs > 30000, or residentPreference > 1.
    for (const fixture of FIXTURES) {
      for (const [i, variant] of PROXY_VARIANTS.entries()) {
        const { acquired } = await serveRanked(fixture.ads, fixture.signals, variant);
        expect(acquired.at(-1), `${fixture.name} variant ${String(i)}`).toBe(fixture.owner);
      }
    }
    const { acquired } = await serveRanked(F7.ads, F7.signals, { coldLoadPenaltyMs: 40_000 });
    expect(acquired.at(-1)).toBe("node-b");
  });

  test("the default policy yields the #518 scores (core table)", () => {
    // Kills: ANY nonzero default for either knob, in DEFAULT_RESIDENCY_POLICY
    // or as a fallback inside ranking.ts. Even 1 shifts F3's node-a
    // switchCostMs or node-b's score. Also kills skipped validation: NaN,
    // Infinity or a negative value would appear in switchCostMs or score.
    for (const fixture of FIXTURES) {
      for (const [i, variant] of CORE_VARIANTS.entries()) {
        expect(
          rankCore(fixture.ads, fixture.signals, variant),
          `${fixture.name} variant ${String(i)}`,
        ).toEqual(fixture.table);
      }
    }
    expect(rankCore(F7.ads, F7.signals, { coldLoadPenaltyMs: 40_000 })).toEqual([
      { owner: "node-b", switchCostMs: 0, score: 60_000 },
      { owner: "node-a", switchCostMs: 40_000, score: 50_000 },
    ]);
  });

  test("guard: neither knob applies when residency is unknown", async () => {
    // guard: passes at base. Kills: charging coldLoadPenaltyMs when
    // signals.resident is undefined (switchCostMs 40000), or granting
    // residentPreference without a resident set (scores 240000/210000).
    const policy: PolicyKnobs = { coldLoadPenaltyMs: 40_000, residentPreference: 5 };
    const table: RankedRow[] = [
      { owner: "node-a", switchCostMs: 0, score: 90_000 },
      { owner: "node-b", switchCostMs: 0, score: 60_000 },
    ];
    expect(rankCore(F7.ads, { expectedLoadMs: () => 0 }, policy)).toEqual(table);
    expect(rankCore(F7.ads, undefined, policy)).toEqual(table);
    const { status, acquired } = await serveRanked(F7.ads, { expectedLoadMs: () => 0 }, policy);
    expect(status).toBe(200);
    expect(acquired.at(-1)).toBe("node-a");
  });
});

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

// #518 (c) local-http hint pins: when the unified ranker picks a local
// candidate other than catalog order, gatedExecute records the winner's
// workload on ctx.preferredLocalWorkload so the legacy executor can pass
// it to proxyOpenAI as preferredWorkload. The field does not exist at
// base, so the reads go through a cast and the RED case fails by
// assertion ([undefined] where ["b-host"] is expected).

function localHostRoute(workload: string, port: number, qualificationStage?: string): LocalRoute {
  return {
    workload,
    model: MODEL,
    host: "127.0.0.1",
    port,
    engine: "llamacpp",
    kind: "ModelHost",
    pid: 4242,
    ...(qualificationStage !== undefined ? { qualificationStage } : {}),
  };
}

function preferredCapturingExecutor(id: string, sink: (string | undefined)[]): BackendExecutor {
  return {
    describe: (): BackendExecutorDescription => ({
      id,
      backendKinds: [],
      transports: [],
    }),
    execute: (_envelope, ctx): Promise<Response> => {
      sink.push(
        (ctx as BackendExecutionContext & { preferredLocalWorkload?: string })
          .preferredLocalWorkload,
      );
      return Promise.resolve(Response.json({ ok: true, executor: id }));
    },
    cancel: (): boolean => false,
    drain: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };
}

function localRankedProxy(
  routes: readonly LocalRoute[],
  nodeId: string,
): {
  proxy: ReturnType<typeof createProxy>;
  cat: routingCatalog.RouteCatalog;
  preferred: (string | undefined)[];
} {
  const cat = routingCatalog.buildRouteCatalog({ routes, nodeId, now: NOW });
  const candidates = routingCatalog.catalogCandidatesFor(cat, MODEL);
  expect(candidates).toHaveLength(routes.length);
  expect(candidates.at(0)?.advertisement.deploymentId).toBe(`deploy/${nodeId}/a-host`);
  for (const candidate of candidates) {
    expect(candidate.advertisement.transport).toBe("local-http");
  }
  const resolved = freshResolved();
  expect(openaiProxy.defaultTargetModelIds(resolved).has(MODEL)).toBe(false);
  const preferred: (string | undefined)[] = [];
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    now: () => NOW,
    resolved: () => resolved,
    nodeId,
    peers: [],
    catalog: () => cat,
    executor: preferredCapturingExecutor("local-ranked", preferred),
  });
  return { proxy, cat, preferred };
}

function advertisedRankedProxy(
  ads: readonly routingCatalog.RouteAdvertisementV1[],
  nodeId: string,
): {
  proxy: ReturnType<typeof createProxy>;
  acquired: string[];
  preferred: (string | undefined)[];
} {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId,
    now: NOW,
    advertisements: ads,
  });
  const candidates = routingCatalog.catalogCandidatesFor(cat, MODEL);
  expect(candidates).toHaveLength(2);
  expect(candidates.at(0)?.advertisement.ownerNodeId).toBe("node-a");
  const resolved = freshResolved();
  expect(openaiProxy.defaultTargetModelIds(resolved).has(MODEL)).toBe(false);
  const acquired: string[] = [];
  const preferred: (string | undefined)[] = [];
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    now: () => NOW,
    resolved: () => resolved,
    nodeId,
    peers: [],
    catalog: () => cat,
    executor: preferredCapturingExecutor("default", preferred),
    acquireExecutor: (candidate) => {
      const owner = candidate.advertisement.ownerNodeId;
      acquired.push(owner);
      return preferredCapturingExecutor(owner, preferred);
    },
  });
  return { proxy, acquired, preferred };
}

describe("unified proxy preferredLocalWorkload hint (#518)", () => {
  test("a ranked local-http winner other than catalog order is passed as preferredLocalWorkload", async () => {
    // Kills: gatedExecute not setting the hint — the legacy executor would
    // fall back to alias order and serve a-host. nodeId "mini" also kills
    // hard-coding "local" in workloadOfDeployment.
    const { proxy, preferred } = localRankedProxy(
      [localHostRoute("a-host", 19_101, "validated"), localHostRoute("b-host", 19_102)],
      "mini",
    );
    const res = await proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(preferred).toEqual(["b-host"]);
  });

  test("guard (passes on base): no hint when ranking keeps catalog order", async () => {
    // Kills: always setting the hint, which would break the
    // default-weights-reproduce-today invariant.
    const { proxy, preferred } = localRankedProxy(
      [localHostRoute("a-host", 19_111), localHostRoute("b-host", 19_112)],
      "mini",
    );
    const res = await proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(preferred).toEqual([undefined]);
  });

  test("guard (passes on base): no hint for a worker-rpc winner owned by another node", async () => {
    // Guards the remote-owner case end to end: node-b's worker-rpc winner,
    // picked over catalog order, reaches its executor with
    // preferredLocalWorkload unset. It does not isolate the transport check
    // (node-b is not this node, so the owner check also rejects it) — the
    // owned worker-rpc test below does.
    const preferred: (string | undefined)[] = [];
    const { proxy, acquired } = rankedProxy(
      [
        rankAd("node-a", 0, { qualification: { stage: "candidate" } }),
        rankAd("node-b", 1, { qualification: { stage: "production" } }),
      ],
      undefined,
      undefined,
      (id) => preferredCapturingExecutor(id, preferred),
    );
    const res = await proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
    expect(preferred).toEqual([undefined]);
  });

  test("guard: no hint for a worker-rpc winner owned by this node", async () => {
    // Kills: dropping the transport !== 'local-http' check. The winner is
    // owned by this node and its deploymentId names a workload under this
    // node's prefix, so only the transport check keeps the hint unset.
    const { proxy, acquired, preferred } = advertisedRankedProxy(
      [
        rankAd("node-a", 0, { qualification: { stage: "candidate" } }),
        rankAd("node-b", 1, {
          ownerNodeId: "mini",
          deploymentId: "deploy/mini/b-host",
          routeId: "route/mini/b-host",
          backendId: "backend/mini/b-host",
          transport: "worker-rpc",
          qualification: { stage: "production" },
        }),
      ],
      "mini",
    );
    const res = await proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(acquired.at(-1)).toBe("mini");
    expect(preferred).toEqual([undefined]);
  });

  test("guard: no hint for a local-http winner owned by another node", async () => {
    // Kills: dropping the ownerNodeId !== nodeId check. The winner is
    // local-http and its deploymentId carries this node's prefix, so only
    // the owner check keeps the hint unset.
    const { proxy, acquired, preferred } = advertisedRankedProxy(
      [
        rankAd("node-a", 0, { qualification: { stage: "candidate" } }),
        rankAd("node-b", 1, {
          deploymentId: "deploy/mini/b-host",
          routeId: "route/mini/b-host",
          backendId: "backend/mini/b-host",
          transport: "local-http",
          qualification: { stage: "production" },
        }),
      ],
      "mini",
    );
    const res = await proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(acquired.at(-1)).toBe("node-b");
    expect(preferred).toEqual([undefined]);
  });

  test("guard: a local-http winner owned by this node gets the hint via advertisements", async () => {
    // Positive control for the two guards above: with both the transport
    // and the owner matching, the same advertisement shape does carry the
    // hint, so their [undefined] is not an artifact of the fixture.
    const { proxy, acquired, preferred } = advertisedRankedProxy(
      [
        rankAd("node-a", 0, { qualification: { stage: "candidate" } }),
        rankAd("node-b", 1, {
          ownerNodeId: "mini",
          deploymentId: "deploy/mini/b-host",
          routeId: "route/mini/b-host",
          backendId: "backend/mini/b-host",
          transport: "local-http",
          qualification: { stage: "production" },
        }),
      ],
      "mini",
    );
    const res = await proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(acquired.at(-1)).toBe("mini");
    expect(preferred).toEqual(["b-host"]);
  });

  test("guard (passes on base): single eligible local candidate gets no hint", async () => {
    // Kills: setting the hint even when the ranked pick is the only
    // candidate — there is nothing to prefer.
    const { proxy, preferred } = localRankedProxy([localHostRoute("a-host", 19_121)], "mini");
    const res = await proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(preferred).toEqual([undefined]);
  });
});
