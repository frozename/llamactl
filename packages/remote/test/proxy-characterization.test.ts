/**
 * P0.1 (#129) characterization — the POST /v1/chat/completions `via`/`rag`
 * JSON path through the real agent HTTP stack:
 *   handleRequest → bearer gate → handleRagChatCompletions → real
 *   appRouter.createCaller → chatComplete → providerForNode →
 *   createOpenAICompatProvider → a loopback Bun.serve "cloud" upstream.
 * Also pins the no-extension fallthrough to the local openaiProxy.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config as kubecfg } from "../src/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { type Cluster, makeCluster } from "./helpers.js";

interface CloudCall {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

interface ChromaCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

const ENV_KEYS = [
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
] as const;

let cluster: Cluster | undefined;
let cloud: ReturnType<typeof Bun.serve> | undefined;
let chroma: ReturnType<typeof Bun.serve> | undefined;
let cloudCalls: CloudCall[];
let chromaCalls: ChromaCall[];
let bearer: string;
let envBackup: Record<string, string | undefined> = {};
let sandbox: string | undefined;

function chatCompletions(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const agent = cluster?.nodes[0]?.agent;
  if (!agent?.handleRequest) throw new Error("handleRequest unavailable");
  return agent.handleRequest(
    new Request(`${agent.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

function writeLlamaServerWorkload(runtimeRoot: string, workload: string, port: number): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: "via-node1/model.gguf",
      extraArgs: [],
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

beforeAll(async () => {
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  sandbox = mkdtempSync(join(tmpdir(), "llamactl-proxy-char-"));
  // Hermetic globals — the in-proc pipeline reads process.env per call:
  // kubeconfig for chatComplete's provider lookup, LOCAL_AI_RUNTIME_DIR for
  // the proxy's local workload table, DEV_STORAGE for usage journals, and a
  // guaranteed-closed llama-server port for the fallback path.
  process.env["DEV_STORAGE"] = join(sandbox, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(sandbox, "runtime");
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = "1"; // nothing listens — deterministic ECONNREFUSED

  cloudCalls = [];
  cloud = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const parsed = new URL(req.url);
      let body: Record<string, unknown> | null = null;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      cloudCalls.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("authorization"),
        body,
      });
      if (req.method === "POST" && parsed.pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-cloud-1",
          object: "chat.completion",
          model: body?.["model"] ?? "cloud-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "cloud reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        });
      }
      if (req.method === "POST" && parsed.pathname === "/v1/embeddings") {
        const inputs = Array.isArray(body?.["input"]) ? body["input"].length : 1;
        return Response.json({
          object: "list",
          model: body?.["model"] ?? "embed-model",
          data: Array.from({ length: inputs }, (_, i) => ({
            object: "embedding",
            index: i,
            embedding: [0.11, 0.22, 0.33],
          })),
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      }
      return new Response("", { status: 404 });
    },
  });

  chromaCalls = [];
  chroma = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const parsed = new URL(req.url);
      let body: Record<string, unknown> | null = null;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      chromaCalls.push({ url: req.url, method: req.method, body });
      if (req.method === "GET" && parsed.pathname === "/api/v2/heartbeat") {
        return Response.json({ nanosecond: Date.now() });
      }
      if (req.method === "POST" && parsed.pathname.endsWith("/collections")) {
        return Response.json({
          id: "chroma-collection-uuid-1",
          name: body?.["name"] ?? "kb",
        });
      }
      if (req.method === "POST" && parsed.pathname.endsWith("/query")) {
        return Response.json({
          ids: [["doc-1"]],
          distances: [[0.05]],
          documents: [["llamactl is a local-first control plane for llama.cpp fleets"]],
          metadatas: [[{ source: "docs" }]],
        });
      }
      return new Response("", { status: 404 });
    },
  });

  cluster = await makeCluster({ nodes: 1 });

  // Extend the cluster kubeconfig with a gateway node pointing at the
  // loopback "cloud" — `via` then resolves through providerForNode's
  // gateway branch to providerForCloudNode.
  const cfg = kubecfg.loadConfig(cluster.clusterConfigPath);
  bearer = cfg.users.find((u) => u.name === "me")?.token ?? "";
  if (!bearer) throw new Error("cluster kubeconfig has no 'me' user token");
  let nextCfg = kubecfg.upsertNode(cfg, "home", {
    name: "fake-cloud",
    kind: "gateway",
    endpoint: "",
    cloud: {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${String(cloud.port)}`,
    },
  });
  nextCfg = kubecfg.upsertNode(nextCfg, "home", {
    name: "rag1",
    kind: "rag",
    endpoint: "",
    rag: {
      provider: "chroma",
      endpoint: `http://127.0.0.1:${String(chroma.port)}`,
      collection: "kb",
      extraArgs: [],
      embedder: {
        node: "fake-cloud",
        model: "embed-model",
        baseUrl: `http://127.0.0.1:${String(cloud.port)}`,
      },
    },
  });
  kubecfg.saveConfig(nextCfg, cluster.clusterConfigPath);
  process.env["LLAMACTL_CONFIG"] = cluster.clusterConfigPath;
});

afterAll(async () => {
  try {
    try {
      if (cluster !== undefined) await cluster.cleanup();
    } finally {
      if (cloud !== undefined) await cloud.stop(true);
      if (chroma !== undefined) await chroma.stop(true);
      if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true });
    }
  } finally {
    // Env restore must survive a failing cleanup — leaking
    // LLAMACTL_CONFIG / DEV_STORAGE / LLAMA_CPP_PORT into later test
    // files would silently reroute their kubeconfig and fallback port.
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
  }
});

describe("POST /v1/chat/completions via/rag JSON path (P0.1)", () => {
  beforeEach(() => {
    cloudCalls = [];
  });

  test("via routes through chatComplete to the gateway node's upstream", async () => {
    const res = await chatCompletions({
      model: "fake-model",
      messages: [{ role: "user", content: "hello cloud" }],
      via: "fake-cloud",
      temperature: 0.5,
      providerOptions: { user: "test-operator" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-llamactl-rag")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;

    // The OpenAI-compat adapter POSTs <baseUrl>/chat/completions with
    // stream forced off and providerOptions spread into the wire body.
    expect(cloudCalls).toHaveLength(1);
    const call = cloudCalls[0]!;
    expect(call.url).toBe(`http://127.0.0.1:${String(cloud?.port)}/v1/chat/completions`);
    expect(call.method).toBe("POST");
    expect(call.body?.["model"]).toBe("fake-model");
    expect(call.body?.["stream"]).toBe(false);
    expect(call.body?.["user"]).toBe("test-operator");
    expect(call.body?.["temperature"]).toBe(0.5);

    // chatComplete returns the upstream JSON + provider/latency fields.
    expect(body["object"]).toBe("chat.completion");
    expect(body["provider"]).toBe("fake-cloud");
    expect(typeof body["latencyMs"]).toBe("number");
    expect((body["choices"] as { message: { content: string } }[])[0]!.message.content).toBe(
      "cloud reply",
    );
  });

  // Known defect: router.ts:1256 (chatComplete) calls providerForNode
  // without a fetchFactory, so factory.ts:231 dials the agent with
  // unpinned global fetch and the kubeconfig-pinned node.certificate is
  // ignored — the TLS handshake to the agent's self-signed cert is
  // rejected before any HTTP exchange. Owning slice: P4.1 (#139).
  // Correct behavior asserted below: via:node1 reaches node1's
  // /v1/chat/completions, falls through to node1's local openaiProxy,
  // and the workload routed there (wl-via-node → the loopback "cloud")
  // answers 200.
  test.failing("via targeting an agent node reaches the agent's own /v1 surface", async () => {
    const runtimeRoot = process.env["LOCAL_AI_RUNTIME_DIR"];
    const cloudPort = cloud?.port;
    if (runtimeRoot === undefined || cloudPort === undefined)
      throw new Error("test fixture not initialized");
    writeLlamaServerWorkload(runtimeRoot, "wl-via-node", cloudPort);

    const res = await chatCompletions({
      model: "via-node1/model.gguf",
      messages: [{ role: "user", content: "hi" }],
      via: "node1",
    });
    expect(res.status).toBe(200);

    // node1's proxy forwarded verbatim to its workload upstream — proof
    // the dial actually reached the agent's /v1 surface rather than
    // being answered by an in-caller fallback.
    const chatCalls = cloudCalls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.method).toBe("POST");
    expect(chatCalls[0]!.body?.["model"]).toBe("via-node1/model.gguf");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
    expect(body["provider"]).toBe("node1");
    expect((body["choices"] as { message: { content: string } }[])[0]!.message.content).toBe(
      "cloud reply",
    );
  });

  test("rag without via returns the invalid_request_error envelope", async () => {
    const res = await chatCompletions({
      model: "fake-model",
      messages: [{ role: "user", content: "hi" }],
      rag: { node: "node1" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        message:
          "via is required — name the llamactl node to route chat through (gateway / agent / cloud)",
        type: "invalid_request_error",
      },
    });
    expect(cloudCalls).toHaveLength(0);
  });

  test("via + rag on a non-rag node returns the rag_error envelope", async () => {
    const res = await chatCompletions({
      model: "fake-model",
      messages: [{ role: "user", content: "what is llamactl?" }],
      via: "fake-cloud",
      rag: { node: "node1", topK: 2 },
    });
    // ragSearch rejects ("not a RAG node") → 502 rag_error; chatComplete
    // never runs, so the upstream sees nothing.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        message: "retrieval failed: node 'node1' is not a RAG node",
        type: "rag_error",
      },
    });
    expect(cloudCalls).toHaveLength(0);
  });

  test("a request without via/rag falls through to the local openaiProxy fallback", async () => {
    const res = await chatCompletions({
      model: "no-local-workload",
      messages: [{ role: "user", content: "hi" }],
    });
    // No local workloads in the hermetic runtime dir and LLAMA_CPP_PORT=1
    // is closed — the legacy fallback surfaces the 502 upstream envelope.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("llamactl_upstream_error");
    expect(body.error.message.startsWith("upstream llama-server unreachable:")).toBe(true);
    expect(cloudCalls).toHaveLength(0);
  });

  test("POST /v1/chat/completions without a bearer returns the 401 envelope", async () => {
    const agent = cluster?.nodes[0]?.agent;
    if (!agent?.handleRequest) throw new Error("handleRequest unavailable");
    const res = await agent.handleRequest(
      new Request(`${agent.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "invalid bearer token" },
    });
    expect(cloudCalls).toHaveLength(0);
  });

  test("via + rag on the chroma rag node retrieves, injects context first, and answers 200", async () => {
    const res = await chatCompletions({
      model: "fake-model",
      messages: [{ role: "user", content: "what is llamactl?" }],
      via: "fake-cloud",
      rag: { node: "rag1", topK: 2 },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-llamactl-rag")).toBe("retrieved=1");

    // The real ragSearch path ran end-to-end: chroma heartbeat +
    // get-or-create collection + a query carrying the embedded vector,
    // and the delegated embedder hit the cloud's /v1/embeddings.
    const heartbeat = chromaCalls.filter(
      (c) => c.method === "GET" && c.url.endsWith("/api/v2/heartbeat"),
    );
    const collectionCreate = chromaCalls.filter(
      (c) => c.method === "POST" && new URL(c.url).pathname.endsWith("/collections"),
    );
    const chromaQuery = chromaCalls.filter(
      (c) => c.method === "POST" && new URL(c.url).pathname.endsWith("/query"),
    );
    expect(heartbeat.length).toBeGreaterThanOrEqual(1);
    expect(collectionCreate).toHaveLength(1);
    expect(collectionCreate[0]!.body?.["name"]).toBe("kb");
    expect(collectionCreate[0]!.body?.["get_or_create"]).toBe(true);
    expect(chromaQuery).toHaveLength(1);
    expect(Array.isArray(chromaQuery[0]!.body?.["query_embeddings"])).toBe(true);

    const embedCalls = cloudCalls.filter((c) => c.url.endsWith("/v1/embeddings"));
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]!.body?.["model"]).toBe("embed-model");

    // The retrieved document is injected as the FIRST system message
    // before the user turn reaches the chat upstream.
    const chatCalls = cloudCalls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    const messages = chatCalls[0]!.body?.["messages"] as { role: string; content: string }[];
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain(
      "llamactl is a local-first control plane for llama.cpp fleets",
    );
    expect(messages[1]).toEqual({ role: "user", content: "what is llamactl?" });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
  });
});

// ---------------------------------------------------------------------------
// Observed current behavior — NOT a compatibility guarantee. These pin what
// the wire does TODAY for credential handling; a security review may change
// them. Keep contract assertions in the describe above.
// ---------------------------------------------------------------------------
describe("observed current behavior, not a compatibility guarantee (security review pending)", () => {
  beforeEach(() => {
    cloudCalls = [];
    chromaCalls = [];
  });

  test("the gateway adapter sends a vacuous 'Bearer' credential when apiKeyRef is unset", async () => {
    // providerForCloudNode passes apiKey:"" for a gateway with no
    // apiKeyRef and the OpenAI-compat adapter still emits the
    // `authorization` header — a header with a scheme and no token.
    const res = await chatCompletions({
      model: "fake-model",
      messages: [{ role: "user", content: "hello cloud" }],
      via: "fake-cloud",
    });
    expect(res.status).toBe(200);
    const chatCalls = cloudCalls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.authorization).toBe("Bearer");
  });
});
