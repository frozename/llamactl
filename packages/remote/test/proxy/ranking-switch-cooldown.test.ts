/**
 * #518 (c) — switch cooldown in unified candidate ranking. Core's
 * RankingSignals already carries `cooldownUntil`; this slice pins the
 * remote wiring: residencyRankingInputs maps a NodeRun's
 * spec.residency.switchCooldownSeconds plus the store's
 * lastSucceededAtMs[`profile-switch:<LLAMACTL_NODE_NAME>`] entry into a
 * per-candidate cooldown instant, and createSharedUnifiedProxy must read
 * the store when that is the only nonzero knob. Neither behaviour exists
 * at the pinned base, so every case fails by assertion — never by a link
 * or type error — and holds once the wiring lands: the cooldown charges
 * only non-resident local candidates, reports the absolute expiry
 * instant (a past instant costs nothing), stays absent on unknown
 * inputs, and composes with the #519 resident/penalty signals.
 */
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
import { join } from "node:path";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../../src/residency/store.js";

import * as proxyMod from "../../src/proxy/create-proxy.js";
import { profileSwitchOperationKey } from "../../src/residency/profile-transition.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import {
  type NodeRun,
  type NodeRunResidency,
  NodeRunSchema,
} from "../../src/workload/noderun-schema.js";

const MODEL = "rank/model";
const NOW = 1_000_000;
const STORE_PATH = "/residency/operations.sqlite";

/** The residencyRankingInputs input shape the fix extends with nodeName. */
interface SwitchCooldownInput {
  residency: NodeRunResidency | null | undefined;
  store: ResidencyStoreSnapshot;
  nodeId: string;
  nodeName?: string;
}

interface SwitchCooldownInputsResult {
  policy: NodeRunResidency | null;
  signals: routingRanking.RankingSignals;
}

type SwitchCooldownInputsFn = (input: SwitchCooldownInput) => SwitchCooldownInputsResult;

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

function rankingInputsFn(): SwitchCooldownInputsFn | undefined {
  return exported("residencyRankingInputs") as SwitchCooldownInputsFn | undefined;
}

function sharedProxyFn(): SharedUnifiedProxyFactory | undefined {
  return exported("createSharedUnifiedProxy") as SharedUnifiedProxyFactory | undefined;
}

let sandbox: string | undefined;

function fx(): string {
  if (sandbox === undefined) throw new Error("ranking-switch-cooldown fixture not started");
  return sandbox;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-ranking-cooldown-"));
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

/** The peer advertisement case 8 ranks first: owned by peer-a, never a
 *  local switch candidate. */
function peerAd(): routingCatalog.RouteAdvertisementV1 {
  return wiringAd("p1", 0, {
    routeId: "route/peer-a/p1",
    deploymentId: "deploy/peer-a/p1",
    backendId: "backend/peer-a/p1",
    ownerNodeId: "peer-a",
  });
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

/** A readable store carrying per-model last-succeeded switch times; w2
 *  ready by default so the resident set is known. */
function storeWithSwitch(
  lastSucceededAtMs: Record<string, number>,
  lifecycle: ResidencyStateRecord[] = [lifecycleRow("w2", "ready")],
): ResidencyStoreSnapshot {
  return {
    path: STORE_PATH,
    present: true,
    nonterminal: [],
    lastSucceededAtMs,
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

/** The peer-first catalog: the peer ad listed first (unstaged, 3 pts),
 *  then the local staged candidate w2. */
function peerFirstCatalog(): routingCatalog.RouteCatalog {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: "local",
    now: NOW,
    advertisements: [peerAd(), wiringAd("w2", 1, { qualification: { stage: "candidate" } })],
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

describe("#518 switch cooldown in unified ranking", () => {
  test("an active cooldown charges only non-resident local candidates", () => {
    // Kills: no cooldown wiring; charging a resident candidate; charging
    // peers; adding the resident set when only the cooldown knob is set
    // (that would leak the 60s default load cost into ranking).
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(profileSwitchOperationKey("n1")).toBe("profile-switch:n1");
    const { signals } = residencyRankingInputs({
      residency: { switchCooldownSeconds: 300 },
      store: storeWithSwitch({ "profile-switch:n1": NOW - 60_000 }),
      nodeId: "local",
      nodeName: "n1",
    });
    const cooldown = signals.cooldownUntil;
    expect(typeof cooldown).toBe("function");
    if (cooldown === undefined) return;
    expect(cooldown(wiringAd("w1", 0))).toBe(NOW + 240_000);
    expect(cooldown(wiringAd("w2", 1))).toBeUndefined();
    expect(
      cooldown(wiringAd("p1", 0, { ownerNodeId: "peer-a", deploymentId: "deploy/peer-a/p1" })),
    ).toBeUndefined();
    expect("resident" in signals).toBe(false);
  });

  test("cooldownUntil reads only this node's profile-switch key", () => {
    // Kills: MAX over every lastSucceededAtMs key (NOW - 1_000 + 300_000 =
    // NOW + 299_000) and keying on a model name instead of
    // profile-switch:<LLAMACTL_NODE_NAME>.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const { signals } = residencyRankingInputs({
      residency: { switchCooldownSeconds: 300 },
      store: storeWithSwitch({
        "profile-switch:n2": NOW - 1_000,
        w1: NOW - 1_000,
        "profile-switch:n1": NOW - 250_000,
      }),
      nodeId: "local",
      nodeName: "n1",
    });
    const cooldown = signals.cooldownUntil;
    expect(typeof cooldown).toBe("function");
    if (cooldown === undefined) return;
    expect(cooldown(wiringAd("w1", 0))).toBe(NOW + 50_000);
  });

  test("an expired cooldown reports its past instant, not a now-relative one", () => {
    // Kills: returning now + cooldownMs or clamping to now — the signal is
    // the absolute expiry instant and rankRouteCandidates zeroes the cost
    // of a past one.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const { signals } = residencyRankingInputs({
      residency: { switchCooldownSeconds: 300 },
      store: storeWithSwitch({ "profile-switch:n1": NOW - 400_000 }),
      nodeId: "local",
      nodeName: "n1",
    });
    const cooldown = signals.cooldownUntil;
    expect(typeof cooldown).toBe("function");
    if (cooldown === undefined) return;
    expect(cooldown(wiringAd("w1", 0))).toBe(NOW - 100_000);
  });

  test("unknown or absent cooldown inputs emit no cooldownUntil signal", () => {
    // Kills: treating unknown residency as non-resident, charging without
    // a recorded switch, and a non-finite recorded value leaking in.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const control: SwitchCooldownInput = {
      residency: { switchCooldownSeconds: 300 },
      store: storeWithSwitch({ "profile-switch:n1": NOW - 60_000 }),
      nodeId: "local",
      nodeName: "n1",
    };
    expect(typeof residencyRankingInputs(control).signals.cooldownUntil).toBe("function");
    const variants: [string, SwitchCooldownInput][] = [
      ["switchCooldownSeconds 0", { ...control, residency: { switchCooldownSeconds: 0 } }],
      ["residency undefined", { ...control, residency: undefined }],
      [
        "no recorded profile-switch:n1 key",
        {
          ...control,
          store: storeWithSwitch({ "profile-switch:n2": NOW - 1_000, w1: NOW - 2_000 }),
        },
      ],
      [
        "nodeName omitted",
        {
          residency: control.residency,
          store: control.store,
          nodeId: control.nodeId,
        },
      ],
      ["absent store", { ...control, store: { path: STORE_PATH, present: false } }],
      [
        "errored store",
        { ...control, store: { path: STORE_PATH, present: true, error: "open failed" } },
      ],
      [
        "lifecycleError store",
        {
          ...control,
          store: {
            path: STORE_PATH,
            present: true,
            nonterminal: [],
            lastSucceededAtMs: { "profile-switch:n1": NOW - 60_000 },
            lifecycleError: "lifecycle read failed",
          },
        },
      ],
      [
        "non-finite recorded value",
        { ...control, store: storeWithSwitch({ "profile-switch:n1": Number.NaN }) },
      ],
    ];
    for (const [label, input] of variants) {
      const { signals } = residencyRankingInputs(input);
      expect("cooldownUntil" in signals, label).toBe(false);
      expect(signals, label).toEqual({});
    }
  });

  test("cooldownUntil composes with the resident set and cold-load penalty", () => {
    // Kills: cooldown wiring overwriting or dropping the resident set, or
    // the #519 signals wiring dropping cooldownUntil.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const { signals } = residencyRankingInputs({
      residency: { coldLoadPenaltyMs: 120_000, switchCooldownSeconds: 300 },
      store: storeWithSwitch({ "profile-switch:n1": NOW - 60_000 }),
      nodeId: "local",
      nodeName: "n1",
    });
    expect(signals.resident).toBeInstanceOf(Set);
    expect(signals.resident?.has("deploy/local/w2")).toBe(true);
    const cooldown = signals.cooldownUntil;
    expect(typeof cooldown).toBe("function");
    if (cooldown === undefined) return;
    expect(cooldown(wiringAd("w1", 0))).toBe(NOW + 240_000);
    expect(cooldown(wiringAd("w2", 1))).toBeUndefined();
  });

  test("createSharedUnifiedProxy charges an active cooldown and picks the resident candidate", async () => {
    // Kills: the knobs-zero early return in createResidencyRankingSource
    // that skips the store when only switchCooldownSeconds is set
    // (readStore stays 0), and any wiring leaving w1's 240s cooldown
    // uncharged — w1 scores 90000 - 240000 = -150000 against w2's 30000.
    const createSharedUnifiedProxy = sharedProxyFn();
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const reads: RigReads = { listNodeRuns: 0, readStore: 0 };
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { switchCooldownSeconds: 300 })],
      store: storeWithSwitch({ "profile-switch:n1": NOW - 60_000 }),
      reads,
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/local/w2"]);
    expect(reads.readStore).toBe(1);
    expect(reads.listNodeRuns).toBe(1);
  });

  test("createSharedUnifiedProxy ignores an expired cooldown and keeps catalog order", async () => {
    // Kills: charging an expired cooldown (w1 would drop below w2) — and
    // the knobs-zero early return that never reads the store, pinned by
    // readStore staying 0 on the base.
    const createSharedUnifiedProxy = sharedProxyFn();
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const reads: RigReads = { listNodeRuns: 0, readStore: 0 };
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { switchCooldownSeconds: 300 })],
      store: storeWithSwitch({ "profile-switch:n1": NOW - 400_000 }),
      reads,
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/local/w1"]);
    expect(reads.readStore).toBe(1);
    expect(reads.listNodeRuns).toBe(1);
  });

  test("createSharedUnifiedProxy never charges a peer candidate", async () => {
    // Kills: charging every candidate — a peer charged the 240s cooldown
    // (90000 - 240000 = -150000) would lose to the resident w2's 30000.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    const store = storeWithSwitch({ "profile-switch:n1": NOW - 60_000 });
    const peer = peerAd();
    const { signals } = residencyRankingInputs({
      residency: { switchCooldownSeconds: 300 },
      store,
      nodeId: "local",
      nodeName: "n1",
    });
    const cooldown = signals.cooldownUntil;
    expect(typeof cooldown).toBe("function");
    if (cooldown === undefined) return;
    expect(cooldown(peer)).toBeUndefined();

    const createSharedUnifiedProxy = sharedProxyFn();
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { switchCooldownSeconds: 300 })],
      store,
      catalog: peerFirstCatalog(),
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/peer-a/p1"]);
  });
});
