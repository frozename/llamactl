import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
/**
 * P0.2 (#130) — LLAMACTL_UNIFIED_PROXY composition gate.
 * Proves: the flag is off by default and behavior is unchanged; with it
 * on, local and peer requests flow createProxy → legacy-local-executor
 * with identical observable results; capability filtering runs before
 * any credential resolution or execution acquisition; and the shadow
 * catalog performs no upstream calls while carrying no secrets.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema, config as kubecfg } from "../src/index.js";
import {
  type BackendExecutor,
  type BackendExecutorDescription,
  createProxy,
  publishUnifiedPeerSnapshots,
  unifiedProxyEnabled,
} from "../src/proxy/create-proxy.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

interface FixtureCall {
  url: string;
  method: string;
  authorization: string | null;
  anthropicVersion: string | null;
  body: Record<string, unknown> | null;
}

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMACTL_CONFIG",
  "LLAMACTL_PEER_TOKEN_PROBE",
] as const;

let sandbox = "";
let resolved: ResolvedEnv;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let peer: ReturnType<typeof Bun.serve> | undefined;
let upstreamCalls: FixtureCall[];
let peerCalls: FixtureCall[];
let envBackup: Record<string, string | undefined> = {};

function fixtureHandler(calls: FixtureCall[]): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let body: Record<string, unknown> | null = null;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    calls.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.get("authorization"),
      anthropicVersion: req.headers.get("anthropic-version"),
      body,
    });
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (body?.["stream"] === true) {
        const sse =
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"he"},"finish_reason":null}]}\n\n' +
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n";
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "chatcmpl-fixture",
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
    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      const inputs = Array.isArray(body?.["input"]) ? body["input"].length : 1;
      return Response.json({
        object: "list",
        model: body?.["model"] ?? "fixture-model",
        data: Array.from({ length: inputs }, (_, i) => ({
          object: "embedding",
          index: i,
          embedding: [0.1, 0.2, 0.3],
        })),
        usage: { prompt_tokens: 2, total_tokens: 2 },
      });
    }
    if (req.method === "POST" && url.pathname === "/tokenize") {
      return Response.json({ tokens: [1, 2, 3] });
    }
    return new Response("not found", { status: 404 });
  };
}

function writeLlamaServerWorkload(runtimeRoot: string, workload: string, port: number): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: "via-local/model.gguf",
      extraArgs: ["--alias", "wl-alias"],
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-09-23T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

function chatReq(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://agent.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function anthropicReq(body: Record<string, unknown>): Request {
  return new Request("http://agent.test/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-ant-client",
    },
    body: JSON.stringify(body),
  });
}

function responsesReq(body: Record<string, unknown>): Request {
  return new Request("http://agent.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function embedReq(body: Record<string, unknown>): Request {
  return new Request("http://agent.test/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tokenizeReq(body: Record<string, unknown>): Request {
  return new Request("http://agent.test/tokenize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Snapshot {
  status: number;
  contentType: string | null;
  body: string;
}

async function snap(res: Response): Promise<Snapshot> {
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: await res.text(),
  };
}

function peerRouting(): void {
  const port = peer?.port;
  if (port === undefined) throw new Error("peer fixture not started");
  openaiProxy.__setOpenAIProxyClusterRoutingForTests({
    clusterPeers: [
      {
        id: "peer1",
        endpoint: `http://127.0.0.1:${String(port)}`,
        token: "peer-secret-token",
      },
    ],
    peerSnapshots: new Map([
      [
        "peer1",
        {
          workloads: [{ modelId: "peer-model.gguf", port: 1, revision: "peer-rev-1" }],
          pressure: "NORMAL" as const,
          fetchedAt: Date.now(),
        },
      ],
    ]),
  });
}

function advertisedAd(
  publicModelIds: string[],
  caps: routingCapabilities.RouteCapabilities,
): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/${publicModelIds[0] ?? "x"}`,
    deploymentId: `deploy/${publicModelIds[0] ?? "x"}`,
    backendId: `backend/${publicModelIds[0] ?? "x"}`,
    ownerNodeId: "peer1",
    publicModelIds,
    upstreamModelId: "hf.co/org/ext-model",
    backendKind: "cloud-api",
    transport: "cloud-direct",
    endpoint: "https://api.invalid/v1",
    capabilities: caps,
    modelRevision: routingCatalog.knownRevision("rev-1"),
    deploymentEpoch: routingCatalog.knownRevision("epoch-1"),
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
  };
}

function recordingExecutor(calls: string[]): BackendExecutor {
  return {
    describe: (): BackendExecutorDescription => ({
      id: "recording-executor",
      backendKinds: [],
      transports: [],
    }),
    execute: (): Promise<Response> => {
      calls.push("execute");
      return Promise.resolve(Response.json({ ok: true }));
    },
    cancel: (): boolean => false,
    drain: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };
}

beforeAll(() => {
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  sandbox = mkdtempSync(join(tmpdir(), "llamactl-proxy-composition-"));
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
  const upstreamServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: fixtureHandler(upstreamCalls),
  });
  upstream = upstreamServer;
  peerCalls = [];
  peer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: fixtureHandler(peerCalls) });

  writeLlamaServerWorkload(runtimeDir, "wl-local", upstreamServer.port ?? 0);
});

beforeEach(() => {
  upstreamCalls.length = 0;
  peerCalls.length = 0;
  Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

afterAll(async () => {
  try {
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
    if (upstream !== undefined) await upstream.stop(true);
    if (peer !== undefined) await peer.stop(true);
    rmSync(sandbox, { recursive: true, force: true });
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
  }
});

describe("LLAMACTL_UNIFIED_PROXY gate", () => {
  test("the flag is off by default", () => {
    expect(unifiedProxyEnabled({})).toBe(false);
    expect(unifiedProxyEnabled({ LLAMACTL_UNIFIED_PROXY: "0" })).toBe(false);
    expect(unifiedProxyEnabled({ LLAMACTL_UNIFIED_PROXY: "1" })).toBe(true);
  });

  test("flag unset: handleRequest matches the legacy path and runs no unified machinery", async () => {
    const calls: string[] = [];
    const proxy = createProxy({
      env: {},
      resolved: () => resolved,
      resolveCredentials: () => {
        calls.push("credentials");
        return Promise.resolve();
      },
      acquireExecutor: () => {
        calls.push("acquire");
        return recordingExecutor(calls);
      },
    });
    expect(proxy.unifiedEnabled).toBe(false);
    const body = { model: "via-local/model.gguf", messages: [{ role: "user", content: "hi" }] };
    const composed = await snap(await proxy.handleRequest(chatReq(body)));
    const legacy = await snap(await openaiProxy.proxyOpenAI(chatReq(body), resolved));
    expect(composed).toEqual(legacy);
    expect(composed.status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("flag '0' (rollback): identical to the legacy path", async () => {
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "0" },
      resolved: () => resolved,
    });
    const body = { model: "via-local/model.gguf", messages: [{ role: "user", content: "hi" }] };
    const composed = await snap(await proxy.handleRequest(chatReq(body)));
    const legacy = await snap(await openaiProxy.proxyOpenAI(chatReq(body), resolved));
    expect(composed).toEqual(legacy);
  });
});

describe("unified composition (flag on)", () => {
  const env = { LLAMACTL_UNIFIED_PROXY: "1" };

  test("a local JSON chat request matches the legacy path byte-for-byte", async () => {
    const proxy = createProxy({ env, resolved: () => resolved });
    expect(proxy.unifiedEnabled).toBe(true);
    const body = {
      model: "via-local/model.gguf",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
    };
    const legacy = await snap(await openaiProxy.proxyOpenAI(chatReq(body), resolved));
    const composed = await snap(await proxy.handleRequest(chatReq(body)));
    expect(composed).toEqual(legacy);
    const calls = upstreamCalls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
  });

  test("a streaming request returns the identical SSE body and content-type", async () => {
    const proxy = createProxy({ env, resolved: () => resolved });
    const body = {
      model: "via-local/model.gguf",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.5,
    };
    const legacy = await snap(await openaiProxy.proxyOpenAI(chatReq(body), resolved));
    const composed = await snap(await proxy.handleRequest(chatReq(body)));
    expect(composed).toEqual(legacy);
    expect(composed.contentType).toContain("text/event-stream");
    expect(composed.body).toContain("data: [DONE]");
  });

  test("a peer model request matches the legacy path, bearer included", async () => {
    peerRouting();
    const proxy = createProxy({ env, resolved: () => resolved });
    const body = {
      model: "peer-model.gguf",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
    };
    const legacy = await snap(await openaiProxy.proxyOpenAI(chatReq(body), resolved));
    const composed = await snap(await proxy.handleRequest(chatReq(body)));
    expect(composed).toEqual(legacy);
    const calls = peerCalls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.authorization).toBe("Bearer peer-secret-token");
    expect(calls[1]!.authorization).toBe("Bearer peer-secret-token");
  });

  test("an anthropic /v1/messages request matches the legacy path", async () => {
    const proxy = createProxy({ env, resolved: () => resolved });
    const body = {
      model: "wl-alias",
      messages: [{ role: "user", content: "route me" }],
      max_tokens: 64,
    };
    const legacy = await snap(await openaiProxy.proxyOpenAI(anthropicReq(body), resolved));
    const composed = await snap(await proxy.handleRequest(anthropicReq(body)));
    expect(composed).toEqual(legacy);
    const calls = upstreamCalls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.anthropicVersion).toBe("2023-06-01");
    expect(calls[0]!.body?.["model"]).toBe("wl-alias");
    expect(calls[1]!.body?.["model"]).toBe("wl-alias");
  });

  test("an unknown model keeps the legacy fallback envelope", async () => {
    const proxy = createProxy({ env, resolved: () => resolved });
    const body = { model: "no-such-model", messages: [{ role: "user", content: "hi" }] };
    const legacy = await snap(await openaiProxy.proxyOpenAI(chatReq(body), resolved));
    const composed = await snap(await proxy.handleRequest(chatReq(body)));
    expect(composed).toEqual(legacy);
    expect(composed.status).toBe(502);
    expect(composed.body).toContain("llamactl_upstream_error");
  });
});

describe("capability filtering precedes credentials and execution", () => {
  const env = { LLAMACTL_UNIFIED_PROXY: "1" };
  const toolsBody = {
    model: "blocked-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f", parameters: {} } }],
  };

  test("a request needing unsupported tools is rejected before credentials or execution", async () => {
    const calls: string[] = [];
    const catalog = routingCatalog.buildRouteCatalog({ routes: [], nodeId: "node1" });
    const accepted = routingCatalog.addCatalogAdvertisement(
      catalog,
      advertisedAd(
        ["blocked-model"],
        routingCapabilities.RouteCapabilitiesSchema.parse({
          operations: ["generate"],
          protocols: ["openai-chat"],
          streaming: "sse",
          modalities: ["text"],
          tools: false,
          structuredOutput: false,
          tokenCounting: false,
          cancellation: true,
          sessions: false,
        }),
      ),
    );
    expect(accepted.accepted).toBe(true);
    const proxy = createProxy({
      env,
      resolved: () => resolved,
      catalog: () => catalog,
      resolveCredentials: () => {
        calls.push("credentials");
        return Promise.resolve();
      },
      acquireExecutor: () => {
        calls.push("acquire");
        return recordingExecutor(calls);
      },
    });
    const res = await proxy.handleRequest(chatReq(toolsBody));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("unsupported-tools");
    expect(calls).toEqual([]);
    expect(upstreamCalls).toHaveLength(0);
  });

  test("an eligible candidate resolves credentials, acquires, then executes in order", async () => {
    const calls: string[] = [];
    const catalog = routingCatalog.buildRouteCatalog({ routes: [], nodeId: "node1" });
    routingCatalog.addCatalogAdvertisement(
      catalog,
      advertisedAd(
        ["blocked-model"],
        routingCapabilities.RouteCapabilitiesSchema.parse({
          operations: ["generate"],
          protocols: ["openai-chat"],
          streaming: "sse",
          modalities: ["text"],
          tools: true,
          structuredOutput: false,
          tokenCounting: false,
          cancellation: true,
          sessions: false,
        }),
      ),
    );
    const proxy = createProxy({
      env,
      resolved: () => resolved,
      catalog: () => catalog,
      resolveCredentials: () => {
        calls.push("credentials");
        return Promise.resolve();
      },
      acquireExecutor: () => {
        calls.push("acquire");
        return recordingExecutor(calls);
      },
    });
    const res = await proxy.handleRequest(chatReq(toolsBody));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["credentials", "acquire", "execute"]);
  });
});

describe("protocol x feature equivalence with the legacy passthrough", () => {
  const env = { LLAMACTL_UNIFIED_PROXY: "1" };
  const model = "via-local/model.gguf";
  const chatMessages = [{ role: "user", content: "hi" }];
  const anthropicMessages = [{ role: "user", content: "route me" }];

  // Every ingress protocol x derivable feature combination the legacy
  // passthrough serves: the composed path must never return a different
  // status — a capability gate that rejects what legacy forwards is the
  // HIGH-1 defect.
  const rows: [name: string, make: () => Request][] = [
    ["openai-chat plain", (): Request => chatReq({ model, messages: chatMessages })],
    [
      "openai-chat image part",
      (): Request =>
        chatReq({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this" },
                { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
              ],
            },
          ],
        }),
    ],
    [
      "openai-chat declared audio modality",
      (): Request => chatReq({ model, messages: chatMessages, modalities: ["text", "audio"] }),
    ],
    [
      "openai-chat tools",
      (): Request =>
        chatReq({
          model,
          messages: chatMessages,
          tools: [{ type: "function", function: { name: "f", parameters: {} } }],
        }),
    ],
    [
      "openai-chat required tool_choice",
      (): Request => chatReq({ model, messages: chatMessages, tool_choice: "required" }),
    ],
    [
      "openai-chat json_schema response_format",
      (): Request =>
        chatReq({
          model,
          messages: chatMessages,
          response_format: { type: "json_schema", json_schema: { name: "s", schema: {} } },
        }),
    ],
    ["openai-chat stream", (): Request => chatReq({ model, messages: chatMessages, stream: true })],
    [
      "openai-chat session handle",
      (): Request => chatReq({ model, messages: chatMessages, session_id: "sess-1" }),
    ],
    ["openai-chat empty model", (): Request => chatReq({ model: "", messages: chatMessages })],
    ["openai-chat missing model", (): Request => chatReq({ messages: chatMessages })],
    [
      "openai-chat unrouted model",
      (): Request => chatReq({ model: "no-such-model", messages: chatMessages }),
    ],
    ["openai-responses plain", (): Request => responsesReq({ model, input: "hi" })],
    [
      "openai-responses image+audio+file parts",
      (): Request =>
        responsesReq({
          model,
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "describe" },
                { type: "input_image", image_url: "data:image/png;base64,x" },
                { type: "input_audio", input_audio: { data: "x", format: "wav" } },
                { type: "input_file", file_data: "x", filename: "doc.pdf" },
              ],
            },
          ],
        }),
    ],
    [
      "openai-responses tools",
      (): Request =>
        responsesReq({
          model,
          input: "hi",
          tools: [{ type: "function", name: "f", parameters: {} }],
        }),
    ],
    [
      "openai-responses text.format json_schema",
      (): Request =>
        responsesReq({
          model,
          input: "hi",
          text: { format: { type: "json_schema", name: "s", schema: {} } },
        }),
    ],
    ["openai-responses stream", (): Request => responsesReq({ model, input: "hi", stream: true })],
    [
      "anthropic plain",
      (): Request => anthropicReq({ model, messages: anthropicMessages, max_tokens: 8 }),
    ],
    [
      "anthropic image+document blocks",
      (): Request =>
        anthropicReq({
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aXY=" },
                },
                { type: "document", source: { type: "base64", data: "x" } },
              ],
            },
          ],
          max_tokens: 8,
        }),
    ],
    [
      "anthropic tools",
      (): Request =>
        anthropicReq({
          model,
          messages: anthropicMessages,
          tools: [{ name: "t", input_schema: {} }],
          max_tokens: 8,
        }),
    ],
    [
      "anthropic tool_use blocks",
      (): Request =>
        anthropicReq({
          model,
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }],
            },
          ],
          max_tokens: 8,
        }),
    ],
    [
      "anthropic stream",
      (): Request =>
        anthropicReq({ model, messages: anthropicMessages, stream: true, max_tokens: 8 }),
    ],
    ["embeddings", (): Request => embedReq({ model, input: "hi" })],
    ["count-tokens", (): Request => tokenizeReq({ model, content: "hi" })],
  ];

  for (const [name, make] of rows) {
    test(`${name}: composed status == legacy status`, async () => {
      const proxy = createProxy({ env, resolved: () => resolved });
      const legacy = await openaiProxy.proxyOpenAI(make(), resolved);
      const composed = await proxy.handleRequest(make());
      expect(composed.status).toBe(legacy.status);
      if (composed.status === 400) {
        // A 400 both sides produce is fine (e.g. translation errors);
        // a capability-gate rejection is not.
        expect(await composed.text()).not.toContain("unsupported-");
      }
    });
  }
});

describe("capability rejection shapes", () => {
  const env = { LLAMACTL_UNIFIED_PROXY: "1" };
  const narrowAd = advertisedAd(
    ["blocked-model"],
    routingCapabilities.RouteCapabilitiesSchema.parse({
      operations: ["generate"],
      protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
      streaming: "sse",
      modalities: ["text"],
      tools: false,
      structuredOutput: false,
      tokenCounting: false,
      cancellation: true,
      sessions: false,
    }),
  );

  function narrowCatalog(): routingCatalog.RouteCatalog {
    const catalog = routingCatalog.buildRouteCatalog({ routes: [], nodeId: "node1" });
    expect(routingCatalog.addCatalogAdvertisement(catalog, narrowAd).accepted).toBe(true);
    return catalog;
  }

  const toolsRequest = {
    model: "blocked-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f", parameters: {} } }],
  };

  test("anthropic ingress gets the anthropic error envelope", async () => {
    const catalog = narrowCatalog();
    const proxy = createProxy({ env, resolved: () => resolved, catalog: () => catalog });
    const res = await proxy.handleRequest(anthropicReq({ ...toolsRequest, max_tokens: 8 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("unsupported-tools");
  });

  test("openai ingress keeps the openai error envelope", async () => {
    const catalog = narrowCatalog();
    const proxy = createProxy({ env, resolved: () => resolved, catalog: () => catalog });
    const res = await proxy.handleRequest(chatReq(toolsRequest));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("unsupported-tools");
  });
});

describe("default-path credential and snapshot ordering", () => {
  const env = { LLAMACTL_UNIFIED_PROXY: "1" };
  const probeVar = "LLAMACTL_PEER_TOKEN_PROBE";

  function writePeerKubeconfig(): string {
    const cfgPath = join(sandbox, `peer-kubeconfig-${String(Date.now())}`);
    let cfg = configSchema.freshConfig();
    cfg = {
      ...cfg,
      users: cfg.users.map((u) =>
        u.name === "me" ? { name: u.name, tokenRef: `env:${probeVar}` } : u,
      ),
    };
    cfg = kubecfg.upsertNode(cfg, "home", {
      name: "peer1",
      endpoint: "https://127.0.0.1:9443",
    });
    kubecfg.saveConfig(cfg, cfgPath);
    return cfgPath;
  }

  function countTokenReads(): () => number {
    let reads = 0;
    Object.defineProperty(process.env, probeVar, {
      configurable: true,
      enumerable: true,
      get: (): string => {
        reads += 1;
        return "probe-token";
      },
    });
    return () => reads;
  }

  test("a capability-rejected request resolves no credentials on the default path", async () => {
    process.env["LLAMACTL_CONFIG"] = writePeerKubeconfig();
    const reads = countTokenReads();
    try {
      const narrowAd = advertisedAd(
        ["blocked-model"],
        routingCapabilities.RouteCapabilitiesSchema.parse({
          operations: ["generate"],
          protocols: ["openai-chat"],
          streaming: "sse",
          modalities: ["text"],
          tools: false,
          structuredOutput: false,
          tokenCounting: false,
          cancellation: true,
          sessions: false,
        }),
      );
      const proxy = createProxy({
        env,
        resolved: () => resolved,
        advertisements: [narrowAd],
      });
      const res = await proxy.handleRequest(
        chatReq({
          model: "blocked-model",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "f", parameters: {} } }],
        }),
      );
      expect(res.status).toBe(400);
      // The default catalog build + capability filtering ran; the
      // credential materialization listPeers performs must not have.
      expect(reads()).toBe(0);
      expect(upstreamCalls).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(process.env, probeVar);
    }
  });

  test("the default shadow catalog consumes the published peer snapshots the legacy path uses", async () => {
    process.env["LLAMACTL_CONFIG"] = writePeerKubeconfig();
    const snapshots = new Map([
      [
        "peer1",
        {
          workloads: [{ modelId: "peer-model.gguf", port: 1, revision: "peer-rev-1" }],
          pressure: "NORMAL" as const,
          fetchedAt: Date.now(),
        },
      ],
    ]);
    // The production poller publishes the same map to both routing
    // paths — mirror that fan-out here.
    openaiProxy.setPeerSnapshots(snapshots);
    publishUnifiedPeerSnapshots(snapshots);
    const calls: string[] = [];
    try {
      const proxy = createProxy({
        env,
        resolved: () => resolved,
        resolveCredentials: () => {
          calls.push("credentials");
          return Promise.resolve();
        },
        acquireExecutor: () => {
          calls.push("acquire");
          return recordingExecutor(calls);
        },
      });
      const catalog = await proxy.shadowCatalog();
      expect(routingCatalog.catalogCandidatesFor(catalog, "peer-model.gguf")).toHaveLength(1);
      const res = await proxy.handleRequest(
        chatReq({ model: "peer-model.gguf", messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      expect(calls).toEqual(["credentials", "acquire", "execute"]);
    } finally {
      publishUnifiedPeerSnapshots(new Map());
      openaiProxy.setPeerSnapshots(new Map());
    }
  });
});

describe("shadow catalog", () => {
  test("builds from current routes with zero upstream requests and no secrets", async () => {
    const port = peer?.port;
    if (port === undefined) throw new Error("peer fixture not started");
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => resolved,
      peers: [
        {
          id: "peer1",
          endpoint: `http://127.0.0.1:${String(port)}`,
          token: "SHADOW-SECRET-TOKEN",
          certificate: "SHADOW-SECRET-CERT",
        },
      ],
      peerSnapshots: new Map([
        [
          "peer1",
          {
            workloads: [{ modelId: "peer-model.gguf", port: 1, revision: "r1" }],
            pressure: "NORMAL" as const,
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
    const catalog = await proxy.shadowCatalog();
    expect(routingCatalog.catalogCandidatesFor(catalog, "via-local/model.gguf")).toHaveLength(1);
    expect(routingCatalog.catalogCandidatesFor(catalog, "peer-model.gguf")).toHaveLength(1);
    const json = routingCatalog.serializeRouteCatalog(catalog);
    expect(json).not.toContain("SHADOW-SECRET-TOKEN");
    expect(json).not.toContain("SHADOW-SECRET-CERT");
    expect(upstreamCalls).toHaveLength(0);
    expect(peerCalls).toHaveLength(0);
  });
});
