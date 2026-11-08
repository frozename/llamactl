import type { PeerNode } from "@llamactl/core/config/peers";
import type { ResolvedEnv } from "@llamactl/core/types";
import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { openaiProxy, routingCapabilities } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
/**
 * #518 B-4b — experimental exclusion on the unified production proxy
 * (create-proxy.ts). The legacy path already qualifies peer routes from the
 * custom catalog, orders stable deployments first, drops experimental
 * default-target ids and flags /v1/models; these pins hold the unified
 * shadow catalog to the same observable routing until the fix lands.
 */
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

interface EngineRecord {
  url: string;
  body: unknown;
}

interface FakeEngine {
  port: number;
  records: EngineRecord[];
  stop: () => Promise<void>;
}

interface Scenario {
  resolved: ResolvedEnv;
  peers: PeerNode[];
  peerSnapshots: Map<string, PeerSnapshot>;
}

interface Fixture {
  sandbox: string;
  runtimeDir: string;
  catalogFile: string;
  defaultEngine: FakeEngine;
  peerExpEngine: FakeEngine;
  peerStableEngine: FakeEngine;
}

let fixture: Fixture | undefined;

function fx(): Fixture {
  if (fixture === undefined) throw new Error("experimental-exclusion fixture not started");
  return fixture;
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

const scenarioA = (): Scenario => ({
  resolved: resolvedFor({ LLAMA_CPP_SERVER_ALIAS: "default-alias" }),
  peers: [peerNode("peer-exp", fx().peerExpEngine.port)],
  peerSnapshots: peerSnapshotsFor({
    "peer-exp": [{ modelId: "default-alias", labels: { [QUALIFICATION_LABEL]: "experimental" } }],
  }),
});

const scenarioB = (): Scenario => ({
  resolved: resolvedFor({ LLAMA_CPP_DEFAULT_MODEL: "exp/model.gguf" }),
  peers: [peerNode("peer-exp", fx().peerExpEngine.port)],
  peerSnapshots: peerSnapshotsFor({ "peer-exp": [{ modelId: "exp/model.gguf" }] }),
});

const scenarioC = (): Scenario => ({
  resolved: resolvedFor({}),
  peers: [
    peerNode("peer-exp", fx().peerExpEngine.port),
    peerNode("peer-stable", fx().peerStableEngine.port),
  ],
  peerSnapshots: peerSnapshotsFor({
    "peer-exp": [{ modelId: "exp/model.gguf" }],
    "peer-stable": [{ modelId: "exp/model.gguf", labels: { [QUALIFICATION_LABEL]: "production" } }],
  }),
});

const scenarioD = (): Scenario => ({
  resolved: resolvedFor({}),
  peers: [
    peerNode("peer-exp", fx().peerExpEngine.port),
    peerNode("peer-stable", fx().peerStableEngine.port),
  ],
  peerSnapshots: peerSnapshotsFor({
    "peer-exp": [{ modelId: "exp/model.gguf" }],
    "peer-stable": [{ modelId: "stable/model.gguf" }],
  }),
});

const scenarioF = (): Scenario => ({
  resolved: resolvedFor({ LLAMA_CPP_SERVER_ALIAS: "stable/model.gguf" }),
  peers: [peerNode("peer-stable", fx().peerStableEngine.port)],
  peerSnapshots: peerSnapshotsFor({ "peer-stable": [{ modelId: "stable/model.gguf" }] }),
});

function chatReq(body: Record<string, unknown>): Request {
  return new Request("http://agent.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

async function unifiedServedBy(
  scenario: () => Scenario,
  body: Record<string, unknown>,
  acquired: string[] = [],
): Promise<string> {
  const s = scenario();
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    resolved: () => s.resolved,
    peers: s.peers,
    peerSnapshots: s.peerSnapshots,
    executor: recordingExecutor("default"),
    acquireExecutor: (candidate) => {
      const owner = candidate.advertisement.ownerNodeId;
      acquired.push(owner);
      return recordingExecutor(owner);
    },
  });
  await proxy.handleRequest(chatReq(body));
  return acquired.at(-1) ?? "default";
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

async function legacyServedBy(
  scenario: () => Scenario,
  body: Record<string, unknown>,
): Promise<string> {
  const s = scenario();
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  openaiProxy.__setOpenAIProxyClusterRoutingForTests({
    clusterPeers: s.peers,
    peerSnapshots: s.peerSnapshots,
  });
  await openaiProxy.proxyOpenAI(chatReq(body), s.resolved);
  const f = fx();
  if (recordedChat(f.defaultEngine.records)) return "default";
  if (recordedChat(f.peerExpEngine.records)) return "peer-exp";
  if (recordedChat(f.peerStableEngine.records)) return "peer-stable";
  return "unrouted";
}

beforeAll(() => {
  const sandbox = mkdtempSync(join(tmpdir(), "llamactl-exp-exclusion-"));
  const runtimeDir = join(sandbox, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const relocatedDir = join(sandbox, "relocated");
  mkdirSync(relocatedDir, { recursive: true });
  const catalogFile = join(relocatedDir, "custom-catalog.tsv");
  writeFileSync(catalogFile, EXPERIMENTAL_CATALOG_TSV);
  fixture = {
    sandbox,
    runtimeDir,
    catalogFile,
    defaultEngine: startEngine(),
    peerExpEngine: startEngine(),
    peerStableEngine: startEngine(),
  };
});

afterEach(() => {
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  if (fixture === undefined) return;
  fixture.defaultEngine.records.length = 0;
  fixture.peerExpEngine.records.length = 0;
  fixture.peerStableEngine.records.length = 0;
});

afterAll(async () => {
  try {
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
    if (fixture === undefined) return;
    await fixture.defaultEngine.stop();
    await fixture.peerExpEngine.stop();
    await fixture.peerStableEngine.stop();
    rmSync(fixture.sandbox, { recursive: true, force: true });
  } finally {
    fixture = undefined;
  }
});

describe("unified proxy experimental exclusion (#518)", () => {
  test("an experimental peer never captures a default-target id", async () => {
    const acquired: string[] = [];
    const servedBy = await unifiedServedBy(scenarioA, { model: "default-alias" }, acquired);
    expect(servedBy).toBe("default");
    expect(acquired).not.toContain("peer-exp");
  });

  test("a catalog-experimental peer (relocated LOCAL_AI_CUSTOM_CATALOG_FILE) never captures the default model", async () => {
    expect(await unifiedServedBy(scenarioB, { model: "exp/model.gguf" })).toBe("default");
  });

  test("an experimental replica never wins a shared id over a stable replica", async () => {
    expect(await unifiedServedBy(scenarioC, { model: "exp/model.gguf" })).toBe("peer-stable");
  });

  test("an exact pin still reaches the experimental peer", async () => {
    expect(await unifiedServedBy(scenarioD, { model: "exp/model.gguf" })).toBe("peer-exp");
  });

  test("the unified catalog flags the experimental peer deployment", async () => {
    const s = scenarioD();
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => s.resolved,
      peers: s.peers,
      peerSnapshots: s.peerSnapshots,
      executor: recordingExecutor("default"),
    });
    const catalog = await proxy.shadowCatalog();
    const expDeployment = catalog.deployments.find((d) => d.ownerNodeId === "peer-exp");
    const stableDeployment = catalog.deployments.find((d) => d.ownerNodeId === "peer-stable");
    expect(expDeployment?.qualification?.stage).toBe("experimental");
    expect(stableDeployment?.qualification?.stage).not.toBe("experimental");
  });

  test("/v1/models flags the experimental model (served by listOpenAIModels, not the unified proxy)", () => {
    const s = scenarioD();
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: s.peers,
      peerSnapshots: s.peerSnapshots,
    });
    const models = openaiProxy.listOpenAIModels(s.resolved);
    const byId = new Map(models.data.map((m) => [m.id, m as unknown as Record<string, unknown>]));
    expect(byId.get("exp/model.gguf")?.["experimental"]).toBe(true);
    expect("experimental" in (byId.get("stable/model.gguf") ?? {})).toBe(false);
  });

  test("a stable default-target peer is still served by that peer", async () => {
    expect(await unifiedServedBy(scenarioF, { model: "stable/model.gguf" })).toBe("peer-stable");
  });
});

describe("experimental exclusion parity, legacy vs unified (#518)", () => {
  const cases: {
    name: string;
    scenario: () => Scenario;
    model: string;
    expected: string;
  }[] = [
    {
      name: "default-label",
      scenario: scenarioA,
      model: "default-alias",
      expected: "default",
    },
    {
      name: "default-catalog",
      scenario: scenarioB,
      model: "exp/model.gguf",
      expected: "default",
    },
    {
      name: "replica/alias",
      scenario: scenarioC,
      model: "exp/model.gguf",
      expected: "peer-stable",
    },
    {
      name: "exact pin",
      scenario: scenarioD,
      model: "exp/model.gguf",
      expected: "peer-exp",
    },
    {
      name: "stable default guard",
      scenario: scenarioF,
      model: "stable/model.gguf",
      expected: "peer-stable",
    },
  ];

  for (const { name, scenario, model, expected } of cases) {
    test(`${name}: legacy and unified agree on '${expected}'`, async () => {
      expect(await legacyServedBy(scenario, { model })).toBe(expected);
      expect(await unifiedServedBy(scenario, { model })).toBe(expected);
    });
  }
});
