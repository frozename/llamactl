/**
 * #518 — exclusive-group drain in unified candidate ranking.
 * residencyRankingInputs maps node-local residency_states lifecycle rows
 * to the ranker's drainMs signal — a local candidate without a `ready`
 * row whose declared-exclusive residency group is held by another member
 * in an occupying state is charged DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs
 * — emitted only alongside the resident set, and createSharedUnifiedProxy
 * must feed it into rankRouteCandidates. Neither behaviour exists at the
 * pinned base, so every case fails by assertion — never by a link or type
 * error — and holds once the wiring lands: the charge follows
 * isOccupyingResidencyState and RESIDENCY_GROUPS, stays absent on unknown
 * inputs, and reorders the pick.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { RESIDENCY_GROUPS } from "@llamactl/core/residency/lifecycle";
import { DEFAULT_PROFILE_SWITCH_TIMEOUTS } from "@llamactl/core/residency/planner";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../../src/residency/store.js";

import * as proxyMod from "../../src/proxy/create-proxy.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import {
  type NodeRun,
  type NodeRunResidency,
  NodeRunSchema,
} from "../../src/workload/noderun-schema.js";

const MODEL = "rank/model";
const NOW = 1_000_000;
const STORE_PATH = "/residency/operations.sqlite";
const GROUP = "z13-large-gpu";

/** Local shape of the drainMs signal the fix adds to RankingSignals;
 *  declared here so the base typechecks. */
interface DrainSignals {
  drainMs?: (ad: routingCatalog.RouteAdvertisementV1) => number | undefined;
}

/** The residencyRankingInputs input shape this slice reads: the same
 *  residency/store/nodeId/nodeName surface the operational slice uses. */
interface DrainRankingInput {
  residency: NodeRunResidency | null | undefined;
  store: ResidencyStoreSnapshot;
  nodeId: string;
  nodeName?: string;
}

interface DrainRankingResult {
  policy: NodeRunResidency | null;
  signals: DrainSignals;
}

type DrainRankingInputsFn = (input: DrainRankingInput) => DrainRankingResult;

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

function rankingInputsFn(): DrainRankingInputsFn | undefined {
  return exported("residencyRankingInputs") as DrainRankingInputsFn | undefined;
}

function sharedProxyFn(): SharedUnifiedProxyFactory | undefined {
  return exported("createSharedUnifiedProxy") as SharedUnifiedProxyFactory | undefined;
}

let sandbox: string | undefined;

function fx(): string {
  if (sandbox === undefined) throw new Error("ranking-exclusive-drain fixture not started");
  return sandbox;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-ranking-drain-"));
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

function chatReq(): Request {
  return new Request("http://agent.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  });
}

function recordingExecutor(id: string): proxyMod.BackendExecutor {
  return {
    describe: (): proxyMod.BackendExecutorDescription => ({
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

function lifecycleRow(
  model: string,
  state: ResidencyStateRecord["state"],
  group: string | null = null,
): ResidencyStateRecord {
  return {
    model,
    group,
    state,
    ownerId: "owner",
    incarnation: "inc-1",
    fenceToken: 1,
    version: 1,
    updatedAtMs: NOW,
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

/** The two-ad catalog the proxy cases rank: w1 listed first, unstaged
 *  (production, 3 pts); w2 staged candidate (1 pt). */
function wiringCatalog(): routingCatalog.RouteCatalog {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: "local",
    now: NOW,
    advertisements: [
      wiringAd("w1", 0),
      wiringAd("w2", 1, { qualification: { stage: "candidate" } }),
    ],
  });
  expect(routingCatalog.catalogCandidatesFor(cat, MODEL)).toHaveLength(2);
  return cat;
}

/** The two-ad catalog with both candidates unstaged, so catalog order is
 *  the only thing separating them until the drain charge lands. */
function unstagedCatalog(): routingCatalog.RouteCatalog {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: "local",
    now: NOW,
    advertisements: [wiringAd("w1", 0), wiringAd("w2", 1)],
  });
  expect(routingCatalog.catalogCandidatesFor(cat, MODEL)).toHaveLength(2);
  return cat;
}

interface SharedRig {
  proxy: proxyMod.UnifiedProxy;
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
  const cat = input.catalog ?? wiringCatalog();
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

describe("#518 exclusive-group drain in unified ranking", () => {
  test("charges the drain budget to a cold local member of an occupied exclusive group", () => {
    // Kills: no drainMs producer; charging ungrouped rows.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const { signals } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-big", "ready", GROUP),
        lifecycleRow("w1", "downloaded", GROUP),
        lifecycleRow("w2", "downloaded"),
        lifecycleRow("w3", "failed", GROUP),
      ]),
    });
    const drainMs = signals.drainMs;
    expect(typeof drainMs).toBe("function");
    if (drainMs === undefined) return;
    expect(drainMs(wiringAd("w1", 0))).toBe(DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs);
    expect(drainMs(wiringAd("w3", 0))).toBe(DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs);
    expect(drainMs(wiringAd("w-big", 0))).toBeUndefined();
    expect(drainMs(wiringAd("w2", 0))).toBeUndefined();
    expect(
      drainMs(wiringAd("w1", 0, { ownerNodeId: "peer-a", deploymentId: "deploy/peer-a/w1" })),
    ).toBeUndefined();
  });

  test("a ready member is never charged even when another member occupies its group", () => {
    // Kills: charging the resident occupant (dropping the ready-set skip in
    // chargedDeploymentIds) — w-ready is held by the loading w-load and is
    // charged unless ready rows are skipped.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const { signals } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-ready", "ready", GROUP),
        lifecycleRow("w-load", "loading", GROUP),
        lifecycleRow("w-warm", "warming", GROUP),
      ]),
    });
    const drainMs = signals.drainMs;
    expect(typeof drainMs).toBe("function");
    if (drainMs === undefined) return;
    expect(drainMs(wiringAd("w-load", 0))).toBe(DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs);
    expect(drainMs(wiringAd("w-warm", 0))).toBe(DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs);
    expect(drainMs(wiringAd("w-ready", 0))).toBeUndefined();
  });

  test("a peer ad whose deploymentId collides with a charged local id is not charged", () => {
    // Kills: skipping the ownerNodeId check in the drainMs callback — the
    // peer ad carries the charged local id deploy/local/w1.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const { signals } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-big", "ready", GROUP),
        lifecycleRow("w1", "downloaded", GROUP),
      ]),
    });
    const drainMs = signals.drainMs;
    expect(typeof drainMs).toBe("function");
    if (drainMs === undefined) return;
    expect(drainMs(wiringAd("w1", 0))).toBe(DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs);
    const peer = wiringAd("w1", 0, { ownerNodeId: "peer-a" });
    expect(peer.deploymentId).toBe("deploy/local/w1");
    expect(drainMs(peer)).toBeUndefined();
  });

  test("the only occupant of its group is never charged for holding it", () => {
    // Kills: heldByOtherMember counting the candidate itself (replacing
    // `if (occupant !== model) return true;` with `return true`) — a lone
    // loading w1 would be charged a drain against itself.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const { signals } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([lifecycleRow("w1", "loading", GROUP)]),
    });
    expect(signals.drainMs?.(wiringAd("w1", 0))).toBeUndefined();
    expect("drainMs" in signals).toBe(false);
  });

  test("occupancy follows isOccupyingResidencyState and exclusivity follows RESIDENCY_GROUPS", () => {
    // Kills: treating any non-downloaded state as occupying; counting
    // groups undeclared in RESIDENCY_GROUPS; emitting the key when nothing
    // is charged, which would break the toEqual({}) pins in
    // residency-ranking-wiring.test.ts:293.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);

    const { signals: loading } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-big", "loading", GROUP),
        lifecycleRow("w1", "downloaded", GROUP),
      ]),
    });
    const drainMs = loading.drainMs;
    expect(typeof drainMs).toBe("function");
    if (drainMs === undefined) return;
    expect(drainMs(wiringAd("w1", 0))).toBe(DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs);

    const { signals: draining } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-big", "draining", GROUP),
        lifecycleRow("w1", "downloaded", GROUP),
      ]),
    });
    expect("drainMs" in draining).toBe(false);

    const { signals: undeclared } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-big", "ready", "shared-pool"),
        lifecycleRow("w1", "downloaded", "shared-pool"),
      ]),
    });
    expect("drainMs" in undeclared).toBe(false);
  });

  test("drain is emitted only alongside the resident set", () => {
    // Kills: emitting drain without the resident set.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const store = opsStore([
      lifecycleRow("w-big", "ready", GROUP),
      lifecycleRow("w1", "downloaded", GROUP),
    ]);
    const { signals } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store,
    });
    const drainMs = signals.drainMs;
    expect(typeof drainMs).toBe("function");
    if (drainMs === undefined) return;
    expect(drainMs(wiringAd("w1", 0))).toBe(DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs);

    const { signals: cooldownOnly } = residencyRankingInputs({
      residency: { switchCooldownSeconds: 30 },
      nodeId: "local",
      nodeName: "n1",
      store,
    });
    expect("drainMs" in cooldownOnly).toBe(false);

    const { signals: noResidency } = residencyRankingInputs({
      residency: null,
      nodeId: "local",
      nodeName: "n1",
      store,
    });
    expect(noResidency).toEqual({});
  });

  test("createSharedUnifiedProxy ranks a cold replica behind an occupied exclusive group behind its free twin", async () => {
    // Kills: create-proxy or ranking not consuming the produced signal —
    // w1 and w2 tie at 29999 and catalog order keeps w1 first.
    const createSharedUnifiedProxy = sharedProxyFn();
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { coldLoadPenaltyMs: 1 })],
      store: opsStore([
        lifecycleRow("w-big", "ready", GROUP),
        lifecycleRow("w1", "downloaded", GROUP),
      ]),
      catalog: unstagedCatalog(),
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/local/w2"]);
  });
});
