/**
 * #518 (c) — operational availability in unified candidate ranking.
 * residencyRankingInputs maps node-local residency_states lifecycle rows
 * to the ranker's operationalState signal — draining and unloading rows
 * report "draining", failed rows report "failed", every other state and
 * every peer report undefined — and createSharedUnifiedProxy must feed it
 * into rankRouteCandidates even when switchCooldownSeconds is the only
 * nonzero knob. Neither behaviour exists at the pinned base, so every
 * case fails by assertion — never by a link or type error — and holds
 * once the wiring lands: the signal marks only this node's local
 * candidates, stays absent on unknown inputs, and reorders the pick.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
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

/** Operational states the fix reports through the ranking signal. */
type OperationalAvailability = "draining" | "failed";

/** Local shape of the operationalState signal the fix adds to
 *  RankingSignals; declared here so the base typechecks. */
interface OperationalSignals {
  operationalState?: (
    ad: routingCatalog.RouteAdvertisementV1,
  ) => OperationalAvailability | undefined;
}

/** The residencyRankingInputs input shape this slice extends with
 *  nodeName and the operationalState signal. */
interface OperationalRankingInput {
  residency: NodeRunResidency | null | undefined;
  store: ResidencyStoreSnapshot;
  nodeId: string;
  nodeName?: string;
}

interface OperationalRankingResult {
  policy: NodeRunResidency | null;
  signals: OperationalSignals;
}

type OperationalRankingInputsFn = (input: OperationalRankingInput) => OperationalRankingResult;

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

function rankingInputsFn(): OperationalRankingInputsFn | undefined {
  return exported("residencyRankingInputs") as OperationalRankingInputsFn | undefined;
}

function sharedProxyFn(): SharedUnifiedProxyFactory | undefined {
  return exported("createSharedUnifiedProxy") as SharedUnifiedProxyFactory | undefined;
}

let sandbox: string | undefined;

function fx(): string {
  if (sandbox === undefined) throw new Error("ranking-operational-state fixture not started");
  return sandbox;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-ranking-operational-"));
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
 *  the only thing separating them until operational state lands. */
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

describe("#518 operational state from residency lifecycle", () => {
  test("lifecycle draining/unloading/failed rows mark only this node's local candidates", () => {
    // Kills: no operationalState wiring; unloading not folded into draining;
    // marking loading/warming/ready; skipping the ownerNodeId check; and
    // emitting the key when nothing is marked (that would break the
    // toEqual({}) pins the other ranking slices rely on).
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const { signals } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w1", "draining"),
        lifecycleRow("w2", "unloading"),
        lifecycleRow("w3", "failed"),
        lifecycleRow("w4", "ready"),
        lifecycleRow("w5", "loading"),
        lifecycleRow("w6", "warming"),
      ]),
    });
    const operationalState = signals.operationalState;
    expect(typeof operationalState).toBe("function");
    if (operationalState === undefined) return;
    expect(operationalState(wiringAd("w1", 0))).toBe("draining");
    expect(operationalState(wiringAd("w2", 1))).toBe("draining");
    expect(operationalState(wiringAd("w3", 2))).toBe("failed");
    expect(operationalState(wiringAd("w4", 3))).toBeUndefined();
    expect(operationalState(wiringAd("w5", 4))).toBeUndefined();
    expect(operationalState(wiringAd("w6", 5))).toBeUndefined();
    expect(operationalState(wiringAd("w1", 0, { ownerNodeId: "peer-a" }))).toBeUndefined();

    const { signals: noResidency } = residencyRankingInputs({
      residency: null,
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([lifecycleRow("w1", "draining")]),
    });
    expect(noResidency).toEqual({});
    const { signals: errored } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: { path: STORE_PATH, present: true, error: "x" },
    });
    expect("operationalState" in errored).toBe(false);
    const { signals: onlyReady } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 1 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([lifecycleRow("w9", "ready")]),
    });
    expect("operationalState" in onlyReady).toBe(false);
  });

  test("createSharedUnifiedProxy ranks a draining local replica behind its stable twin", async () => {
    // Kills: residency-ranking not emitting the signal when only
    // switchCooldownSeconds is set, or create-proxy/ranking not consuming
    // it — w1 and w2 tie at 90000 and catalog order keeps w1 first.
    const createSharedUnifiedProxy = sharedProxyFn();
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { switchCooldownSeconds: 30 })],
      store: opsStore([lifecycleRow("w1", "draining")]),
      catalog: unstagedCatalog(),
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/local/w2"]);
  });

  test("createSharedUnifiedProxy ranks a failed local replica behind a lower-stage twin", async () => {
    // Kills: failed not mapped into the degraded tier with zero quality
    // points — w1's unstaged 3 points (90000) would beat w2's candidate
    // 1 point (30000) on the base.
    const createSharedUnifiedProxy = sharedProxyFn();
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { switchCooldownSeconds: 30 })],
      store: opsStore([lifecycleRow("w1", "failed")]),
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/local/w2"]);
  });
});
