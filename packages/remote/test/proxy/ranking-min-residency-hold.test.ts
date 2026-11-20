/**
 * #518 — min-residency hold in unified candidate ranking.
 * residencyRankingInputs maps a NodeRun's spec.residency.minResidencySeconds
 * plus ready residency_states lifecycle rows to the ranker's
 * cooldownUntil signal — a local candidate without a `ready` lifecycle row
 * whose declared-exclusive residency group is held by another member in
 * `ready` is charged until that member has been `ready` for
 * minResidencySeconds, composed with the switch cooldown as the later
 * instant. createResidencyRankingSource must read the store when
 * minResidencySeconds is the only nonzero knob, and
 * createSharedUnifiedProxy must feed the hold into rankRouteCandidates.
 * Neither behaviour exists at the pinned base, so every case fails by
 * assertion — never by a link or type error — and holds once the wiring
 * lands: the hold follows state === "ready" (not isOccupyingResidencyState)
 * and RESIDENCY_GROUPS exclusivity, takes the latest ready occupant,
 * reports absolute instants (expired holds included), and never charges
 * ready, peer or rowless candidates.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog, routingRanking } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { RESIDENCY_GROUPS } from "@llamactl/core/residency/lifecycle";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResidencyStateRecord, ResidencyStoreSnapshot } from "../../src/residency/store.js";

import * as proxyMod from "../../src/proxy/create-proxy.js";
import { createResidencyRankingSource } from "../../src/proxy/residency-ranking.js";
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
const GROUP = "z13-large-gpu";
const MIN_RESIDENCY_HOLD_MS = 600_000;

/** The residencyRankingInputs input shape this slice reads. */
interface HoldRankingInput {
  residency: NodeRunResidency | null | undefined;
  store: ResidencyStoreSnapshot;
  nodeId: string;
  nodeName?: string;
}

interface HoldRankingResult {
  policy: NodeRunResidency | null;
  signals: routingRanking.RankingSignals;
}

type HoldRankingInputsFn = (input: HoldRankingInput) => HoldRankingResult;

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

function rankingInputsFn(): HoldRankingInputsFn | undefined {
  return exported("residencyRankingInputs") as HoldRankingInputsFn | undefined;
}

function sharedProxyFn(): SharedUnifiedProxyFactory | undefined {
  return exported("createSharedUnifiedProxy") as SharedUnifiedProxyFactory | undefined;
}

let sandbox: string | undefined;

function fx(): string {
  if (sandbox === undefined) throw new Error("ranking-min-residency-hold fixture not started");
  return sandbox;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-ranking-hold-"));
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

/** A readable store snapshot carrying lifecycle rows and, when given,
 *  recorded switch times. */
function opsStore(
  lifecycle: ResidencyStateRecord[],
  lastSucceededAtMs: Record<string, number> = {},
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

/** The two-replica local-http catalog the proxy case ranks: w-held listed
 *  first, w-free second — both unstaged (production, 3 pts), so catalog
 *  order alone keeps w-held ahead until the min-residency hold lands. */
function holdCatalog(): routingCatalog.RouteCatalog {
  const cat = routingCatalog.buildRouteCatalog({
    routes: [],
    nodeId: "local",
    now: NOW,
    advertisements: [
      wiringAd("w-held", 0, { transport: "local-http" }),
      wiringAd("w-free", 1, { transport: "local-http" }),
    ],
  });
  expect(routingCatalog.catalogCandidatesFor(cat, MODEL)).toHaveLength(2);
  return cat;
}

interface SharedRig {
  proxy: proxyMod.UnifiedProxy;
  picked: string[];
  preferred: (string | undefined)[];
}

function sharedRig(
  create: SharedUnifiedProxyFactory,
  input: {
    env: NodeJS.ProcessEnv;
    nodeRuns: NodeRun[];
    store: ResidencyStoreSnapshot;
    catalog: routingCatalog.RouteCatalog;
    now?: () => number;
  },
): SharedRig {
  const resolved = freshResolved();
  expect(openaiProxy.defaultTargetModelIds(resolved).has(MODEL)).toBe(false);
  const picked: string[] = [];
  const preferred: (string | undefined)[] = [];
  const proxy = create({
    env: input.env,
    resolved: () => resolved,
    peers: [],
    catalog: () => input.catalog,
    acquireExecutor: (candidate) => {
      picked.push(candidate.advertisement.deploymentId);
      return recordingExecutor(candidate.advertisement.deploymentId, preferred);
    },
    listNodeRuns: () => input.nodeRuns,
    readStore: () => input.store,
    now: input.now ?? ((): number => NOW),
  });
  return { proxy, picked, preferred };
}

describe("#518 min-residency hold in unified ranking", () => {
  test("charges a cold local member of an exclusive group the occupant's min-residency hold", () => {
    // Kills: minResidencySeconds missing from rankingKnobsActive or no hold
    // signal; charging ready or peer ads; charging rowless candidates.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const { signals } = residencyRankingInputs({
      residency: { minResidencySeconds: 600 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-occ", "ready", GROUP),
        lifecycleRow("w-cand", "downloaded", GROUP),
      ]),
    });
    const cooldownUntil = signals.cooldownUntil;
    expect(typeof cooldownUntil).toBe("function");
    if (cooldownUntil === undefined) return;
    expect(cooldownUntil(wiringAd("w-cand", 0))).toBe(NOW + MIN_RESIDENCY_HOLD_MS);
    expect(cooldownUntil(wiringAd("w-occ", 1))).toBeUndefined();
    const peer = wiringAd("w-cand", 0, { ownerNodeId: "peer-1" });
    expect(peer.deploymentId).toBe("deploy/local/w-cand");
    expect(cooldownUntil(peer)).toBeUndefined();
    expect(cooldownUntil(wiringAd("w-ghost", 2))).toBeUndefined();
  });

  test("only a ready occupant of a declared-exclusive group holds", () => {
    // Kills: using isOccupyingResidencyState instead of state === "ready";
    // ignoring RESIDENCY_GROUPS exclusivity or the group declaration.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    expect(RESIDENCY_GROUPS.some((g) => g.name === "shared-gpu")).toBe(false);
    const node = { nodeId: "local", nodeName: "n1" };

    const { signals: ready } = residencyRankingInputs({
      ...node,
      residency: { minResidencySeconds: 600 },
      store: opsStore([
        lifecycleRow("w-occ", "ready", GROUP),
        lifecycleRow("w-cand", "downloaded", GROUP),
      ]),
    });
    expect(ready.cooldownUntil?.(wiringAd("w-cand", 0))).toBe(NOW + MIN_RESIDENCY_HOLD_MS);

    for (const occupantState of ["loading", "warming"] as const) {
      const { signals } = residencyRankingInputs({
        ...node,
        residency: { minResidencySeconds: 600 },
        store: opsStore([
          lifecycleRow("w-occ", occupantState, GROUP),
          lifecycleRow("w-cand", "downloaded", GROUP),
        ]),
      });
      expect(signals.cooldownUntil?.(wiringAd("w-cand", 0)), occupantState).toBeUndefined();
    }

    const { signals: undeclared } = residencyRankingInputs({
      ...node,
      residency: { minResidencySeconds: 600 },
      store: opsStore([
        lifecycleRow("w-occ", "ready", "shared-gpu"),
        lifecycleRow("w-cand", "downloaded", "shared-gpu"),
      ]),
    });
    expect(undeclared.cooldownUntil?.(wiringAd("w-cand", 0))).toBeUndefined();

    const { signals: ungrouped } = residencyRankingInputs({
      ...node,
      residency: { minResidencySeconds: 600 },
      store: opsStore([lifecycleRow("w-occ", "ready"), lifecycleRow("w-cand", "downloaded")]),
    });
    expect(ungrouped.cooldownUntil?.(wiringAd("w-cand", 0))).toBeUndefined();
  });

  test("the hold composes with the switch cooldown as the later instant", () => {
    // Kills: replacing max with the switch-only or hold-only value.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const adB = wiringAd("w-cand", 0);
    const cooldownFor = (
      lastSucceededAtMs: number,
      minResidencySeconds = 600,
    ): number | undefined =>
      residencyRankingInputs({
        residency: { minResidencySeconds, switchCooldownSeconds: 60 },
        nodeId: "local",
        nodeName: "n1",
        store: opsStore(
          [lifecycleRow("w-occ", "ready", GROUP), lifecycleRow("w-cand", "downloaded", GROUP)],
          { [profileSwitchOperationKey("n1")]: lastSucceededAtMs },
        ),
      }).signals.cooldownUntil?.(adB);

    // L + 60_000 = 1_610_000 lands later than the hold's NOW + 600_000.
    expect(cooldownFor(1_550_000)).toBe(1_610_000);
    // L + 60_000 = 1_560_000 lands earlier than the hold.
    expect(cooldownFor(1_500_000)).toBe(NOW + MIN_RESIDENCY_HOLD_MS);
    // minResidencySeconds 0 leaves the #772 switch-cooldown value alone.
    expect(cooldownFor(1_550_000, 0)).toBe(1_610_000);
  });

  test("minResidencySeconds 0 means the hold is absent even when the switch cooldown already ended", () => {
    // Kills: dropping `if (input.minMs <= 0) return undefined;` from
    // minResidencyHoldSignal — a zero-length hold would report the
    // occupant's ready time (NOW) and outrank the expired switch
    // cooldown instant L + 60_000 = 960_000.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const L = 900_000;
    const { signals } = residencyRankingInputs({
      residency: { minResidencySeconds: 0, switchCooldownSeconds: 60 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore(
        [lifecycleRow("w-occ", "ready", GROUP, NOW), lifecycleRow("w-cand", "downloaded", GROUP)],
        { [profileSwitchOperationKey("n1")]: L },
      ),
    });
    expect(L + 60_000).toBeLessThan(NOW);
    expect(signals.cooldownUntil?.(wiringAd("w-cand", 0))).toBe(960_000);
  });

  test("two ready members of one exclusive group never charge each other", () => {
    // Kills: deleting `if (input.ready.has(deploymentId)) continue;` from
    // minResidencyHoldSignal — each ready member would be held by the
    // other's ready time (NOW + 600_000).
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const { signals } = residencyRankingInputs({
      residency: { minResidencySeconds: 600 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-ready-a", "ready", GROUP, NOW),
        lifecycleRow("w-ready-b", "ready", GROUP, NOW),
      ]),
    });
    const adA = wiringAd("w-ready-a", 0);
    const adB = wiringAd("w-ready-b", 1);
    expect(signals.cooldownUntil?.(adA)).toBeUndefined();
    expect(signals.cooldownUntil?.(adB)).toBeUndefined();

    const cat = routingCatalog.buildRouteCatalog({
      routes: [],
      nodeId: "local",
      now: NOW,
      advertisements: [adA, adB],
    });
    const candidates = routingCatalog.catalogCandidatesFor(cat, MODEL);
    expect(candidates).toHaveLength(2);
    const ranked = routingRanking.rankRouteCandidates(candidates, { now: NOW, signals });
    expect(ranked).toHaveLength(2);
    for (const r of ranked) {
      expect(r.switchCostMs, r.candidate.advertisement.deploymentId).toBe(0);
    }
  });

  test("the latest-ready occupant sets the hold, and an expired hold still reports its past instant", () => {
    // Kills: taking the first or minimum occupant; clamping the expired
    // hold to now or dropping it.
    const residencyRankingInputs = rankingInputsFn();
    expect(typeof residencyRankingInputs).toBe("function");
    if (residencyRankingInputs === undefined) return;
    expect(RESIDENCY_GROUPS.find((g) => g.name === GROUP)?.exclusive).toBe(true);
    const adB = wiringAd("w-cand", 0);

    const T1 = 900_000;
    const T2 = NOW;
    const { signals: latest } = residencyRankingInputs({
      residency: { minResidencySeconds: 600 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-occ-1", "ready", GROUP, T1),
        lifecycleRow("w-occ-2", "ready", GROUP, T2),
        lifecycleRow("w-cand", "downloaded", GROUP),
      ]),
    });
    expect(latest.cooldownUntil?.(adB)).toBe(T2 + MIN_RESIDENCY_HOLD_MS);

    const cat = routingCatalog.buildRouteCatalog({
      routes: [],
      nodeId: "local",
      now: NOW,
      advertisements: [adB],
    });
    const candidates = routingCatalog.catalogCandidatesFor(cat, MODEL);
    expect(candidates).toHaveLength(1);
    const [activeRanked] = routingRanking.rankRouteCandidates(candidates, {
      now: NOW,
      signals: latest,
    });
    expect(activeRanked?.switchCostMs).toBe(MIN_RESIDENCY_HOLD_MS);

    const OLD_READY_AT = NOW - 700_000;
    const { signals: expired } = residencyRankingInputs({
      residency: { minResidencySeconds: 600 },
      nodeId: "local",
      nodeName: "n1",
      store: opsStore([
        lifecycleRow("w-occ", "ready", GROUP, OLD_READY_AT),
        lifecycleRow("w-cand", "downloaded", GROUP),
      ]),
    });
    expect(expired.cooldownUntil?.(adB)).toBe(OLD_READY_AT + MIN_RESIDENCY_HOLD_MS);
    const [expiredRanked] = routingRanking.rankRouteCandidates(candidates, {
      now: NOW,
      signals: expired,
    });
    expect(expiredRanked?.switchCostMs).toBe(0);
  });

  test("createResidencyRankingSource reads the store when minResidencySeconds is the only nonzero knob", () => {
    // Kills: leaving the inline triple-knob check in
    // createResidencyRankingSource — with only minResidencySeconds set it
    // returns {} signals and never reads the store.
    const reads = { readStore: 0 };
    const source = createResidencyRankingSource({
      env: { LLAMACTL_NODE_NAME: "n1" },
      nodeId: "local",
      listNodeRuns: () => [nodeRun("n1", { minResidencySeconds: 600 })],
      readStore: () => {
        reads.readStore += 1;
        return opsStore([
          lifecycleRow("w-occ", "ready", GROUP),
          lifecycleRow("w-cand", "downloaded", GROUP),
        ]);
      },
      now: () => NOW,
    });
    const signals = source.signals();
    expect(reads.readStore).toBeGreaterThanOrEqual(1);
    expect(signals.cooldownUntil?.(wiringAd("w-cand", 0))).toBe(NOW + MIN_RESIDENCY_HOLD_MS);
  });

  test("createSharedUnifiedProxy ranks a cold replica behind an active min-residency hold behind its free twin", async () => {
    // Kills: not feeding the hold into rankRouteCandidates — w-held and
    // w-free tie at 90000 and catalog order keeps w-held first.
    const createSharedUnifiedProxy = sharedProxyFn();
    expect(typeof createSharedUnifiedProxy).toBe("function");
    if (createSharedUnifiedProxy === undefined) return;
    const rig = sharedRig(createSharedUnifiedProxy, {
      env: { LLAMACTL_UNIFIED_PROXY: "1", LLAMACTL_NODE_NAME: "n1" },
      nodeRuns: [nodeRun("n1", { minResidencySeconds: 600 })],
      store: opsStore([
        lifecycleRow("w-occ", "ready", GROUP),
        lifecycleRow("w-held", "downloaded", GROUP),
        lifecycleRow("w-free", "downloaded"),
      ]),
      catalog: holdCatalog(),
    });
    const res = await rig.proxy.handleRequest(chatReq());
    expect(res.status).toBe(200);
    expect(rig.picked).toEqual(["deploy/local/w-free"]);
    expect(rig.preferred).toEqual(["w-free"]);
  });
});
