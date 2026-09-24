import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
/**
 * P0.2 (#130) — production dispatch wiring for LLAMACTL_UNIFIED_PROXY.
 * Runs the same makeCluster fixture the P0.1 characterization suite
 * uses: flag unset/"0" must serve byte-identical legacy results, and
 * flag "1" must be observable through BOTH production ingresses —
 * serve.ts /v1 proxying (agent.handleRequest) and the router.ts
 * chatComplete local short-circuit. The capability-rejection and
 * marker-executor cases are the non-vacuity evidence that the flag
 * reaches the serving process: only the composed path produces them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config as kubecfg } from "../src/index.js";
import {
  __setSharedUnifiedProxyForTests,
  type BackendExecutor,
  createProxy,
} from "../src/proxy/create-proxy.js";
import { router as appRouter } from "../src/router.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { type Cluster, makeCluster } from "./helpers.js";

const ENV_KEYS = [
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMACTL_UNIFIED_PROXY",
] as const;

let cluster: Cluster | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let upstreamCalls: Record<string, unknown>[] = [];
let resolved: ResolvedEnv;
let bearer: string;
let envBackup: Record<string, string | undefined> = {};
let sandbox: string | undefined;

function writeLlamaServerWorkload(runtimeRoot: string, workload: string, port: number): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: "via-local/model.gguf",
      extraArgs: [],
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-09-23T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

function agentPost(path: string, body: Record<string, unknown>): Promise<Response> {
  const agent = cluster?.nodes[0]?.agent;
  if (!agent?.handleRequest) throw new Error("handleRequest unavailable");
  return agent.handleRequest(
    new Request(`${agent.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

interface Snapshot {
  status: number;
  body: string;
}

async function snap(res: Response): Promise<Snapshot> {
  return { status: res.status, body: await res.text() };
}

function narrowCapsAd(publicModelId: string): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/${publicModelId}`,
    deploymentId: `deploy/${publicModelId}`,
    backendId: `backend/${publicModelId}`,
    ownerNodeId: "ext-1",
    publicModelIds: [publicModelId],
    upstreamModelId: publicModelId,
    backendKind: "cloud-api",
    transport: "cloud-direct",
    endpoint: "https://api.invalid/v1",
    capabilities: routingCapabilities.RouteCapabilitiesSchema.parse({
      operations: ["generate", "embed", "count-tokens"],
      protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
      streaming: "sse",
      modalities: ["text"],
      tools: false,
      structuredOutput: false,
      tokenCounting: true,
      cancellation: true,
      sessions: false,
    }),
    modelRevision: routingCatalog.knownRevision("rev-1"),
    deploymentEpoch: routingCatalog.knownRevision("epoch-1"),
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
  };
}

function markerExecutor(marker: string): BackendExecutor {
  return {
    describe: () => ({ id: "marker-executor", backendKinds: [], transports: [] }),
    execute: () =>
      Promise.resolve(
        Response.json({
          id: "chatcmpl-marker",
          object: "chat.completion",
          model: "via-local/model.gguf",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: marker },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          marker,
        }),
      ),
    cancel: () => false,
    drain: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

beforeAll(async () => {
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  sandbox = mkdtempSync(join(tmpdir(), "llamactl-unified-dispatch-"));
  const runtimeDir = join(sandbox, "runtime");
  process.env["DEV_STORAGE"] = join(sandbox, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = "1";
  Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
  resolved = resolveEnv({
    DEV_STORAGE: join(sandbox, "dev-storage"),
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: "1",
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "/tmp",
  });

  upstreamCalls = [];
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      let body: Record<string, unknown> | null = null;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      upstreamCalls.push(body ?? {});
      if (req.method === "POST" && new URL(req.url).pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-dispatch",
          object: "chat.completion",
          model: body?.["model"] ?? "fixture-model",
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

  cluster = await makeCluster({ nodes: 1 });
  const cfg = kubecfg.loadConfig(cluster.clusterConfigPath);
  bearer = cfg.users.find((u) => u.name === "me")?.token ?? "";
  if (!bearer) throw new Error("cluster kubeconfig has no 'me' user token");
  process.env["LLAMACTL_CONFIG"] = cluster.clusterConfigPath;

  writeLlamaServerWorkload(runtimeDir, "wl-serve", upstream.port ?? 0);
});

afterEach(() => {
  Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
  __setSharedUnifiedProxyForTests(null);
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

afterAll(async () => {
  try {
    __setSharedUnifiedProxyForTests(null);
    try {
      if (cluster !== undefined) await cluster.cleanup();
    } finally {
      if (upstream !== undefined) await upstream.stop(true);
      if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true });
    }
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
  }
});

describe("serve.ts /v1 dispatch", () => {
  const body = {
    model: "via-local/model.gguf",
    messages: [{ role: "user", content: "hi" }],
  };

  test("flag unset: the served response is byte-identical to the legacy call", async () => {
    const served = await snap(await agentPost("/v1/chat/completions", body));
    const legacy = await snap(
      await openaiProxy.proxyOpenAI(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        resolved,
      ),
    );
    expect(served).toEqual(legacy);
    expect(served.status).toBe(200);
  });

  test("flag '0': rollback path is byte-identical", async () => {
    process.env["LLAMACTL_UNIFIED_PROXY"] = "0";
    const served = await snap(await agentPost("/v1/chat/completions", body));
    const legacy = await snap(
      await openaiProxy.proxyOpenAI(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        resolved,
      ),
    );
    expect(served).toEqual(legacy);
    expect(served.status).toBe(200);
  });

  test("flag '1': the default shared composition serves the local workload", async () => {
    process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
    const served = await snap(await agentPost("/v1/chat/completions", body));
    expect(served.status).toBe(200);
    const parsed = JSON.parse(served.body) as { choices: { message: { content: string } }[] };
    expect(parsed.choices[0]?.message.content).toBe("fixture reply");
    expect(upstreamCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("flag '1' is observable: a narrow-capability advertisement rejects what legacy serves", async () => {
    // Non-vacuity: the same request returns 502 on the legacy path
    // (unrouted model, closed llama-server port) but 400 through the
    // composed gate — a status only the unified seam can produce.
    const catalog = routingCatalog.buildRouteCatalog({ routes: [], nodeId: "node1" });
    expect(
      routingCatalog.addCatalogAdvertisement(catalog, narrowCapsAd("blocked-model")).accepted,
    ).toBe(true);
    __setSharedUnifiedProxyForTests(
      createProxy({ env: { LLAMACTL_UNIFIED_PROXY: "1" }, catalog: () => catalog }),
    );
    const toolsBody = {
      model: "blocked-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    };
    process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
    const composed = await agentPost("/v1/chat/completions", toolsBody);
    expect(composed.status).toBe(400);
    const parsed = (await composed.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("unsupported-tools");

    process.env["LLAMACTL_UNIFIED_PROXY"] = "0";
    const legacy = await agentPost("/v1/chat/completions", toolsBody);
    expect(legacy.status).toBe(502);
  });
});

describe("router.ts chatComplete local dispatch", () => {
  const request = {
    model: "via-local/model.gguf",
    messages: [{ role: "user", content: "hi" }],
  };

  test("flag '1' is observable through chatComplete: the shared executor's marker surfaces", async () => {
    __setSharedUnifiedProxyForTests(
      createProxy({
        env: { LLAMACTL_UNIFIED_PROXY: "1" },
        resolved: () => resolved,
        acquireExecutor: () => markerExecutor("unified-marker"),
      }),
    );
    const caller = appRouter.createCaller({});

    process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
    const composed = (await caller.chatComplete({ node: "local", request })) as unknown as {
      marker?: string;
    };
    expect(composed.marker).toBe("unified-marker");

    process.env["LLAMACTL_UNIFIED_PROXY"] = "0";
    const legacy = (await caller.chatComplete({ node: "local", request })) as {
      choices: { message: { content: string } }[];
    };
    expect(legacy.choices[0]?.message.content).toBe("fixture reply");
  });
});
