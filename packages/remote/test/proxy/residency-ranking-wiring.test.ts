/**
 * #519 — residency-aware candidate ranking on the shared unified proxy.
 * create-proxy.ts gains two exports this slice pins: residencyRankingInputs
 * (a NodeRun's spec.residency plus the node-local residency-store snapshot
 * -> the ranking policy and the resident deploymentIds) and
 * createSharedUnifiedProxy (the factory dispatchProxyRequest builds instead
 * of bare createProxy, wiring LLAMACTL_NODE_NAME -> NodeRun lookup, a
 * ttlMs-cached store read, and both ranking inputs into createProxy). Neither
 * exists at the pinned base, so every case fails by assertion on
 * `typeof fn`, never by a link error; once the wiring lands these pins hold
 * the ready-only resident set, unknown-store inertness, node-identity
 * gating, TTL caching and the dispatch factory call.
 */
import type { ResidencyPolicy } from "@llamactl/core/residency/admission";
import type { ResolvedEnv } from "@llamactl/core/types";

import {
  openaiProxy,
  routingCapabilities,
  routingCatalog,
  type routingRanking,
} from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../../src/residency/store.js";

import * as proxyMod from "../../src/proxy/create-proxy.js";
import { mkdtempSync, readFileSync, rmSync } from "../../src/safe-fs.js";
import {
  type NodeRun,
  type NodeRunResidency,
  NodeRunSchema,
} from "../../src/workload/noderun-schema.js";

const MODEL = "rank/model";
const NOW = 1_000_000;
const RESIDENCY_TTL_MS = 5_000;
const REPO = resolve(import.meta.dir, "../../../..");

/** The residency knobs a NodeRun spec.residency carries into ranking. */
type PolicyKnobs = Partial<ResidencyPolicy>;

/** Shape of the residencyRankingInputs export the fix adds. */
interface ResidencyRankingInputsResult {
  policy: ResidencyPolicy;
  signals: routingRanking.RankingSignals;
}

type ResidencyRankingInputsFn = (input: {
  residency: PolicyKnobs | null | undefined;
  store: ResidencyStoreSnapshot;
  nodeId: string;
}) => ResidencyRankingInputsResult;

/** Shape of the createSharedUnifiedProxy export the fix adds: the
 *  UnifiedProxyOptions surface plus the residency inputs' injected deps. */
type SharedUnifiedProxyOptions = proxyMod.UnifiedProxyOptions & {
  listNodeRuns?: () => NodeRun[];
  readStore?: () => ResidencyStoreSnapshot;
  ttlMs?: number;
};

type SharedUnifiedProxyFactory = (opts?: SharedUnifiedProxyOptions) => proxyMod.UnifiedProxy;

type AdOverrides = Partial<routingCatalog.RouteAdvertisementV1>;

function exported(name: string): unknown {
  return (proxyMod as Record<string, unknown>)[name];
}

let sandbox: string | undefined;

function fx(): string {
  if (sandbox === undefined) throw new Error("residency-ranking-wiring fixture not started");
  return sandbox;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-residency-wiring-"));
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

const STORE_PATH = "/residency/operations.sqlite";

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

function storeWithLifecycle(lifecycle: ResidencyStateRecord[]): ResidencyStoreSnapshot {
  return {
    path: STORE_PATH,
    present: true,
    nonterminal: [],
    lifecycle,
  };
}

function nodeRun(name: string, residency?: NodeRunResidency): NodeRun {
  return NodeRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name },
    spec: {
      node: name,
      ...(residency === undefined ? {} : { residency }),
      infra: [],
    },
  });
}

/** The two-ad catalog every proxy case ranks: w1 listed first, unstaged
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
    now?: () => number;
    reads?: RigReads;
  },
): SharedRig {
  const cat = wiringCatalog();
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
      return input.nodeRuns;
    },
    readStore: () => {
      if (input.reads !== undefined) input.reads.readStore += 1;
      return input.store;
    },
    now: input.now ?? ((): number => NOW),
  });
  return { proxy, picked };
}

describe("residencyRankingInputs (#519)", () => {
  test("ready lifecycle rows become resident deploymentIds and knobs pass through", () => {
    // Kills: not building the set from ready rows, or a wrong deploymentId
    // shape (a bare model or node/model id never matches deploy/local/w2).
    const residencyRankingInputs = exported("residencyRankingInputs") as
      | ResidencyRankingInputsFn
      | undefined;
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const inputs = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 120_000 },
      store: storeWithLifecycle([lifecycleRow("w2", "ready")]),
      nodeId: "local",
    });
    expect(inputs.policy.coldLoadPenaltyMs).toBe(120_000);
    expect(inputs.signals.resident).toBeInstanceOf(Set);
    expect(inputs.signals.resident?.has("deploy/local/w2")).toBe(true);
    expect(inputs.signals.resident?.has("deploy/local/w1")).toBe(false);
    expect(routingCatalog.workloadOfDeployment("deploy/local/w2", "local")).toBe("w2");
  });

  test("default residency knobs produce empty ranking signals", () => {
    // Kills: always supplying the resident set — with every ranking knob at
    // its default the set is inert, so signals must stay {} exactly as the
    // #518 proxy behaves today.
    const residencyRankingInputs = exported("residencyRankingInputs") as
      | ResidencyRankingInputsFn
      | undefined;
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const store = storeWithLifecycle([lifecycleRow("w2", "ready")]);
    const variants: (PolicyKnobs | null | undefined)[] = [
      undefined,
      {},
      { safetyMarginRatio: 0.5, residentPreference: 0, coldLoadPenaltyMs: 0 },
    ];
    for (const residency of variants) {
      const inputs = residencyRankingInputs({ residency, store, nodeId: "local" });
      expect("resident" in inputs.signals).toBe(false);
      expect(inputs.signals).toEqual({});
    }
  });

  test("an unreadable store yields unknown residency, not an empty set", () => {
    // Kills: treating an unreadable store as an empty resident set — absent,
    // errored and lifecycle-failed snapshots must all omit `resident` so
    // ranking falls back to unknown-residency behaviour.
    const residencyRankingInputs = exported("residencyRankingInputs") as
      | ResidencyRankingInputsFn
      | undefined;
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const residency: PolicyKnobs = { coldLoadPenaltyMs: 120_000, residentPreference: 1 };
    const stores: ResidencyStoreSnapshot[] = [
      { path: STORE_PATH, present: false },
      { path: STORE_PATH, present: true, error: "open failed" },
      {
        path: STORE_PATH,
        present: true,
        nonterminal: [],
        lifecycleError: "lifecycle read failed",
      },
    ];
    for (const store of stores) {
      const inputs = residencyRankingInputs({ residency, store, nodeId: "local" });
      expect("resident" in inputs.signals).toBe(false);
    }
  });

  test("only ready lifecycle rows count as resident", () => {
    // Kills: using OCCUPYING_RESIDENCY_STATES (loading/warming would leak in)
    // or any non-ready inclusion; every other state must be excluded.
    const residencyRankingInputs = exported("residencyRankingInputs") as
      | ResidencyRankingInputsFn
      | undefined;
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const inputs = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 120_000, residentPreference: 1 },
      store: storeWithLifecycle([
        lifecycleRow("m-unavailable", "unavailable"),
        lifecycleRow("m-downloaded", "downloaded"),
        lifecycleRow("m-loading", "loading"),
        lifecycleRow("m-warming", "warming"),
        lifecycleRow("m-draining", "draining"),
        lifecycleRow("m-unloading", "unloading"),
        lifecycleRow("m-failed", "failed"),
        lifecycleRow("m-ready", "ready"),
      ]),
      nodeId: "local",
    });
    const resident = inputs.signals.resident;
    expect(resident).toBeInstanceOf(Set);
    expect(resident?.has("deploy/local/m-ready")).toBe(true);
    for (const state of [
      "unavailable",
      "downloaded",
      "loading",
      "warming",
      "draining",
      "unloading",
      "failed",
    ] as const) {
      expect(resident?.has(`deploy/local/m-${state}`)).toBe(false);
    }
  });
});

describe("createSharedUnifiedProxy (#519)", () => {
  test("the NodeRun residency policy and ready residents decide the pick", async () => {
    // Kills: dropping residencyPolicy from the createProxy call — resident
    // signals alone tie both candidates at 30000 and catalog order picks w1.
    // Also kills dropping rankingSignals — the policy alone scores w1 90000
    // against w2's 30000 and picks w1.
    const createSharedUnifiedProxy = exported("createSharedUnifiedProxy") as
      | SharedUnifiedProxyFactory
      | undefined;
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const store = storeWithLifecycle([lifecycleRow("w2", "ready")]);
    const env = { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" };

    const cold = sharedRig(createSharedUnifiedProxy, {
      env,
      nodeRuns: [nodeRun("n1", { coldLoadPenaltyMs: 120_000 })],
      store,
    });
    const coldRes = await cold.proxy.handleRequest(chatReq());
    expect(coldRes.status).toBe(200);
    // w1 = 90000 - (60000 + 120000) = -90000; w2 = 30000.
    expect(cold.picked).toEqual(["deploy/local/w2"]);

    const pref = sharedRig(createSharedUnifiedProxy, {
      env,
      nodeRuns: [nodeRun("n1", { residentPreference: 5 })],
      store,
    });
    const prefRes = await pref.proxy.handleRequest(chatReq());
    expect(prefRes.status).toBe(200);
    // w1 = 90000 - 60000 = 30000; w2 = 30000 + 5 * 30000 = 180000.
    expect(pref.picked).toEqual(["deploy/local/w2"]);
  });

  test("no residency or no NodeRun keeps parity with bare createProxy", async () => {
    // Kills: a default-path behaviour change — without ranking inputs the
    // shared factory must pick exactly what bare createProxy picks.
    const createSharedUnifiedProxy = exported("createSharedUnifiedProxy") as
      | SharedUnifiedProxyFactory
      | undefined;
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const store = storeWithLifecycle([lifecycleRow("w2", "ready")]);
    const env = { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" };

    const noResidency = sharedRig(createSharedUnifiedProxy, {
      env,
      nodeRuns: [nodeRun("n1")],
      store,
    });
    const first = await noResidency.proxy.handleRequest(chatReq());
    expect(first.status).toBe(200);
    expect(noResidency.picked).toEqual(["deploy/local/w1"]);

    const noNodeRuns = sharedRig(createSharedUnifiedProxy, {
      env,
      nodeRuns: [],
      store,
    });
    const second = await noNodeRuns.proxy.handleRequest(chatReq());
    expect(second.status).toBe(200);
    expect(noNodeRuns.picked).toEqual(["deploy/local/w1"]);

    const cat = wiringCatalog();
    const resolved = freshResolved();
    const barePicked: string[] = [];
    const bare = proxyMod.createProxy({
      env,
      resolved: () => resolved,
      peers: [],
      catalog: () => cat,
      acquireExecutor: (candidate) => {
        barePicked.push(candidate.advertisement.deploymentId);
        return recordingExecutor(candidate.advertisement.deploymentId);
      },
      now: () => NOW,
    });
    const third = await bare.handleRequest(chatReq());
    expect(third.status).toBe(200);
    expect(barePicked).toEqual(["deploy/local/w1"]);
  });

  test("without a serving node name the store is never read", async () => {
    // Kills: falling back to the first NodeRun, or reading the store without
    // a serving node — LLAMACTL_NODE_NAME unset or blank means no NodeRun is
    // selected and readStore is never called.
    const createSharedUnifiedProxy = exported("createSharedUnifiedProxy") as
      | SharedUnifiedProxyFactory
      | undefined;
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const store = storeWithLifecycle([lifecycleRow("w2", "ready")]);
    for (const env of [
      { LLAMACTL_UNIFIED_PROXY: "1" },
      { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "" },
    ]) {
      const reads: RigReads = { listNodeRuns: 0, readStore: 0 };
      const rig = sharedRig(createSharedUnifiedProxy, {
        env,
        nodeRuns: [nodeRun("n1", { coldLoadPenaltyMs: 120_000 })],
        store,
        reads,
      });
      const res = await rig.proxy.handleRequest(chatReq());
      expect(res.status).toBe(200);
      expect(rig.picked).toEqual(["deploy/local/w1"]);
      expect(reads.readStore).toBe(0);
    }
  });

  test("residency inputs are cached for the ttl and re-read after it", async () => {
    // Kills: per-request reads, or a cache that never refreshes — two
    // requests inside the default 5000ms ttl share one NodeRun/store read,
    // and a request past the ttl re-reads both.
    const createSharedUnifiedProxy = exported("createSharedUnifiedProxy") as
      | SharedUnifiedProxyFactory
      | undefined;
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const store = storeWithLifecycle([lifecycleRow("w2", "ready")]);
    let clock = NOW;
    const reads: RigReads = { listNodeRuns: 0, readStore: 0 };
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { coldLoadPenaltyMs: 120_000 })],
      store,
      now: () => clock,
      reads,
    });
    const first = await rig.proxy.handleRequest(chatReq());
    expect(first.status).toBe(200);
    clock += 1_000;
    const second = await rig.proxy.handleRequest(chatReq());
    expect(second.status).toBe(200);
    expect(reads).toEqual({ listNodeRuns: 1, readStore: 1 });
    clock += RESIDENCY_TTL_MS + 1;
    const third = await rig.proxy.handleRequest(chatReq());
    expect(third.status).toBe(200);
    expect(reads).toEqual({ listNodeRuns: 2, readStore: 2 });
    expect(rig.picked).toEqual(["deploy/local/w2", "deploy/local/w2", "deploy/local/w2"]);
  });

  test("dispatchProxyRequest builds the shared unified proxy", () => {
    // Kills: keeping the bare createProxy() in production dispatch, which
    // drops the NodeRun ranking wiring entirely.
    const src = readFileSync(join(REPO, "packages/remote/src/proxy/create-proxy.ts"), "utf8");
    const dispatch = /export function dispatchProxyRequest[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(dispatch).toContain("sharedProxy ??= createSharedUnifiedProxy();");
    expect(dispatch).not.toContain("sharedProxy ??= createProxy();");
  });
});
