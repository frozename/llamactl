/**
 * G-1 item 3 (part of #285) — randomized experimental-route exclusion
 * invariant across the legacy and unified proxy paths.
 *
 * A seeded generator produces 40 fleet configurations (four peers serving
 * random subsets of one model pool, random qualification labels, random
 * default-target env, and per-peer capability advertisements for one
 * dedicated alias). The oracle is computed from the generated spec only
 * — never from production ordering code: a route is experimental iff its
 * label is "experimental", or its label is absent and its id is the
 * catalog-experimental rel. Across every case: a stable peer route always
 * wins over an experimental one, an experimental route never captures a
 * default-target id, and an exact pin of an experimental-only id still
 * reaches the experimental peer.
 *
 * The capability axis pins the other half of the same guard: a pinned
 * request whose needed capability no stable candidate satisfies is rejected
 * with a capability error instead of falling through to an experimental
 * candidate (the `!hasStable` condition in `selectCatalogCandidates`). The
 * legacy path never routes the capability alias to a peer at all. The
 * /v1/models section also checks that the unified shadow-catalog candidate
 * markers agree with the legacy listing markers for every pooled id.
 *
 * Not covered: project task-kind routing and scorer selection — there is no
 * catalog-driven scorer at base, and project routing returns an
 * operator-configured target.
 */
import type { PeerNode } from "@llamactl/core/config/peers";
import type { ResolvedEnv } from "@llamactl/core/types";
import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BackendExecutor,
  type BackendExecutorDescription,
  createProxy,
} from "../../src/proxy/create-proxy.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const EXPERIMENTAL_CATALOG_TSV =
  'exp-model\tExp test\texp\tcustom\tcustom\texp/model.gguf\torg/exp\tgguf\t{"qualification":{"stage":"experimental"}}\n';

const QUALIFICATION_LABEL = routingCapabilities.QUALIFICATION_LABEL;

const SEED = 0x5eed2857;
const N_CASES = 40;
const MODEL_POOL = ["m-a", "m-b", "exp/model.gguf", "default-alias"];
const PEER_IDS = ["peer-a", "peer-b", "peer-c", "peer-d"];
const EXPERIMENTAL_REL = "exp/model.gguf";
const CAP_ALIAS = "cap/model.gguf";

type LabelChoice = "none" | "experimental" | "production";

interface ServedWorkload {
  modelId: string;
  label: LabelChoice;
}

interface CapSpec {
  experimental: boolean;
  tools: boolean;
}

interface GeneratedCase {
  byPeer: Record<string, ServedWorkload[]>;
  capByPeer: Record<string, CapSpec>;
  defaultKind: "none" | "alias" | "default-model";
  defaultModelId: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickLabel(rng: () => number): LabelChoice {
  const r = rng();
  if (r < 1 / 3) return "none";
  if (r < 2 / 3) return "experimental";
  return "production";
}

function generatePeerWorkloads(rng: () => number): ServedWorkload[] {
  const served: ServedWorkload[] = [];
  for (const modelId of MODEL_POOL) {
    if (rng() < 0.5) served.push({ modelId, label: pickLabel(rng) });
  }
  return served;
}

function generateCapSpec(rng: () => number): CapSpec | undefined {
  if (rng() < 0.4) return undefined;
  const experimental = rng() >= 0.5;
  const tools = rng() < (experimental ? 0.75 : 0.35);
  return { experimental, tools };
}

function generateCapByPeer(rng: () => number): Record<string, CapSpec> {
  const out: Record<string, CapSpec> = {};
  for (const peer of PEER_IDS) {
    const spec = generateCapSpec(rng);
    if (spec !== undefined) out[peer] = spec;
  }
  return out;
}

function defaultKindFor(d: number): GeneratedCase["defaultKind"] {
  if (d < 1 / 3) return "none";
  if (d < 2 / 3) return "alias";
  return "default-model";
}

function pickModel(rng: () => number): string {
  const picked = MODEL_POOL[Math.floor(rng() * MODEL_POOL.length)];
  if (picked === undefined) throw new Error("model pool is empty");
  return picked;
}

function generateCases(): GeneratedCase[] {
  const rng = mulberry32(SEED);
  // Separate stream so the capability draws never perturb the routing cases.
  const capRng = mulberry32(SEED ^ 0x9e3779b9);
  const cases: GeneratedCase[] = [];
  for (let i = 0; i < N_CASES; i += 1) {
    const byPeer: Record<string, ServedWorkload[]> = {};
    for (const peer of PEER_IDS) {
      byPeer[peer] = generatePeerWorkloads(rng);
    }
    const defaultKind = defaultKindFor(rng());
    cases.push({
      byPeer,
      capByPeer: generateCapByPeer(capRng),
      defaultKind,
      defaultModelId: pickModel(rng),
    });
  }
  return cases;
}

const cases = generateCases();

function routeIsExperimental(workload: ServedWorkload): boolean {
  if (workload.label !== "none") return workload.label === "experimental";
  return workload.modelId === EXPERIMENTAL_REL;
}

function servedFor(c: GeneratedCase, peer: string): ServedWorkload[] {
  const list = c.byPeer[peer];
  if (list === undefined) throw new Error(`generated case has no entry for peer ${peer}`);
  return list;
}

function stablePeersOf(c: GeneratedCase, modelId: string): string[] {
  return PEER_IDS.filter((peer) =>
    servedFor(c, peer).some((w) => w.modelId === modelId && !routeIsExperimental(w)),
  );
}

function expPeersOf(c: GeneratedCase, modelId: string): string[] {
  return PEER_IDS.filter((peer) =>
    servedFor(c, peer).some((w) => w.modelId === modelId && routeIsExperimental(w)),
  );
}

function defaultIdOf(c: GeneratedCase): string | undefined {
  return c.defaultKind === "none" ? undefined : c.defaultModelId;
}

function defaultEnvOf(c: GeneratedCase): Record<string, string> {
  if (c.defaultKind === "alias") return { LLAMA_CPP_SERVER_ALIAS: c.defaultModelId };
  if (c.defaultKind === "default-model") return { LLAMA_CPP_DEFAULT_MODEL: c.defaultModelId };
  return {};
}

interface EngineRecord {
  url: string;
  body: unknown;
}

interface FakeEngine {
  port: number;
  records: EngineRecord[];
  stop: () => Promise<void>;
}

interface Fixture {
  sandbox: string;
  runtimeDir: string;
  catalogFile: string;
  defaultEngine: FakeEngine;
  peerEngines: Record<string, FakeEngine>;
}

let fixture: Fixture | undefined;

function fx(): Fixture {
  if (fixture === undefined) throw new Error("experimental-invariant fixture not started");
  return fixture;
}

function peerEngine(id: string): FakeEngine {
  const engine = fx().peerEngines[id];
  if (engine === undefined) throw new Error(`no engine for peer ${id}`);
  return engine;
}

function startEngine(): FakeEngine {
  const records: EngineRecord[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req: Request): Promise<Response> => {
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      records.push({ url: req.url, body });
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-fixture",
          object: "chat.completion",
          model: "fixture-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "fixture reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port ?? 0, records, stop: () => server.stop(true) };
}

function resolvedFor(extra: Record<string, string>): ResolvedEnv {
  const f = fx();
  return resolveEnv({
    DEV_STORAGE: join(f.sandbox, "dev-storage"),
    LOCAL_AI_RUNTIME_DIR: f.runtimeDir,
    LOCAL_AI_CUSTOM_CATALOG_FILE: f.catalogFile,
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: String(f.defaultEngine.port),
    LLAMA_CPP_MACHINE_PROFILE: "balanced",
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "/tmp",
    ...extra,
  });
}

function peerNode(id: string, port: number): PeerNode {
  return { id, endpoint: `http://127.0.0.1:${String(port)}`, token: `token-${id}` };
}

interface PeerWorkloadSpec {
  modelId: string;
  labels?: Record<string, string>;
}

function peerSnapshotsFor(specs: Record<string, PeerWorkloadSpec[]>): Map<string, PeerSnapshot> {
  const out = new Map<string, PeerSnapshot>();
  for (const [peerId, workloads] of Object.entries(specs)) {
    out.set(peerId, {
      workloads: workloads.map((workload) => ({
        modelId: workload.modelId,
        port: 1,
        revision: `${peerId}:${workload.modelId}`,
        ...(workload.labels !== undefined ? { labels: workload.labels } : {}),
      })),
      pressure: "NORMAL",
      fetchedAt: Date.now(),
    });
  }
  return out;
}

function snapshotsFor(c: GeneratedCase): Map<string, PeerSnapshot> {
  const specs: Record<string, PeerWorkloadSpec[]> = {};
  for (const peer of PEER_IDS) {
    specs[peer] = servedFor(c, peer).map((workload) => ({
      modelId: workload.modelId,
      ...(workload.label === "none" ? {} : { labels: { [QUALIFICATION_LABEL]: workload.label } }),
    }));
  }
  return peerSnapshotsFor(specs);
}

function peersFor(): PeerNode[] {
  return PEER_IDS.map((id) => peerNode(id, peerEngine(id).port));
}

interface Scenario {
  resolved: ResolvedEnv;
  peers: PeerNode[];
  peerSnapshots: Map<string, PeerSnapshot>;
}

function scenarioFor(c: GeneratedCase): Scenario {
  return {
    resolved: resolvedFor(defaultEnvOf(c)),
    peers: peersFor(),
    peerSnapshots: snapshotsFor(c),
  };
}

const TOOLS_BODY = {
  tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
};

const IMAGE_BODY = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "describe this image" },
        { type: "image_url", image_url: { url: "http://127.0.0.1:1/pic.png" } },
      ],
    },
  ],
};

function chatReq(model: string, extra: Record<string, unknown> = {}): Request {
  return new Request("http://agent.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
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

interface UnifiedOutcome {
  status: number;
  servedBy: string;
  defaultCalls: string[];
}

async function unifiedServe(s: Scenario, model: string): Promise<UnifiedOutcome> {
  const defaultCalls: string[] = [];
  const acquired: string[] = [];
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    resolved: () => s.resolved,
    peers: s.peers,
    peerSnapshots: s.peerSnapshots,
    executor: recordingExecutor("default", defaultCalls),
    acquireExecutor: (candidate) => {
      const owner = candidate.advertisement.ownerNodeId;
      acquired.push(owner);
      return recordingExecutor(owner);
    },
  });
  const response = await proxy.handleRequest(chatReq(model));
  expect(response.status).toBe(200);
  const servedBy = defaultCalls.length > 0 ? "default" : (acquired.at(-1) ?? "unrouted");
  return { status: response.status, servedBy, defaultCalls };
}

function fullCapabilities(
  over: Partial<routingCapabilities.RouteCapabilities> = {},
): routingCapabilities.RouteCapabilities {
  return { ...routingCapabilities.LEGACY_PROXY_CAPABILITIES, ...over };
}

function capAdvertisement(
  peer: string,
  capabilities: routingCapabilities.RouteCapabilities,
  over: Partial<routingCatalog.RouteAdvertisementV1> = {},
): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/cap-${peer}`,
    deploymentId: `deploy/cap-${peer}`,
    backendId: `backend/cap-${peer}`,
    ownerNodeId: peer,
    publicModelIds: [CAP_ALIAS],
    upstreamModelId: CAP_ALIAS,
    backendKind: "cloud-api",
    transport: "cloud-direct",
    endpoint: "http://127.0.0.1:1/v1",
    capabilities,
    modelRevision: routingCatalog.knownRevision(`cap-model-${peer}`),
    deploymentEpoch: routingCatalog.knownRevision(`cap-epoch-${peer}`),
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
    priority: 0,
    ...over,
  };
}

function capAdvertisementsFor(
  capByPeer: Record<string, CapSpec>,
): routingCatalog.RouteAdvertisementV1[] {
  const ads: routingCatalog.RouteAdvertisementV1[] = [];
  for (const peer of PEER_IDS) {
    const spec = capByPeer[peer];
    if (spec === undefined) continue;
    ads.push(
      capAdvertisement(
        peer,
        fullCapabilities({ tools: spec.tools }),
        spec.experimental ? { qualification: { stage: "experimental" } } : {},
      ),
    );
  }
  return ads;
}

function capPeersWith(
  cap: Record<string, CapSpec>,
  experimental: boolean,
  tools: boolean,
): string[] {
  const out: string[] = [];
  for (const peer of PEER_IDS) {
    const spec = cap[peer];
    if (spec?.experimental === experimental && spec.tools === tools) {
      out.push(peer);
    }
  }
  return out;
}

function capSummary(capByPeer: Record<string, CapSpec>): string {
  return PEER_IDS.map((peer) => {
    const spec = capByPeer[peer];
    if (spec === undefined) return "-";
    return `${spec.experimental ? "exp" : "stable"}:${spec.tools ? "tools" : "no-tools"}`;
  }).join(",");
}

interface CapOutcome {
  status: number;
  servedBy: string;
  acquired: string[];
  body: unknown;
}

async function unifiedCapServe(
  s: Scenario,
  ads: readonly routingCatalog.RouteAdvertisementV1[],
  request: Request,
): Promise<CapOutcome> {
  const defaultCalls: string[] = [];
  const acquired: string[] = [];
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    resolved: () => s.resolved,
    peers: s.peers,
    peerSnapshots: new Map(),
    executor: recordingExecutor("default", defaultCalls),
    acquireExecutor: (candidate) => {
      const owner = candidate.advertisement.ownerNodeId;
      acquired.push(owner);
      return recordingExecutor(owner);
    },
    advertisements: ads,
  });
  const response = await proxy.handleRequest(request);
  const body: unknown = await response.json();
  const servedBy = defaultCalls.length > 0 ? "default" : (acquired.at(-1) ?? "unrouted");
  return { status: response.status, servedBy, acquired, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(body: unknown): unknown {
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  return isRecord(error) ? error["code"] : undefined;
}

async function legacyCapProbe(
  s: Scenario,
  request: Request,
): Promise<{ status: number; servedBy: string }> {
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  openaiProxy.__setOpenAIProxyClusterRoutingForTests({
    clusterPeers: s.peers,
    peerSnapshots: s.peerSnapshots,
  });
  const response = await openaiProxy.proxyOpenAI(request, s.resolved);
  const status = response.status;
  if (recordedChat(fx().defaultEngine.records)) return { status, servedBy: "default" };
  for (const id of PEER_IDS) {
    if (recordedChat(peerEngine(id).records)) return { status, servedBy: id };
  }
  return { status, servedBy: "unrouted" };
}

type CapExpected = { kind: "served"; by: string } | { kind: "rejected"; code: string };

function capExpected(cap: Record<string, CapSpec>): CapExpected {
  const stableAll = capPeersWith(cap, false, true).concat(capPeersWith(cap, false, false));
  const stableTools = capPeersWith(cap, false, true);
  if (stableAll.length > 0) {
    return stableTools.length > 0
      ? { kind: "served", by: stableTools[0] ?? "none" }
      : { kind: "rejected", code: "unsupported-tools" };
  }
  const expAll = capPeersWith(cap, true, true).concat(capPeersWith(cap, true, false));
  if (expAll.length === 0) return { kind: "served", by: "default" };
  const expTools = capPeersWith(cap, true, true);
  return expTools.length > 0
    ? { kind: "served", by: expTools[0] ?? "none" }
    : { kind: "rejected", code: "unsupported-tools" };
}

function assertCapInvariant(o: CapOutcome, cap: Record<string, CapSpec>, ctx: string): void {
  const expected = capExpected(cap);
  if (expected.kind === "rejected") {
    expect(o.status, `${ctx}: cap rejection status`).toBe(400);
    expect(errorCode(o.body), `${ctx}: cap rejection code`).toBe(expected.code);
    expect(o.acquired.length, `${ctx}: nothing acquired on rejection`).toBe(0);
    expect(o.servedBy, `${ctx}: servedBy on rejection`).toBe("unrouted");
    return;
  }
  expect(o.status, `${ctx}: served status`).toBe(200);
  expect(o.servedBy, `${ctx}: servedBy`).toBe(expected.by);
  const expPeers = new Set(capPeersWith(cap, true, true).concat(capPeersWith(cap, true, false)));
  const stableAll = capPeersWith(cap, false, true).concat(capPeersWith(cap, false, false));
  for (const peer of o.acquired) {
    const forbidden = expPeers.has(peer) && stableAll.length > 0;
    expect(forbidden, `${ctx}: experimental ${peer} served behind a stable candidate`).toBe(false);
  }
}

function recordedChat(records: readonly EngineRecord[]): boolean {
  return records.some((record) => {
    try {
      return new URL(record.url).pathname === "/v1/chat/completions";
    } catch {
      return false;
    }
  });
}

async function legacyServedBy(s: Scenario, model: string): Promise<string> {
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  openaiProxy.__setOpenAIProxyClusterRoutingForTests({
    clusterPeers: s.peers,
    peerSnapshots: s.peerSnapshots,
  });
  const response = await openaiProxy.proxyOpenAI(chatReq(model), s.resolved);
  expect(response.status).toBe(200);
  if (recordedChat(fx().defaultEngine.records)) return "default";
  for (const id of PEER_IDS) {
    if (recordedChat(peerEngine(id).records)) return id;
  }
  return "unrouted";
}

function clearRecords(): void {
  fx().defaultEngine.records.length = 0;
  for (const id of PEER_IDS) {
    peerEngine(id).records.length = 0;
  }
}

interface RoutingExpectation {
  stable: string[];
  exp: string[];
  isDefault: boolean;
  ctx: string;
}

function assertRoutingInvariant(
  legacy: string,
  outcome: UnifiedOutcome,
  e: RoutingExpectation,
): void {
  const { stable, exp, isDefault, ctx } = e;
  if (stable.length > 0) {
    expect(stable.includes(legacy), `${ctx}: legacy servedBy ${legacy}`).toBe(true);
    expect(stable.includes(outcome.servedBy), `${ctx}: unified servedBy ${outcome.servedBy}`).toBe(
      true,
    );
  } else if (isDefault) {
    expect(legacy, `${ctx}: legacy servedBy`).toBe("default");
    expect(outcome.servedBy, `${ctx}: unified servedBy`).toBe("default");
    expect(outcome.defaultCalls.length, `${ctx}: unified default calls`).toBeGreaterThan(0);
  } else {
    expect(exp.includes(legacy), `${ctx}: legacy servedBy ${legacy}`).toBe(true);
    expect(exp.includes(outcome.servedBy), `${ctx}: unified servedBy ${outcome.servedBy}`).toBe(
      true,
    );
  }
  expect(outcome.servedBy, `${ctx}: unified ${outcome.servedBy} vs legacy ${legacy}`).toBe(legacy);
}

function assertModelsMarker(
  byId: Map<string, Record<string, unknown>>,
  id: string,
  e: RoutingExpectation,
): void {
  const { stable, exp, isDefault, ctx } = e;
  if (stable.length + exp.length === 0) return;
  const entry = byId.get(id);
  if (stable.length > 0) {
    expect(entry, `${ctx}: entry expected`).toBeDefined();
    expect(entry !== undefined && "experimental" in entry, `${ctx}: marker absent`).toBe(false);
  } else if (isDefault) {
    expect(entry, `${ctx}: no entry expected`).toBeUndefined();
  } else {
    expect(entry?.["experimental"], `${ctx}: experimental marker`).toBe(true);
  }
}

function assertUnifiedMarkerAgreement(
  catalog: routingCatalog.RouteCatalog,
  byId: Map<string, Record<string, unknown>>,
  id: string,
  e: RoutingExpectation,
): void {
  const { stable, exp, isDefault, ctx } = e;
  const candidates = routingCatalog.catalogCandidatesFor(catalog, id);
  const hasStable = candidates.some(
    (candidate) => !routingCatalog.isExperimentalAdvertisement(candidate.advertisement),
  );
  const entry = byId.get(id);
  if (stable.length > 0) {
    expect(candidates.length, `${ctx}: unified candidate`).toBeGreaterThan(0);
    expect(hasStable, `${ctx}: unified stable marker`).toBe(true);
    expect(entry?.["experimental"] === true, `${ctx}: legacy marker`).toBe(false);
  } else if (exp.length > 0) {
    expect(hasStable, `${ctx}: unified marks experimental-only`).toBe(false);
    if (isDefault) {
      // Known documented divergence: the unified catalog keeps the
      // experimental candidate for a default-target id while /v1/models
      // drops the id entirely (buildRouteCatalog default-id rule). Routing
      // still agrees: both paths serve the default endpoint.
      expect(entry, `${ctx}: legacy entry dropped`).toBeUndefined();
    } else {
      expect(candidates.length, `${ctx}: unified candidate`).toBeGreaterThan(0);
      expect(entry?.["experimental"], `${ctx}: legacy marker`).toBe(true);
    }
  } else {
    expect(candidates.length, `${ctx}: unified no candidate`).toBe(0);
  }
}

beforeAll(() => {
  const sandbox = mkdtempSync(join(tmpdir(), "llamactl-exp-invariant-"));
  const runtimeDir = join(sandbox, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const relocatedDir = join(sandbox, "relocated");
  mkdirSync(relocatedDir, { recursive: true });
  const catalogFile = join(relocatedDir, "custom-catalog.tsv");
  writeFileSync(catalogFile, EXPERIMENTAL_CATALOG_TSV);
  const peerEngines: Record<string, FakeEngine> = {};
  for (const id of PEER_IDS) {
    peerEngines[id] = startEngine();
  }
  fixture = {
    sandbox,
    runtimeDir,
    catalogFile,
    defaultEngine: startEngine(),
    peerEngines,
  };
});

afterEach(() => {
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  if (fixture === undefined) return;
  fixture.defaultEngine.records.length = 0;
  for (const id of PEER_IDS) {
    const engine = fixture.peerEngines[id];
    if (engine !== undefined) engine.records.length = 0;
  }
});

afterAll(async () => {
  try {
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
    if (fixture === undefined) return;
    await fixture.defaultEngine.stop();
    for (const id of PEER_IDS) {
      const engine = fixture.peerEngines[id];
      if (engine !== undefined) await engine.stop();
    }
    rmSync(fixture.sandbox, { recursive: true, force: true });
  } finally {
    fixture = undefined;
  }
});

describe("experimental route exclusion invariants, legacy vs unified (G-1, #285)", () => {
  for (let i = 0; i < N_CASES; i += 1) {
    test(`case ${String(i)} seed ${String(SEED)}`, async () => {
      const c = cases[i];
      if (c === undefined) throw new Error(`case ${String(i)} not generated`);
      const s = scenarioFor(c);
      const defaultId = defaultIdOf(c);

      for (const id of MODEL_POOL) {
        const stable = stablePeersOf(c, id);
        const exp = expPeersOf(c, id);
        const isDefault = defaultId === id;
        if (stable.length === 0 && exp.length === 0 && !isDefault) continue;
        const ctx = `seed=${String(SEED)} case=${String(i)} model=${id} stable=[${stable.join(",")}] exp=[${exp.join(",")}] default=${defaultId ?? "(none)"}`;
        clearRecords();
        const legacy = await legacyServedBy(s, id);
        const outcome = await unifiedServe(s, id);
        assertRoutingInvariant(legacy, outcome, { stable, exp, isDefault, ctx });
      }

      openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
      openaiProxy.__setOpenAIProxyClusterRoutingForTests({
        clusterPeers: s.peers,
        peerSnapshots: s.peerSnapshots,
      });
      const models = openaiProxy.listOpenAIModels(s.resolved);
      const byId = new Map<string, Record<string, unknown>>(
        models.data.map((m) => {
          const entry: Record<string, unknown> = { ...m };
          return [m.id, entry] as const;
        }),
      );
      const modelsProxy = createProxy({
        env: { LLAMACTL_UNIFIED_PROXY: "1" },
        resolved: () => s.resolved,
        peers: s.peers,
        peerSnapshots: s.peerSnapshots,
        executor: recordingExecutor("models-default"),
      });
      const unifiedCatalog = await modelsProxy.shadowCatalog();
      for (const id of MODEL_POOL) {
        const stable = stablePeersOf(c, id);
        const exp = expPeersOf(c, id);
        const ctx = `seed=${String(SEED)} case=${String(i)} model=${id} /v1/models`;
        assertModelsMarker(byId, id, { stable, exp, isDefault: defaultId === id, ctx });
        assertUnifiedMarkerAgreement(unifiedCatalog, byId, id, {
          stable,
          exp,
          isDefault: defaultId === id,
          ctx,
        });
      }

      const ctxCap = `seed=${String(SEED)} case=${String(i)} model=${CAP_ALIAS} cap=[${capSummary(c.capByPeer)}]`;
      clearRecords();
      const capOutcome = await unifiedCapServe(
        s,
        capAdvertisementsFor(c.capByPeer),
        chatReq(CAP_ALIAS, TOOLS_BODY),
      );
      assertCapInvariant(capOutcome, c.capByPeer, ctxCap);
      clearRecords();
      const legacyCap = await legacyCapProbe(s, chatReq(CAP_ALIAS, TOOLS_BODY));
      expect(
        PEER_IDS.includes(legacyCap.servedBy),
        `${ctxCap}: legacy served ${legacyCap.servedBy}`,
      ).toBe(false);
      expect(
        [200, 404].includes(legacyCap.status),
        `${ctxCap}: legacy status ${String(legacyCap.status)}`,
      ).toBe(true);
    });
  }
});

describe("stable-lacks-capability guard over experimental, unified + legacy (#285)", () => {
  // selectCatalogCandidates keeps a pinned model's experimental candidates
  // only while no stable candidate exists (the `!hasStable` clause). Remove
  // that clause and peer-b below becomes eligible for the capability filter,
  // passes it, and gatedExecute acquires it — flipping every assertion here
  // from green to red.
  function targetedScenario(): Scenario {
    return { resolved: resolvedFor({}), peers: peersFor(), peerSnapshots: new Map() };
  }

  test("pinned tools request with a no-tools stable + tools experimental advertisement: 400, never the experimental peer", async () => {
    const s = targetedScenario();
    const ads = [
      capAdvertisement("peer-a", fullCapabilities({ tools: false })),
      capAdvertisement("peer-b", fullCapabilities(), {
        qualification: { stage: "experimental" },
      }),
    ];
    clearRecords();
    const outcome = await unifiedCapServe(s, ads, chatReq(CAP_ALIAS, TOOLS_BODY));
    expect(outcome.status).toBe(400);
    expect(errorCode(outcome.body)).toBe("unsupported-tools");
    expect(outcome.acquired).toEqual([]);
  });

  test("pinned vision request with a text-only stable + full experimental advertisement: 400, never the experimental peer", async () => {
    const s = targetedScenario();
    const ads = [
      capAdvertisement("peer-a", fullCapabilities({ modalities: ["text"] })),
      capAdvertisement("peer-b", fullCapabilities(), {
        qualification: { stage: "experimental" },
      }),
    ];
    clearRecords();
    const outcome = await unifiedCapServe(s, ads, chatReq(CAP_ALIAS, IMAGE_BODY));
    expect(outcome.status).toBe(400);
    expect(errorCode(outcome.body)).toBe("unsupported-modality");
    expect(outcome.acquired).toEqual([]);
  });

  test("control: an experimental-only pin is served when it holds the capability", async () => {
    const s = targetedScenario();
    const ads = [
      capAdvertisement("peer-b", fullCapabilities(), {
        qualification: { stage: "experimental" },
      }),
    ];
    clearRecords();
    const outcome = await unifiedCapServe(s, ads, chatReq(CAP_ALIAS, TOOLS_BODY));
    expect(outcome.status).toBe(200);
    expect(outcome.servedBy).toBe("peer-b");
    expect(outcome.acquired).toEqual(["peer-b"]);
  });

  test("control: the first stable candidate holding the capability wins, even listed after a no-tools stable", async () => {
    const s = targetedScenario();
    const ads = [
      capAdvertisement("peer-a", fullCapabilities({ tools: false })),
      capAdvertisement("peer-b", fullCapabilities()),
      capAdvertisement("peer-c", fullCapabilities(), {
        qualification: { stage: "experimental" },
      }),
    ];
    clearRecords();
    const outcome = await unifiedCapServe(s, ads, chatReq(CAP_ALIAS, TOOLS_BODY));
    expect(outcome.status).toBe(200);
    expect(outcome.servedBy).toBe("peer-b");
    expect(outcome.acquired).toEqual(["peer-b"]);
  });

  test("legacy: a tools request for a stable+experimental split id goes to the stable peer only", async () => {
    const s: Scenario = {
      resolved: resolvedFor({}),
      peers: peersFor(),
      peerSnapshots: peerSnapshotsFor({
        "peer-a": [{ modelId: CAP_ALIAS }],
        "peer-b": [{ modelId: CAP_ALIAS, labels: { [QUALIFICATION_LABEL]: "experimental" } }],
      }),
    };
    clearRecords();
    const servedBy = await legacyServedBy(s, CAP_ALIAS);
    expect(servedBy).toBe("peer-a");
    expect(recordedChat(peerEngine("peer-b").records)).toBe(false);
  });
});
