/**
 * Part of #519: peers have unknown residency in unified ranking.
 * residencyRankingInputs emits a residencyKnown signal scoped to this
 * node — true for local candidates, false for peers — and
 * rankRouteCandidates consults it so coldLoadPenaltyMs, the default
 * expected-load cost, drainMs and residentPreference never charge or
 * reward a candidate whose residency this node cannot see. A caller
 * that passes `resident` without `residencyKnown` keeps the old
 * behaviour. Neither the signal nor its consumption exists at the
 * pinned base, so the cases below fail by assertion — never by a link
 * or type error — and hold once the wiring lands; the guards pin the
 * absent-signal behaviour that must not change.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog, routingRanking } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../../src/residency/store.js";

import {
  type BackendExecutor,
  type BackendExecutorDescription,
  createSharedUnifiedProxy,
  type UnifiedProxy,
  type UnifiedProxyOptions,
} from "../../src/proxy/create-proxy.js";
import { residencyRankingInputs } from "../../src/proxy/residency-ranking.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import {
  type NodeRun,
  type NodeRunResidency,
  NodeRunSchema,
} from "../../src/workload/noderun-schema.js";

const MODEL = "rank/model";
const NOW = 1_000_000;
const STORE_PATH = "/residency/operations.sqlite";

/** RankingSignals plus the residencyKnown signal the #519 fix adds;
 *  declared locally so the base typechecks. */
type PeerAwareSignals = routingRanking.RankingSignals & {
  residencyKnown?: (ad: routingCatalog.RouteAdvertisementV1) => boolean;
};

type AdOverrides = Partial<routingCatalog.RouteAdvertisementV1>;

/** Shape of the createSharedUnifiedProxy export: the UnifiedProxyOptions
 *  surface plus the residency inputs' injected deps. */
type SharedUnifiedProxyOptions = UnifiedProxyOptions & {
  listNodeRuns?: () => NodeRun[];
  readStore?: () => ResidencyStoreSnapshot;
  residencyTtlMs?: number;
};

type SharedUnifiedProxyFactory = (opts?: SharedUnifiedProxyOptions) => UnifiedProxy;

let sandbox: string | undefined;

function fx(): string {
  if (sandbox === undefined) throw new Error("ranking-peer-residency fixture not started");
  return sandbox;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-ranking-peer-residency-"));
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

/** The peer advertisement: owned by peer-a, validated stage (2 pts). */
function peer(): routingCatalog.RouteAdvertisementV1 {
  return wiringAd("p1", 1, {
    routeId: "route/peer-a/p1",
    deploymentId: "deploy/peer-a/p1",
    backendId: "backend/peer-a/p1",
    ownerNodeId: "peer-a",
    qualification: { stage: "validated" },
  });
}

/** The same peer ad without a qualification stage (unstaged, 3 pts). */
function peerUnstaged(): routingCatalog.RouteAdvertisementV1 {
  return wiringAd("p1", 1, {
    routeId: "route/peer-a/p1",
    deploymentId: "deploy/peer-a/p1",
    backendId: "backend/peer-a/p1",
    ownerNodeId: "peer-a",
  });
}

/** This node's residency is known for its own ads and unknown for peers. */
const localOnly = (ad: routingCatalog.RouteAdvertisementV1): boolean => ad.ownerNodeId === "local";

function chatReq(): Request {
  return new Request("http://agent.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  });
}

function recordingExecutor(id: string): BackendExecutor {
  return {
    describe: (): BackendExecutorDescription => ({
      id,
      backendKinds: [],
      transports: [],
    }),
    execute: (): Promise<Response> => Promise.resolve(Response.json({ ok: true, executor: id })),
    cancel: (): boolean => false,
    drain: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };
}

function lifecycleRow(model: string, state: ResidencyStateRecord["state"]): ResidencyStateRecord {
  return {
    model,
    group: null,
    state,
    ownerId: "owner",
    incarnation: "inc-1",
    fenceToken: 1,
    version: 1,
    updatedAtMs: NOW,
  };
}

function storeWith(lifecycle: ResidencyStateRecord[]): ResidencyStoreSnapshot {
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

/** The two-ad catalog K1-K3 rank and sharedRig defaults to: local w1
 *  listed first, then the unstaged peer — catalog order alone would
 *  keep w1 ahead. */
function peerCatalog(): routingCatalog.RouteCatalog {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: "local",
    now: NOW,
    advertisements: [wiringAd("w1", 0), peerUnstaged()],
  });
  expect(routingCatalog.catalogCandidatesFor(cat, MODEL)).toHaveLength(2);
  return cat;
}

function peerCandidates(): routingCatalog.RouteCandidate[] {
  return routingCatalog.catalogCandidatesFor(peerCatalog(), MODEL);
}

function rankedRow(
  ranked: readonly routingRanking.RankedCandidate[],
  deploymentId: string,
): routingRanking.RankedCandidate | undefined {
  return ranked.find((row) => row.candidate.advertisement.deploymentId === deploymentId);
}

interface SharedRig {
  proxy: UnifiedProxy;
  picked: string[];
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
  const cat = input.catalog ?? peerCatalog();
  const resolved = freshResolved();
  expect(openaiProxy.defaultTargetModelIds(resolved).has(MODEL)).toBe(false);
  const picked: string[] = [];
  const proxy = create({
    env: input.env,
    resolved: () => resolved,
    peers: [],
    catalog: () => cat,
    acquireExecutor: (candidate) => {
      picked.push(candidate.advertisement.deploymentId);
      return recordingExecutor(candidate.advertisement.deploymentId);
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
  return { proxy, picked };
}

describe("#519 peers have unknown residency in unified ranking", () => {
  test("a peer outside residencyKnown pays no cold-load cost", () => {
    // Kills: loadCostMs ignoring residencyKnown — the peer would pay the
    // 60000 default load + 120000 coldLoadPenaltyMs = 180000 like w1.
    const cands = peerCandidates();
    const signals: PeerAwareSignals = {
      resident: new Set(["deploy/local/w9"]),
      residencyKnown: localOnly,
    };
    const ranked = routingRanking.rankRouteCandidates(cands, {
      now: NOW,
      policy: { coldLoadPenaltyMs: 120_000 },
      signals,
    });
    const peerRow = rankedRow(ranked, "deploy/peer-a/p1");
    const w1Row = rankedRow(ranked, "deploy/local/w1");
    expect(peerRow?.switchCostMs).toBe(0);
    expect(peerRow?.score).toBe(90_000);
    expect(w1Row?.switchCostMs).toBe(180_000);
  });

  test("a peer outside residencyKnown pays no drain cost", () => {
    // Kills: drainCostMs ignoring residencyKnown — the peer would pay the
    // 45000 drainMs like w1.
    const cands = peerCandidates();
    const signals: PeerAwareSignals = {
      resident: new Set<string>(),
      residencyKnown: localOnly,
      drainMs: () => 45_000,
      expectedLoadMs: () => 0,
    };
    const ranked = routingRanking.rankRouteCandidates(cands, {
      now: NOW,
      policy: {},
      signals,
    });
    const peerRow = rankedRow(ranked, "deploy/peer-a/p1");
    const w1Row = rankedRow(ranked, "deploy/local/w1");
    expect(peerRow?.switchCostMs).toBe(0);
    expect(w1Row?.switchCostMs).toBe(45_000);
  });

  test("residentPreference never rewards a candidate outside residencyKnown", () => {
    // Kills: residentBonus ignoring residencyKnown — the peer would
    // collect the 2 * 30000 = 60000 bonus and score 150000 like w1.
    const cands = peerCandidates();
    const signals: PeerAwareSignals = {
      resident: new Set(["deploy/peer-a/p1", "deploy/local/w1"]),
      residencyKnown: localOnly,
    };
    const ranked = routingRanking.rankRouteCandidates(cands, {
      now: NOW,
      policy: { residentPreference: 2 },
      signals,
    });
    const peerRow = rankedRow(ranked, "deploy/peer-a/p1");
    const w1Row = rankedRow(ranked, "deploy/local/w1");
    expect(peerRow?.score).toBe(90_000);
    expect(w1Row?.score).toBe(150_000);
  });

  test("without residencyKnown the resident set speaks for every candidate", () => {
    // Kills: defaulting an absent residencyKnown to false — both
    // candidates must keep paying the 180000 non-resident cost exactly
    // as the #519 base does.
    const cands = peerCandidates();
    const signals: PeerAwareSignals = {
      resident: new Set(["deploy/local/w9"]),
    };
    const ranked = routingRanking.rankRouteCandidates(cands, {
      now: NOW,
      policy: { coldLoadPenaltyMs: 120_000 },
      signals,
    });
    const peerRow = rankedRow(ranked, "deploy/peer-a/p1");
    const w1Row = rankedRow(ranked, "deploy/local/w1");
    expect(peerRow?.switchCostMs).toBe(180_000);
    expect(w1Row?.switchCostMs).toBe(180_000);
  });

  test("residencyRankingInputs scopes residencyKnown to this node", () => {
    // Kills: not emitting the key, emitting () => true, or keying on
    // ready-set membership instead of ownerNodeId — w1 has no ready row
    // yet must still report true.
    const signals = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 120_000 },
      store: storeWith([lifecycleRow("w2", "ready")]),
      nodeId: "local",
      nodeName: "n1",
    }).signals as PeerAwareSignals;
    expect(typeof signals.residencyKnown).toBe("function");
    const residencyKnown = signals.residencyKnown;
    if (residencyKnown === undefined) return;
    expect(residencyKnown(wiringAd("w1", 0))).toBe(true);
    expect(residencyKnown(wiringAd("w2", 0))).toBe(true);
    expect(residencyKnown(peer())).toBe(false);
  });

  test("residencyKnown is emitted only together with the resident set", () => {
    // Kills: emitting residencyKnown without the resident set — a
    // cooldown-only or knob-free NodeRun must keep signals exactly {}.
    const cooldownOnly = residencyRankingInputs({
      residency: { switchCooldownSeconds: 300 },
      store: storeWith([lifecycleRow("w2", "ready")]),
      nodeId: "local",
      nodeName: "n1",
    }).signals as PeerAwareSignals;
    expect("residencyKnown" in cooldownOnly).toBe(false);
    expect("resident" in cooldownOnly).toBe(false);
    const knobFree = residencyRankingInputs({
      residency: {},
      store: storeWith([lifecycleRow("w2", "ready")]),
      nodeId: "local",
      nodeName: "n1",
    }).signals as PeerAwareSignals;
    expect(knobFree).toEqual({});
  });

  test("createSharedUnifiedProxy prefers a live validated peer over a cold local candidate", async () => {
    // Kills: residency-ranking not wiring residencyKnown into the shared
    // proxy. Math: w2 = 90000 - 180000 = -90000 and peer = 60000 - 180000
    // = -120000, so the base picks w2; fixed, the peer's unknown residency
    // costs nothing and its 60000 wins.
    const cat = routingCatalog.buildRouteCatalog({
      routes: [],
      nodeId: "local",
      now: NOW,
      advertisements: [wiringAd("w2", 0), peer()],
    });
    expect(routingCatalog.catalogCandidatesFor(cat, MODEL)).toHaveLength(2);
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { coldLoadPenaltyMs: 120_000 })],
      store: storeWith([lifecycleRow("w9", "ready")]),
      catalog: cat,
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/peer-a/p1"]);
  });

  test("DELIBERATE BEHAVIOUR CHANGE: a peer outranks a local candidate with no ready row once a ranking knob is set", async () => {
    // Kills: silently reverting the documented peer-vs-no-row inversion.
    // Pinned trade-off, not a mutation kill: the peer's unknown residency
    // is free while the local candidate with no ready row pays the
    // 60000 default load. Math on the base: both pay 60000, so 30000 vs
    // 30000 and the index tie-break picks w1; fixed: peer 90000 vs w1
    // 30000.
    const cat = routingCatalog.buildRouteCatalog({
      routes: [],
      nodeId: "local",
      now: NOW,
      advertisements: [wiringAd("w1", 0), peerUnstaged()],
    });
    expect(routingCatalog.catalogCandidatesFor(cat, MODEL)).toHaveLength(2);
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { residentPreference: 1 })],
      store: storeWith([]),
      catalog: cat,
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/peer-a/p1"]);
  });
});
