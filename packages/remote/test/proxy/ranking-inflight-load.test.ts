/**
 * #518 — in-flight load credit in unified candidate ranking.
 * residencyRankingInputs maps node-local residency_states lifecycle rows
 * to the ranker's expectedLoadMs signal — a local candidate whose row is
 * `loading` or `warming` is charged only the remaining expected load
 * (DEFAULT_RANKING_WEIGHTS.defaultExpectedLoadMs minus the elapsed time
 * since the row's updatedAtMs, capped at the default and absent once
 * elapsed reaches it), emitted only alongside the resident set, with the
 * clock read at rank time; createSharedUnifiedProxy must feed it into
 * rankRouteCandidates through the residency source's injected now.
 * Neither behaviour exists at the pinned base, so every case fails by
 * assertion — never by a link or type error — and holds once the wiring
 * lands: the credit follows the loading/warming states and the
 * ownerNodeId check, future rows cap at the default, overdue rows keep
 * it, and the pick reorders.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog, routingRanking } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../../src/residency/store.js";

import * as proxyMod from "../../src/proxy/create-proxy.js";
import * as residencyMod from "../../src/proxy/residency-ranking.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import {
  type NodeRun,
  type NodeRunResidency,
  NodeRunSchema,
} from "../../src/workload/noderun-schema.js";

const MODEL = "rank/model";
const NODE = "local";
const NOW = 1_000_000;
const STORE_PATH = "/residency/operations.sqlite";
const D = routingRanking.DEFAULT_RANKING_WEIGHTS.defaultExpectedLoadMs;

/** The residencyRankingInputs input shape this slice reads: the same
 *  residency/store/nodeId/nodeName surface the drain slice uses, plus the
 *  rank-time clock the fix adds. */
interface InflightRankingInput {
  residency: NodeRunResidency | null | undefined;
  store: ResidencyStoreSnapshot;
  nodeId: string;
  nodeName?: string;
  now?: () => number;
}

interface InflightRankingResult {
  policy: NodeRunResidency | null;
  signals: routingRanking.RankingSignals;
}

type InflightRankingInputsFn = (input: InflightRankingInput) => InflightRankingResult;

/** Local shape of createResidencyRankingSource: the cached policy/signals
 *  reader the fix extends with the rank-time clock. */
interface InflightRankingSource {
  signals(): routingRanking.RankingSignals;
}

interface InflightSourceInput {
  env: NodeJS.ProcessEnv;
  nodeId: string;
  listNodeRuns?: () => NodeRun[];
  readStore?: () => ResidencyStoreSnapshot;
  now?: () => number;
  ttlMs?: number;
}

type InflightSourceFactory = (input: InflightSourceInput) => InflightRankingSource;

/** Shape of the createSharedUnifiedProxy export: the UnifiedProxyOptions
 *  surface plus the residency inputs' injected deps. */
type SharedUnifiedProxyOptions = proxyMod.UnifiedProxyOptions & {
  listNodeRuns?: () => NodeRun[];
  readStore?: () => ResidencyStoreSnapshot;
  residencyTtlMs?: number;
};

type SharedUnifiedProxyFactory = (opts?: SharedUnifiedProxyOptions) => proxyMod.UnifiedProxy;

type AdOverrides = Partial<routingCatalog.RouteAdvertisementV1>;

function exported(name: string): unknown {
  return (proxyMod as Record<string, unknown>)[name];
}

function rankingInputsFn(): InflightRankingInputsFn | undefined {
  return exported("residencyRankingInputs") as InflightRankingInputsFn | undefined;
}

function sharedProxyFn(): SharedUnifiedProxyFactory | undefined {
  return exported("createSharedUnifiedProxy") as SharedUnifiedProxyFactory | undefined;
}

function sourceFn(): InflightSourceFactory | undefined {
  return (residencyMod as Record<string, unknown>)["createResidencyRankingSource"] as
    | InflightSourceFactory
    | undefined;
}

let sandbox: string | undefined;

function fx(): string {
  if (sandbox === undefined) throw new Error("ranking-inflight-load fixture not started");
  return sandbox;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-ranking-inflight-"));
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

function wiringAd(
  workload: string,
  priority: number,
  over: AdOverrides = {},
): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/local/${workload}`,
    deploymentId: `deploy/local/${workload}`,
    backendId: `backend/local/${workload}`,
    ownerNodeId: NODE,
    publicModelIds: [MODEL],
    upstreamModelId: MODEL,
    backendKind: "local-model",
    transport: "local-http",
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

function recordingExecutor(
  id: string,
  preferred?: (string | undefined)[],
): proxyMod.BackendExecutor {
  return {
    describe: (): proxyMod.BackendExecutorDescription => ({
      id,
      backendKinds: [],
      transports: [],
    }),
    execute: (_envelope, ctx): Promise<Response> => {
      preferred?.push(ctx.preferredLocalWorkload);
      return Promise.resolve(Response.json({ ok: true, executor: id }));
    },
    cancel: (): boolean => false,
    drain: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };
}

function lifecycleRow(
  model: string,
  state: ResidencyStateRecord["state"],
  group: string | null = null,
  updatedAtMs: number = NOW,
): ResidencyStateRecord {
  return {
    model,
    group,
    state,
    ownerId: "owner",
    incarnation: "inc-1",
    fenceToken: 1,
    version: 1,
    updatedAtMs,
  };
}

/** A readable store snapshot carrying lifecycle rows and no recorded
 *  switch times, so neither the resident set nor the cooldown applies. */
function opsStore(lifecycle: ResidencyStateRecord[]): ResidencyStoreSnapshot {
  return {
    path: STORE_PATH,
    present: true,
    nonterminal: [],
    lastSucceededAtMs: {},
    lifecycle,
  };
}

function nodeRun(name: string, residency?: NodeRunResidency, specNode = name): NodeRun {
  return NodeRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name },
    spec: {
      node: specNode,
      ...(residency === undefined ? {} : { residency }),
      infra: [],
    },
  });
}

/** The two-replica local-http catalog the proxy case ranks: w-a listed
 *  first with a `downloaded` row, w-b second mid-`loading` — both unstaged
 *  (production, 3 pts), so catalog order alone keeps w-a ahead until the
 *  remaining-load credit lands. */
function replicaCatalog(): routingCatalog.RouteCatalog {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: NODE,
    now: NOW,
    advertisements: [wiringAd("w-a", 0), wiringAd("w-b", 1)],
  });
  expect(routingCatalog.catalogCandidatesFor(cat, MODEL)).toHaveLength(2);
  return cat;
}

interface SharedRig {
  proxy: proxyMod.UnifiedProxy;
  picked: string[];
  preferred: (string | undefined)[];
}

interface RigReads {
  listNodeRuns: number;
  readStore: number;
}

function sharedRig(
  create: SharedUnifiedProxyFactory,
  input: {
    env: NodeJS.ProcessEnv;
    nodeRuns: NodeRun[];
    store: ResidencyStoreSnapshot;
    catalog?: routingCatalog.RouteCatalog;
    now?: () => number;
    reads?: RigReads;
    throwOn?: keyof RigReads;
    extra?: Partial<SharedUnifiedProxyOptions>;
  },
): SharedRig {
  const cat = input.catalog ?? replicaCatalog();
  const resolved = freshResolved();
  expect(openaiProxy.defaultTargetModelIds(resolved).has(MODEL)).toBe(false);
  const picked: string[] = [];
  const preferred: (string | undefined)[] = [];
  const proxy = create({
    env: input.env,
    resolved: () => resolved,
    peers: [],
    catalog: () => cat,
    acquireExecutor: (candidate) => {
      picked.push(candidate.advertisement.deploymentId);
      return recordingExecutor(candidate.advertisement.deploymentId, preferred);
    },
    listNodeRuns: () => {
      if (input.reads !== undefined) input.reads.listNodeRuns += 1;
      if (input.throwOn === "listNodeRuns") throw new Error("noderun read failed");
      return input.nodeRuns;
    },
    readStore: () => {
      if (input.reads !== undefined) input.reads.readStore += 1;
      if (input.throwOn === "readStore") throw new Error("store read failed");
      return input.store;
    },
    now: input.now ?? ((): number => NOW),
    ...input.extra,
  });
  return { proxy, picked, preferred };
}

describe("#518 in-flight load credit in unified ranking", () => {
  test("credits a local in-flight row only its remaining expected load", () => {
    // Kills: dropping the expectedLoadMs key from signals; charging the
    // full default without subtracting elapsed.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const { signals } = residencyRankingInputs({
      residency: { residentPreference: 1 },
      nodeId: NODE,
      now: () => NOW,
      store: opsStore([
        lifecycleRow("w-load", "loading", null, NOW - 45_000),
        lifecycleRow("w-warm", "warming", null, NOW - 10_000),
      ]),
    });
    const expectedLoadMs = signals.expectedLoadMs;
    expect(typeof expectedLoadMs).toBe("function");
    if (expectedLoadMs === undefined) return;
    expect(expectedLoadMs(wiringAd("w-load", 0))).toBe(D - 45_000);
    expect(expectedLoadMs(wiringAd("w-warm", 0))).toBe(D - 10_000);
  });

  test("bounds the credit: a future row caps at the default, overdue and fully-elapsed rows keep it", () => {
    // Kills: crediting overdue rows as zero (Math.max(0, D - elapsed));
    // treating elapsed > D instead of >= D as the cutoff; no upper cap
    // for future updatedAtMs (a future row must report exactly D).
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const { signals } = residencyRankingInputs({
      residency: { residentPreference: 1 },
      nodeId: NODE,
      now: () => NOW,
      store: opsStore([
        lifecycleRow("w-future", "loading", null, NOW + 5_000),
        lifecycleRow("w-overdue", "loading", null, NOW - 120_000),
        lifecycleRow("w-edge", "loading", null, NOW - D),
      ]),
    });
    const expectedLoadMs = signals.expectedLoadMs;
    expect(typeof expectedLoadMs).toBe("function");
    if (expectedLoadMs === undefined) return;
    expect(expectedLoadMs(wiringAd("w-future", 0))).toBe(D);
    expect(expectedLoadMs(wiringAd("w-overdue", 0))).toBeUndefined();
    expect(expectedLoadMs(wiringAd("w-edge", 0))).toBeUndefined();
  });

  test("credits only this node's loading or warming rows", () => {
    // Kills: crediting non-in-flight states; dropping the ownerNodeId
    // check so a peer ad whose deploymentId collides with a credited
    // local id is charged the remainder.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const { signals } = residencyRankingInputs({
      residency: { residentPreference: 1 },
      nodeId: NODE,
      now: () => NOW,
      store: opsStore([
        lifecycleRow("w-load", "loading", null, NOW - 1_000),
        lifecycleRow("w-dl", "downloaded"),
        lifecycleRow("w-un", "unavailable"),
        lifecycleRow("w-rd", "ready"),
        lifecycleRow("w-dr", "draining"),
        lifecycleRow("w-ul", "unloading"),
        lifecycleRow("w-fl", "failed"),
      ]),
    });
    const expectedLoadMs = signals.expectedLoadMs;
    expect(typeof expectedLoadMs).toBe("function");
    if (expectedLoadMs === undefined) return;
    expect(expectedLoadMs(wiringAd("w-load", 0))).toBe(D - 1_000);
    for (const model of ["w-dl", "w-un", "w-rd", "w-dr", "w-ul", "w-fl"]) {
      expect(expectedLoadMs(wiringAd(model, 0)), model).toBeUndefined();
    }
    const peer = wiringAd("w-load", 0, { ownerNodeId: "node-b" });
    expect(peer.deploymentId).toBe("deploy/local/w-load");
    expect(expectedLoadMs(peer)).toBeUndefined();
  });

  test("emits the credit only alongside the resident set", () => {
    // Kills: emitting expectedLoadMs without the resident set — a
    // cooldown-only NodeRun must keep the key absent.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const store = opsStore([lifecycleRow("w-load", "loading", null, NOW - 10_000)]);

    const { signals: cooldownOnly } = residencyRankingInputs({
      residency: { switchCooldownSeconds: 60 },
      nodeId: NODE,
      now: () => NOW,
      store,
    });
    expect("expectedLoadMs" in cooldownOnly).toBe(false);

    const { signals } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: NODE,
      now: () => NOW,
      store,
    });
    const expectedLoadMs = signals.expectedLoadMs;
    expect(typeof expectedLoadMs).toBe("function");
    if (expectedLoadMs === undefined) return;
    expect(expectedLoadMs(wiringAd("w-load", 0))).toBe(D - 10_000);
  });

  test("reads the clock at rank time, not when the snapshot is built", () => {
    // Kills: computing the remaining load once when the snapshot is
    // built — the cached signals would keep reporting the first value.
    const createSource = sourceFn();
    expect(typeof createSource).toBe("function");
    if (createSource === undefined) return;
    const T0 = 500_000;
    const ad = wiringAd("w-load", 0);
    let now = T0 + 10_000;
    const reads = { readStore: 0 };
    const source = createSource({
      env: { LLAMACTL_NODE_NAME: "node-run-a" },
      nodeId: NODE,
      listNodeRuns: () => [nodeRun("node-run-a", { residentPreference: 1 })],
      readStore: () => {
        reads.readStore += 1;
        return opsStore([lifecycleRow("w-load", "loading", null, T0)]);
      },
      now: () => now,
      ttlMs: 60_000,
    });
    const first = source.signals().expectedLoadMs;
    expect(typeof first).toBe("function");
    if (first === undefined) return;
    expect(first(ad)).toBe(D - 10_000);

    now = T0 + 30_000;
    const second = source.signals().expectedLoadMs;
    expect(reads.readStore).toBe(1);
    expect(typeof second).toBe("function");
    if (second === undefined) return;
    expect(second(ad)).toBe(D - 30_000);
  });

  test("createSharedUnifiedProxy prefers a mid-load replica over its downloaded twin, then yields once the load is overdue", async () => {
    // Kills: residency-ranking not forwarding the source clock or not
    // emitting expectedLoadMs — scenario 1 would charge both replicas
    // the full default and catalog order would keep w-a; overdue rows
    // credited as zero instead of keeping the default — scenario 2
    // would keep charging w-b nothing and w-b would still win.
    const createSharedUnifiedProxy = sharedProxyFn();
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const catalog = replicaCatalog();

    const loading = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { residentPreference: 1 })],
      store: opsStore([
        lifecycleRow("w-a", "downloaded"),
        lifecycleRow("w-b", "loading", null, NOW - 50_000),
      ]),
      catalog,
      extra: { nodeId: NODE },
    });
    const first = await loading.proxy.handleRequest(chatReq());
    expect(first.status).toBe(200);
    expect(loading.picked).toEqual(["deploy/local/w-b"]);
    expect(loading.preferred).toEqual(["w-b"]);

    const overdue = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { residentPreference: 1 })],
      store: opsStore([
        lifecycleRow("w-a", "downloaded"),
        lifecycleRow("w-b", "loading", null, NOW - 120_000),
      ]),
      catalog,
      extra: { nodeId: NODE },
    });
    const second = await overdue.proxy.handleRequest(chatReq());
    expect(second.status).toBe(200);
    expect(overdue.picked).toEqual(["deploy/local/w-a"]);
    expect(overdue.preferred).toEqual([undefined]);
  });
});
